/**
 * 读拒绝围栏 (工具层): 在工具派发前按会话判定目标路径是否在读拒绝范围内, 命中
 * 即拒绝; 并在搜索结果落地之后滤掉落在读拒绝范围内的条目.
 *
 * 为什么在工具层而不是 `ctx.fs` 层: 读接口 (`readText` / `streamText` / `listDir`
 * 等) 的签名里既没有 policy 也没有会话, 拿不到当前会话的工作区根与会话授权.
 * `tools/pre-execute` 的 `exec` 带 `agent.session`, 因此这一层既能按会话工作区根
 * 判定模式, 也能认 `request_writable_path` 批准过的会话授权 (一条授权同时放开
 * 该路径的读与写).
 *
 * 搜索工具 (`grep` / `glob`) 的 ripgrep 由 `ctx.subprocess` 直接拉起, 既不经过
 * `ctx.fs`, 也不经过命令沙箱, 所以只有这一层挡得住它们. 它们默认搜索整个会话
 * 工作区, 因此"请求的 scope 本身未命中"并不等于"结果里没有命中": 派发前只拦
 * scope 本身落在读拒绝范围内的调用, 结果侧再逐条滤掉读拒绝路径下的命中.
 *
 * 与写保护一致: `danger-full-access` 下不介入; 没有 policy service 时不拦.
 * @module dsh-write-protect/read-fence
 */

import { resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { isPathUnder } from './containment.ts'
import { REQUEST_WRITABLE_PATH_TOOL } from './constants.ts'
import { compileGitignore, type PatternSet } from './gitignore.ts'

export const name = 'dsh-write-protect-read-fence'

/** 会读取文件内容的工具及其携带目标路径的参数名. */
export const READ_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = {
  read: ['file_path'],
  read_image: ['file_path'],
  grep: ['path'],
  glob: ['path'],
  str_replace_editor: ['path'],
}

/** 结果里逐项带工作区相对路径的搜索工具: 工具名 -> 结果里的路径字段. */
export const SEARCH_RESULT_FIELDS: Readonly<Record<string, string>> = {
  grep: 'matches',
  glob: 'paths',
}

/**
 * 只有这些命令才算读取的工具 (其余命令是写, 由写围栏处理): 工具名 -> 读命令.
 * `str_replace_editor` 的 `view` 是读文件内容, `create` / `str_replace` / `insert`
 * 是写, 后者不该被读拒绝挡住.
 */
export const READ_ONLY_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  str_replace_editor: ['view'],
}

/** 结果值里用得到的 JSON 形态 (与引擎的 JsonValue 结构一致). */
type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike }

/** 一次判定需要的 policy 面 (与 `SandboxExecutionPolicy` 的插件扩展字段一致). */
function readDenyTextOf(policy: SandboxExecutionPolicy): string {
  const text = policy.readDenyPatterns
  return typeof text === 'string' ? text : ''
}

/** 这份 policy 上是否真的配了读拒绝 (原文或枚举清单任一非空). */
function hasReadDeny(policy: SandboxExecutionPolicy): boolean {
  return readDenyTextOf(policy).trim().length > 0 || (policy.readDenyPaths ?? []).length > 0
}

/** 每个会话解析一次 policy 的最小接口, 避免本模块直接依赖 policy service 类. */export interface ReadFencePolicy {
  /** 解析一次调用的 policy (带上调用所属会话). */
  resolve(request: { session?: NonNullable<ToolExecution['agent']>['session'] }): SandboxExecutionPolicy
}

/** 拒绝原因的构造: 说明命中的模式, 并引导模型走已有的授权通道. */
function denialReason(displayPath: string, pattern: string): string {
  return `[sandbox: read denied by dsh-write-protect] cannot read "${displayPath}": the path is read-denied (matches "${pattern}"). `
    + `Call ${REQUEST_WRITABLE_PATH_TOOL} once for that path to ask the user for a session grant; one grant covers reading and writing that path and everything under it.`
}

/**
 * 读拒绝围栏. 每个 `apply()` 建一个实例, 模式编译结果按文本缓存.
 */
export class ReadFence {
  /** 按配置文本缓存的匹配器: 文本是唯一输入, 设置改动换文本即自动失效. */
  private compiledPatterns: { text: string, set: PatternSet } | undefined

  constructor(private readonly ctx: Context) {}

  /**
   * 派发前判定: 工具读取的目标路径落在读拒绝范围内时拒绝. 先跑完其余监听器,
   * 让它们自己的拒绝 (例如别的策略插件) 优先.
   * @param exec - 本次工具调用.
   * @param next - 瀑布链的下一环.
   */
  async preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    const decision = await next()
    if (decision.kind !== 'allow') return decision
    const policy = this.policyOf(exec)
    if (policy === undefined) return decision
    const argumentsValue = exec.arguments as Record<string, unknown> | undefined
    const commands = READ_ONLY_COMMANDS[exec.name]
    if (commands !== undefined && !commands.includes(String(argumentsValue?.command ?? ''))) return decision
    for (const name of READ_TOOL_ARGS[exec.name] ?? []) {
      const value = argumentsValue?.[name]
      if (typeof value !== 'string' || value.trim().length === 0) continue
      const target = this.targetOf(exec, policy, value)
      const hit = await this.deniedPattern(policy, target)
      if (hit !== undefined) return { kind: 'deny', reason: denialReason(target, hit) }
    }
    return decision
  }

  /**
   * 结果落地后过滤: 搜索类工具的结果里逐条滤掉读拒绝路径下的条目, 其余工具
   * 原样放行. 只在确实滤掉了条目时才改写决策.
   * @param exec - 本次工具调用.
   * @param result - 派发得到的原始结果.
   * @param next - 瀑布链的下一环.
   */
  async postExecute(
    exec: ToolExecution,
    result: ToolExecutionResult,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> {
    const decision = await next()
    if (result.isError) return decision
    // 下游已经换过内容投影时不动它: 本围栏只替换结构化 value, 会把内容投影一并
    // 重新渲染, 那样会盖掉别人刚写好的文案.
    if (decision.kind === 'accept' && decision.content !== undefined) return decision
    const field = SEARCH_RESULT_FIELDS[exec.name]
    if (field === undefined) return decision
    const policy = this.policyOf(exec)
    if (policy === undefined || !hasReadDeny(policy)) return decision
    const value = valueOf(decision, result)
    if (typeof value !== 'object' || value === null) return decision
    const record = value as Record<string, unknown>
    const items = record[field]
    if (!Array.isArray(items)) return decision
    const kept: unknown[] = []
    for (const item of items) {
      const display = exec.name === 'grep' && typeof item === 'object' && item !== null
        ? (item as Record<string, unknown>).path
        : item
      if (typeof display !== 'string') {
        kept.push(item)
        continue
      }
      const target = this.targetOf(exec, policy, display)
      if (await this.deniedPattern(policy, target) === undefined) kept.push(item)
    }
    if (kept.length === items.length) return decision
    const contexts = decision.additionalContexts
    const extra = contexts === undefined || contexts.length === 0 ? {} : { additionalContexts: contexts }
    if (kept.length === 0) {
      return {
        kind: 'block',
        feedback: [{
          type: 'text',
          text: `[sandbox: read denied by dsh-write-protect] every hit of this ${exec.name} call is under a read-denied path; nothing is returned. Call ${REQUEST_WRITABLE_PATH_TOOL} once for that path to ask the user for a session grant, or search outside it.`,
        }],
        ...extra,
      }
    }
    return { kind: 'accept', value: { ...record, [field]: kept } as JsonLike, ...extra }
  }

  /** 目标是否被读拒绝, 命中时返回那条模式原文; 已批准的会话授权优先放行. */
  private async deniedPattern(policy: SandboxExecutionPolicy, target: string): Promise<string | undefined> {
    // danger-full-access 是用户显式选择的"不设限", 与写保护一致地不介入.
    if (policy.mode === 'danger-full-access') return undefined
    if (!hasReadDeny(policy)) return undefined
    const text = readDenyTextOf(policy)
    for (const grant of policy.sessionGrantPaths ?? []) {
      if (await isPathUnder(target, grant)) return undefined
    }
    return this.patternSetFor(text).match(target, policy.workspaceRoot, null)?.entry.source
  }

  /** 按文本取编译结果, 同一文本只编译一次. */
  private patternSetFor(text: string): PatternSet {
    if (this.compiledPatterns?.text === text) return this.compiledPatterns.set
    const set = compileGitignore(text)
    this.compiledPatterns = { text, set }
    return set
  }

  /**
   * 当前调用的 policy. 拿不到 policy service (极简组合 / 单测) 时返回 undefined,
   * 此时不拦任何读取.
   */
  private policyOf(exec: ToolExecution): SandboxExecutionPolicy | undefined {
    const service = this.ctx.get('sandboxPolicy') as ReadFencePolicy | undefined
    if (service === undefined || typeof service.resolve !== 'function') return undefined
    const session = exec.agent?.session
    try {
      return service.resolve(session === undefined ? {} : { session })
    } catch {
      return undefined
    }
  }

  /**
   * 把工具参数或结果里的路径解析成用于判定的绝对路径: 相对当前会话 cwd, 再解
   * 符号链接, 与 policy 的 `workspaceRoot` 同一套规范形态.
   */
  private targetOf(exec: ToolExecution, policy: SandboxExecutionPolicy, path: string): string {
    const base = exec.agent?.session.header.cwd ?? policy.workspaceRoot
    return canonicalPath(resolvePath(base, path))
  }
}

/** 后置过滤要看的 value: 下游已经换过 value 时以那份为准. */
function valueOf(decision: PostToolDecision, result: ToolExecutionResult): unknown {
  if (decision.kind === 'accept' && Object.hasOwn(decision, 'value')) return decision.value
  return result.value
}

/**
 * 注册读拒绝围栏. 组合里没有工具注册表时事件不会触发, 本插件不额外声明 inject.
 * @param ctx - 插件上下文.
 */
export function apply(ctx: Context): void {
  const fence = new ReadFence(ctx)
  ctx.on('tools/pre-execute', (exec, next) => fence.preExecute(exec, next))
  ctx.on('tools/post-execute', (exec, result, next) => fence.postExecute(exec, result, next))
}

export default apply

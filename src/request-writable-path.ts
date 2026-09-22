/**
 * 模型侧的可写申请: `request_writable_path` 工具与服务端的内存态授权表.
 *
 * 模型在这种情形下需要它:
 *   - 想写到工作区外的某个目录 (与设置页 "额外可写根" 同一条通道), 或
 *   - 想写工作区里被保护路径挡住的某段路径 (设置页声明的条目或工作区规则文件
 *     命中的条目). 典型用法是把规则文件或设置页当成"整体只读 + 逐项申请":
 *     例如规则文件里一行 `.` 保护整个工作区, 模型再对需要写的子目录逐个申请.
 *
 * 授权只在用户于审批弹窗里同意之后写入, 只存在于本进程内存, 只对本会话有效:
 * 进程重启即消失, 不写 settings, 不落盘. 弹窗的 reason 会写明这次是在放开哪条
 * 保护, 用户看到的就是自己正在放宽什么; 唯一的例外是工作区只读规则文件本身 ——
 * 它自己就是规则来源, 任何申请都不受理.
 *
 * 两类授权落到 policy 上的通道不同:
 *   - `extra-root`: 并进 `writablePaths`, 与设置页的额外可写根等价, 命令沙箱的
 *     allow-list 叠加也会带上它.
 *   - `override`: 只进 `writableOverrides`, 供 write / edit 围栏旁路保护路径判定.
 *     命令侧的 ro-bind / Seatbelt deny 在命令启动前就定好, 运行期撤不掉, 因此
 *     授权不会收窄它; 这一点写在工具结果里, 让模型知道该怎么办.
 * @module dsh-write-protect/request-writable-path
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import { isPathUnder } from './containment.ts'
import { REQUEST_WRITABLE_PATH_TOOL, type GrantKind } from './constants.ts'
import { resolveLiteralPath } from './patterns.ts'

/** 一条已批准的可写授权. */
export interface Grant {
  readonly path: string
  readonly kind: GrantKind
}

/** 一个会话的授权记录. */
export interface GrantRecord {
  readonly extraRoots: readonly string[]
  readonly overrides: readonly string[]
  readonly grants: readonly Grant[]
}

const EMPTY_RECORD: GrantRecord = { extraRoots: [], overrides: [], grants: [] }

/** `GrantsService.grant()` 的结果. */
export type GrantOutcome =
  | { readonly ok: true, readonly record: GrantRecord, readonly kind: GrantKind }
  | { readonly ok: false, readonly reason: string }

/**
 * 工具执行上下文里用到的会话形状 (只用到 id 与 header.cwd). `ToolRunContext` 上的
 * `agent` 由 agent loop 注入, 这里按结构取用; 交给官方审批服务时仍用 `exec.agent`
 * 本身 (官方 `Agent` 类型), 不从这份结构里转.
 */
interface ToolAgent {
  readonly session: { readonly id: string, readonly header?: { readonly cwd?: string } }
}

/** policy service 提供给本模块的最小接口 (避免模块间直接持类). */
export interface GrantPolicyHost {
  /**
   * 会话的工作区根: 已记住的那份, 或调用方给的 cwd. 两者都没有时为 undefined ——
   * 这条通道不回退部署根, 因此工具必须把它当成"判不了"而不是"没有保护".
   * @param sessionId - 调用所属会话.
   * @param cwd - 会话日志里的 cwd, 供会话尚未被 resolve 过时定位工作区根.
   */
  workspaceRootOfSession(sessionId: string, cwd?: string): string | undefined
  /**
   * 解析一次调用的 policy. 授权按会话 id 生效, 与 policy service 内部读会话的
   * 方式一致, 因此这里传 id 而不是会话对象.
   * @param sessionId - 调用所属会话, 缺省表示无会话调用.
   * @param cwd - 会话日志里的 cwd, 供会话尚未被 resolve 过时定位工作区根; 不给且
   *   该会话也没被记住时保护清单为空 (不回退部署根).
   */
  resolve(sessionId?: string, cwd?: string): SandboxExecutionPolicy
  /** 当前生效的保护路径展开形态 (设置页文本与规则文件合并后). */
  currentProtectedPaths(sessionId?: string, cwd?: string): readonly string[]
  /** 单会话授权上限. */
  maxGrants(): number
  /** 当前工作区根的只读规则文件路径 (文件名关闭时为 undefined). */
  rulesFilePath(workspaceRoot: string): string | undefined
  /**
   * 本部署是否允许模型申请可写路径 (设置项 `allowWritableRequests`). 每次调用
   * 时读取, 因此设置页关掉后立刻生效; 关掉时工具仍注册 (schema 稳定), 但任何
   * 调用都会被拒.
   */
  allowRequests(): boolean
}

/**
 * 会话级可写授权表. 键为会话 id; 会话结束后记录随 map 一起失效 (进程内存态).
 */
export class GrantsService {
  private readonly records = new Map<string, GrantRecord>()

  constructor(
    private readonly maxGrants: () => number,
    private readonly onChange: () => void,
  ) {}

  /** 某个会话的授权记录 (没有记录时返回空记录). */
  recordOf(sessionId: string): GrantRecord {
    return this.records.get(sessionId) ?? EMPTY_RECORD
  }

  /**
   * 记录一条授权. 已存在同一路径时视为成功且不重复计数.
   * @param sessionId - 授权所属会话.
   * @param path - canonical 绝对路径.
   * @param kind - 工作区外的额外根 (`extra-root`) 或保护旁路 (`override`).
   */
  grant(sessionId: string, path: string, kind: GrantKind): GrantOutcome {
    const current = this.recordOf(sessionId)
    const existing = current.grants.find(grant => grant.path === path)
    if (existing !== undefined) {
      return { ok: true, record: current, kind: existing.kind }
    }
    const limit = this.maxGrants()
    if (current.grants.length >= limit) {
      return {
        ok: false,
        reason: `this session already holds the maximum of ${String(limit)} extra write grants; ask the user to raise the limit or write inside the workspace`,
      }
    }
    const extraRoots = kind === 'extra-root' ? [...current.extraRoots, path] : current.extraRoots
    const overrides = kind === 'override' ? [...current.overrides, path] : current.overrides
    const record: GrantRecord = { extraRoots, overrides, grants: [...current.grants, { path, kind }] }
    this.records.set(sessionId, record)
    this.onChange()
    return { ok: true, record, kind }
  }

  /** 按工作区根查找已授权的会话记录 (设置页预览用: 请求体只带 cwd). */
  recordsForWorkspace(workspaceRoot: string, cwdOf: (sessionId: string) => string | undefined): readonly Grant[] {
    const canonicalRoot = canonicalPath(workspaceRoot)
    const found: Grant[] = []
    for (const [sessionId, record] of this.records) {
      if (canonicalPath(cwdOf(sessionId) ?? '') !== canonicalRoot) continue
      found.push(...record.grants)
    }
    return found
  }
}

/** 审批通道的最小结构视图 (官方 `ctx.approval` 的形状子集). */
interface ApprovalChannel {
  request(request: {
    agent: unknown
    toolName: string
    callId: string
    reason: string
    signal: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
  overrideOf(session: unknown): 'ask' | 'never' | undefined
  config: { policy?: 'ask' | 'never' }
}

/** 工具结果 (与 output schema 一致). */
interface RequestResult {
  path: string
  granted: boolean
  kind: 'already-writable' | 'extra-root' | 'override'
  scope: 'session'
  notes: string[]
}

function renderResult(result: RequestResult): string {
  const head = result.granted
    ? result.kind === 'already-writable'
      ? `"${result.path}" is already writable in this session.`
      : `Write access to "${result.path}" was granted for this session (${result.kind}).`
    : `Write access to "${result.path}" was not granted.`
  return [head, ...result.notes].join(' ')
}

/**
 * 注册 `request_writable_path`. 只在组合里有 `ctx.tools` 时调用.
 * @param ctx - Host 上下文 (会用到 `ctx.approval`).
 * @param grants - 授权表.
 * @param host - policy service 的最小接口.
 */
export function registerRequestWritablePath(ctx: Context, grants: GrantsService, host: GrantPolicyHost): void {
  ctx.tools.register(defineTool({
    name: REQUEST_WRITABLE_PATH_TOOL,
    description: 'Ask the user to grant write access to one path for this session, for work that will keep writing the same protected path '
      + 'or area (a directory of files to generate, a build output tree, a path outside the workspace that several writes depend on). '
      + 'A single file is written with the ordinary write/edit tools. The user decides in an approval prompt, and a granted path stays '
      + 'writable only until the session ends.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'The path that needs write access: absolute, //-prefixed, ~/..., or relative to the session workspace (.. allowed). No globs.',
      },
      justification: {
        type: 'string',
        required: true,
        description: 'One sentence for the user explaining why this exact path needs write access.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          granted: { type: 'boolean', required: true },
          kind: {
            type: 'string',
            required: true,
            enum: ['already-writable', 'extra-root', 'override'],
          },
          scope: { type: 'string', required: true, enum: ['session'] },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderResult(value as unknown as RequestResult) }],
    },
    async execute(args, exec) {
      return await handleRequest(ctx, grants, host, args.path, args.justification, exec)
    },
  }))
}

/**
 * 一次申请的判定与执行. 单独导出是为了让测试不必经过工具注册表就能覆盖判定
 * 分支 (参数校验在上面那条 schema 里).
 * @param ctx - Host 上下文 (会用到 `ctx.approval`).
 * @param grants - 授权表.
 * @param host - policy service 的最小接口.
 * @param rawPath - 模型给出的路径原文.
 * @param justification - 模型给出的一句话理由.
 * @param exec - 工具执行上下文 (取其中的 agent / callId / signal).
 */
export async function handleRequest(
  ctx: Context,
  grants: GrantsService,
  host: GrantPolicyHost,
  rawPath: string,
  justification: string,
  exec: ToolRunContext,
): Promise<RequestResult> {
  if (!host.allowRequests()) {
    throw new Error('request_writable_path is disabled by this deployment (allowWritableRequests); treat denied writes as final')
  }
  if (justification.trim().length === 0) throw new Error('justification must be a non-empty sentence')
  return await requestAccess(ctx, grants, host, rawPath, justification, exec)
}

/** 一次申请的完整判定流程: 解析 → 直通 → 硬保护 → 审批 → 记录. */
async function requestAccess(
  ctx: Context,
  grants: GrantsService,
  host: GrantPolicyHost,
  rawPath: string,
  justification: string,
  exec: ToolRunContext,
): Promise<RequestResult> {
  const agent = (exec as ToolRunContext & { agent?: ToolAgent }).agent
  const sessionId = agent?.session.id
  if (sessionId === undefined) throw new Error('request_writable_path needs a session to attach the grant to')
  // 会话 cwd 一起交给 policy: 会话还没被 resolve 过时靠它定位工作区根. 两处都不
  // 提供根时按"判不了"处理, 不回退部署根 (那可能是一次几十秒的同步扫盘).
  const sessionCwd = agent?.session.header?.cwd
  const workspaceRoot = host.workspaceRootOfSession(sessionId, sessionCwd)
  if (workspaceRoot === undefined) {
    throw new Error(`request_writable_path cannot judge write protection: session "${sessionId}" has no workspace root (its log has no cwd and no earlier policy resolution recorded one); do not retry this tool for this session`)
  }
  const policy = host.resolve(sessionId, sessionCwd)

  // 只读规则文件本身不接受申请: 它自己就是规则来源, 放宽它等于让写入方改写规则.
  // 用户要改规则就改设置页的文件名, 或者在 DSH 之外编辑那份文件.
  const rulesFile = host.rulesFilePath(workspaceRoot)
  if (rulesFile !== undefined && canonicalPath(rawPath) === rulesFile) {
    throw new Error(`request_writable_path rejected: "${rawPath}" is the workspace write-protect rules file, which is read-only by design and cannot be granted`)
  }

  // 目标路径按"额外可写根那套字面路径规则"解析: 相对条目先相对会话工作区根定死,
  // 再 canonical 化; 工作区内的条目照样给出路径 (这里恰恰要受理它们), 只有其余
  // 行级告警 (通配符, 盘符相对路径, 文件系统根) 才直接拒绝. 不能直接用
  // canonicalPath(rawPath): 相对且不存在的路径会原样返回相对形态, 于是工作区内的
  // 申请被误判成工作区外 (审批文案说错), 批准后记下的相对授权在下一次展开时又落回
  // 工作区内被丢弃, 等于批了也不生效.
  const resolution = resolveLiteralPath(rawPath, workspaceRoot)
  const blocking = resolution.warnings.filter(warning => !warning.includes('already inside the workspace'))
  if (blocking.length > 0) throw new Error(`request_writable_path rejected: ${blocking[0]!}`)
  if (resolution.path === undefined) {
    throw new Error(`request_writable_path rejected: "${rawPath}" has no target path; give an absolute path, or one relative to the session workspace`)
  }
  const target = resolution.path

  // 工作区内的路径: 判定它是否落在当前生效的保护路径之下. 设置页文本与规则文件
  // 都只是"当前的保护范围", 不构成不可申请的白名单: 用户可以整段保护工作区
  // (例如规则文件里一行 `.`), 再让模型逐个目录来申请. 这一步必须排在 allow-list
  // 直通之前 —— 工作区本身就在 allow-list 里, 先看 allow-list 会把受保护的内部
  // 路径当成"本来就可写".
  if (await isPathUnder(target, workspaceRoot)) {
    // 先前批准过的授权 (含工作区外的额外根与工作区内的保护旁路) 已经覆盖目标时
    // 直接放行: 授权是路径级的, 父目录批过一次, 下面的每个子路径都不必再申请.
    for (const root of [...(policy.writablePaths ?? []), ...(policy.writableOverrides ?? [])]) {
      if (await isPathUnder(target, root)) {
        return {
          path: target,
          granted: true,
          kind: 'already-writable',
          scope: 'session',
          notes: [`already covered by the session grant on "${root}"; one grant covers everything under it, so do not ask again for this path.`],
        }
      }
    }
    const hit = await protectedBy(target, host.currentProtectedPaths(sessionId, sessionCwd))
    if (hit === undefined) {
      return {
        path: target,
        granted: true,
        kind: 'already-writable',
        scope: 'session',
        notes: ['already writable in this session; no write-protect pattern matches it.'],
      }
    }
    return await askApproval(ctx, grants, policy, sessionId, target, 'override', hit, justification, exec)
  }

  // 工作区外的路径: 已经在 allow-list 里 (平台临时区, 设置页声明的额外根, 或本
  // 会话先前批准过的根) 就不需要审批, 直接说明为什么可写.
  for (const root of [...writableRoots(policy), ...(policy.writablePaths ?? [])]) {
    if (await isPathUnder(target, root)) {
      return {
        path: target,
        granted: true,
        kind: 'already-writable',
        scope: 'session',
        notes: [`already inside the writable root "${root}"; one grant covers everything under it, so do not ask again for this path.`],
      }
    }
  }

  return await askApproval(ctx, grants, policy, sessionId, target, 'extra-root', undefined, justification, exec)
}

/**
 * 目标是否落在某一保护路径之下, 命中时返回命中的那条配置行 (未命中原样返回).
 * 展开出来的保护路径与围栏消费的是同一份清单, 因此通配条目、目录标记与规则
 * 文件的条目都算数.
 */
async function protectedBy(target: string, protectedPaths: readonly string[]): Promise<string | undefined> {
  for (const path of protectedPaths) {
    if (await isPathUnder(target, path)) return path
  }
  return undefined
}

/** 走一次审批弹窗, 同意后记录授权. */
async function askApproval(
  ctx: Context,
  grants: GrantsService,
  policy: SandboxExecutionPolicy,
  sessionId: string,
  target: string,
  kind: GrantKind,
  matchedPattern: string | undefined,
  justification: string,
  exec: ToolRunContext,
): Promise<RequestResult> {
  const approval = ctx.get('approval') as ApprovalChannel | undefined
  const agent = exec.agent
  if (approval === undefined) {
    throw new Error(`write access to "${target}" requires user approval, but no approval service is composed in this deployment`)
  }
  if (agent === undefined) {
    throw new Error(`write access to "${target}" requires user approval, but the call has no agent to route it through`)
  }
  const effective = approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask'
  if (effective === 'never') {
    throw new Error(`write access to "${target}" requires user approval, but approval prompts are disabled in this session`)
  }
  const seeking = kind === 'override'
    ? `grant write access to "${target}" for this session, overriding write protection on "${matchedPattern ?? ''}"`
    : `grant write access to "${target}" (outside the session workspace) for this session`
  const outcome = await approval.request({
    agent,
    toolName: REQUEST_WRITABLE_PATH_TOOL,
    callId: exec.callId,
    reason: `${seeking}: ${justification}`,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(describeDenial(outcome, target))
  }
  const granted = grants.grant(sessionId, target, kind)
  if (!granted.ok) throw new Error(`write access to "${target}" could not be granted: ${granted.reason}`)
  const notes = kind === 'override'
    ? [
      `write protection on "${matchedPattern ?? ''}" is bypassed for the write/edit tools and for sandboxed commands under "${target}".`,
      'the grant already covers every path beneath it, so do not ask again for a subdirectory or another file in there while it lasts.',
    ]
    : [
      `"${target}" joined the writable roots for this session, so sandboxed commands and the write/edit tools may write there.`,
      'the grant already covers every path beneath it, so do not ask again for a subdirectory or another file in there while it lasts.',
      'write-protect patterns still win inside it.',
    ]
  if (policy.mode === 'read-only') {
    notes.push('the session is in read-only mode right now, so this grant takes effect only after the mode is switched to workspace-write or danger-full-access.')
  }
  return { path: target, granted: true, kind, scope: 'session', notes }
}

/** 未获同意的三种结果各自的说明, 让模型能区分"用户拒绝"和"没有审批通道". */
function describeDenial(outcome: 'rejected' | 'cancelled' | 'unavailable', target: string): string {
  switch (outcome) {
    case 'rejected': return `the user rejected write access to "${target}"`
    case 'cancelled': return `the request for write access to "${target}" was cancelled`
    case 'unavailable': return `write access to "${target}" requires approval, but no approval channel is available`
  }
}

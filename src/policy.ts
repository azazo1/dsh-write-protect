/**
 * 替换 base 的 `sandbox-policy` 行: 在官方 `SandboxPolicyService` 之上增加
 * `readOnlyPaths` 与 `writablePaths`. 保护路径以 gitignore 语义的多行文本
 * 声明, 额外可写根是字面路径列表 (见 `patterns.ts`). 来源按优先级取值:
 * Web 设置页编辑过的用户配置覆盖 patch 数组 (部署 base). 解析结果带 TTL
 * 缓存, 每次 resolve() 注入逐次调用的 policy, 作为 fs 围栏与进程沙箱
 * provider 共同消费的单一事实来源; 同时注册一个 systemPrompt context,
 * 让模型在写入之前就知道哪些路径受保护, 哪些额外根可写.
 * @module dsh-write-protect/policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DEFAULT_HARDEN_BROKER, DEFAULT_READ_ONLY_PATHS, DEFAULT_WRITABLE_PATHS, EXPAND_FULL_TTL_MS, HARDEN_BROKER_FIELD, PATTERNS_FIELD, PLUGIN_ID, PROMPT_CONTEXT_ORDER, WRITABLE_FIELD } from './constants.ts'
import { expandReadOnlyPaths, expandReadOnlyPathsAsync, expandWritablePaths } from './patterns.ts'
import { parsePatternLines } from './gitignore.ts'
import { mountPreviewRoute, type PreviewConnection } from './preview-route.ts'

export const name = 'dsh-write-protect-policy'

/** 插件配置: 官方 policy 的部署字段原样保留, 外加保护路径与额外可写根部署 base. */
export interface Config {
  /** 会话启动时的文件沙箱模式 (缺省 `read-only`, 与官方一致). */
  mode?: SandboxMode
  /** 无会话调用与会话没有 cwd 时的回退工作区根 (缺省 `process.cwd()`). */
  workspaceRoot?: string
  /**
   * 受保护路径部署 base: 每项一行 gitignore 语义模式, 数组逐行合并为生效文本.
   * 不含 `/` 的条目任意层级匹配, 含开头或中间 `/` 的条目锚定工作区根,
   * `//` 开头为文件系统绝对路径; `!` 按 last-match-wins 取反.
   * 用户在 Web 设置页保存过 patterns 文本后该数组不再生效.
   */
  readOnlyPaths?: string[]
  /**
   * 额外可写根部署 base: 每项一行字面路径, 数组逐行合并为生效文本.
   * 行首 `~` / `~/...` 为当前用户家目录, `$NAME` / `${NAME}` 为环境变量;
   * `//` 或宿主绝对路径按文件系统解析, 其余相对当前工作区 (含 `..`).
   * 只在 `workspace-write` 下并进 allow-list, 不打穿 `read-only`;
   * 保护路径优先. 用户保存过 writablePatterns 文本后该数组不再生效.
   */
  writablePaths?: string[]
  /**
   * macOS Seatbelt broker 逃逸加固的部署 base, 缺省开启 (见
   * `DEFAULT_HARDEN_BROKER`). 用户在设置页拨动开关后该值不再生效.
   */
  hardenBroker?: boolean
}

/** 展开结果的缓存有效时长: resolve 每个 tool call 都会调用, glob 枚举有 IO 成本. */
const EXPAND_TTL_MS = 5000

/** 缓存条目按状态取 TTL: 部分结果短 TTL, 完整 / 已放弃补全的结果长 TTL. */
function ttlOf(status: 'partial' | 'complete' | 'exhausted'): number {
  return status === 'partial' ? EXPAND_TTL_MS : EXPAND_FULL_TTL_MS
}

/**
 * 同一份配置 / 工作区根两次展开结果的并集 (保序去重). 去留由同一条
 * last-match-wins 谓词决定, 两次展开的差异只在"访问到哪些候选", 因此并集
 * 不会把被取反剔除的路径重新纳入; 反过来它能保证"已经发现的深层匹配"不被
 * 后续更差的同步部分结果覆盖掉.
 */
function mergePaths(previous: readonly string[] | undefined, next: readonly string[]): readonly string[] {
  if (previous === undefined || previous.length === 0) return next
  if (next.length === 0) return previous
  const merged: string[] = [...previous]
  const seen = new Set(previous)
  for (const path of next) {
    if (seen.has(path)) continue
    seen.add(path)
    merged.push(path)
  }
  return merged
}

export class WriteProtectPolicyService extends SandboxPolicyService {
  // 内联 schema 调用: config catalog 会静态遍历 `static Config`.
  static Config = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    workspaceRoot: z.string(),
    readOnlyPaths: z.array(z.string()).default([...DEFAULT_READ_ONLY_PATHS]),
    writablePaths: z.array(z.string()).default([...DEFAULT_WRITABLE_PATHS]),
    hardenBroker: z.boolean().default(DEFAULT_HARDEN_BROKER),
  })

  private readonly baseEntries: readonly string[]
  private readonly writableBaseEntries: readonly string[]
  private readonly hardenBrokerBase: boolean
  private settingsOwner: SettingsScope<WriteProtectSettings> | undefined
  /**
   * 每个 (两份文本, 工作区根) 的展开结果. 结果只增不减: 同步展开是被预算
   * 截断的浅层子集, 后台补全的完整结果按并集合并进来. 合并是安全的 ——
   * 去留由同一条 last-match-wins 谓词决定, 两次展开的差异只在"访问到哪些
   * 候选", 所以并集不会重新放行被取反剔除的路径; 反过来, 也不能用更差的
   * 同步部分结果覆盖已经拿到的完整结果, 否则保护范围会在两个值之间反复跳.
   *
   * `status` 决定重算节奏: `partial` 走短 TTL (同步遍历有界, 重算便宜, 能尽快
   * 纳入新建路径); `complete` 与 `exhausted` 走长 TTL —— 后者表示后台补全
   * 也到顶了, 对同一个根不再做无望的全量扫描.
   */
  private readonly expanded = new Map<string, {
    at: number
    readOnly: readonly string[]
    writable: readonly string[]
    status: 'partial' | 'complete' | 'exhausted'
  }>()
  /** 上一次后台补全结束的时间, 用于限制后台全量补全的启动频率. */
  private fullExpandedAt = 0
  /** 后台补全的在飞标记; 配置 / 工作区根变化时靠 generation 丢弃过期结果. */
  private fullRefresh: { key: string, generation: number } | undefined
  /** 已判定"超出异步补全预算"的工作区根: 不再反复做无望的全量扫描. */
  private readonly exhaustedRoots = new Set<string>()
  private generation = 0
  private disposed = false
  private readonly warned = new Set<string>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const entries = config.readOnlyPaths ?? []
    const writableEntries = config.writablePaths ?? []
    for (const entry of entries) {
      if (entry.trim().length === 0) {
        throw new Error('dsh-write-protect: readOnlyPaths entries must be non-empty strings')
      }
    }
    for (const entry of writableEntries) {
      if (entry.trim().length === 0) {
        throw new Error('dsh-write-protect: writablePaths entries must be non-empty strings')
      }
    }
    this.baseEntries = entries
    this.writableBaseEntries = writableEntries
    this.hardenBrokerBase = config.hardenBroker ?? DEFAULT_HARDEN_BROKER

    // 服务释放后停掉在飞的后台展开, 不让它继续占用事件循环.
    ctx.effect(() => () => {
      this.disposed = true
      this.generation += 1
      this.fullRefresh = undefined
    }, 'dsh-write-protect: stop background expansion')

    // Web 设置页的持久化配置: composition base 是 patch 的数组与开关, 用户保存过
    // 的值覆盖对应字段; 编辑后缓存失效实时生效.
    ctx.inject(['settings'], (scope: Context) => {
      const owner = scope.settings.register(PLUGIN_ID, WriteProtectSettingsSchema, {
        base: {
          [PATTERNS_FIELD]: this.baseText(),
          [WRITABLE_FIELD]: this.writableBaseText(),
          [HARDEN_BROKER_FIELD]: this.hardenBrokerBase,
        },
      })
      this.settingsOwner = owner
      owner.watch(() => {
        // generation 递增让在飞的后台补全作废; 新文本的根需要重新评估.
        this.generation += 1
        this.fullRefresh = undefined
        this.exhaustedRoots.clear()
        this.expanded.clear()
      })
    })

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:write-protect',
        order: PROMPT_CONTEXT_ORDER,
        text: (context) => {
          // rc.1 的 AssembleContext 声明尚未包含 agent, 运行时与官方
          // sandbox-policy 一致地携带会话; resolve 参数类型反推 session 形状.
          const session = (context as {
            agent?: { session?: NonNullable<Parameters<SandboxPolicyService['resolve']>[0]>['session'] }
          }).agent?.session
          if (session === undefined) return ''
          const { readOnly, writable, patterns, truncated } = this.snapshot(this.resolve({ session }).workspaceRoot)
          const parts: string[] = []
          if (!truncated && readOnly.length > 0) {
            // 枚举完整时列具体路径最省事, 与 write/edit 的实际围栏一致.
            parts.push(`Write-protected paths (all DSH-enforced operations deny writes beneath them; reads stay allowed): ${JSON.stringify(readOnly)}.`)
          } else if (truncated) {
            // 枚举被预算截断: write/edit 按模式拦全部匹配, 命令侧只钉住了浅层路径,
            // 两者不一致必须说清楚, 否则模型会以为深层匹配不受保护.
            const sources = parsePatternLines(patterns).map(entry => `${entry.negated ? '!' : ''}${entry.source}`)
            parts.push(`Write-protected patterns (gitignore semantics; the write/edit tools deny every matching path, reads stay allowed): ${JSON.stringify(sources)}. Sandboxed commands additionally pin these resolved locations: ${JSON.stringify(readOnly)} — incomplete, only the shallowest matches could be enumerated; deeper matches stay write-protected for the tools but are not pinned for commands, so use anchored entries such as "/.git" if commands must be blocked there too.`)
          }
          if (writable.length > 0) {
            parts.push(`Additional writable roots under workspace-write (sandboxed commands and write/edit tools may write here; write-protected paths still win; does not apply in read-only): ${JSON.stringify(writable)}.`)
          }
          return parts.join(' ')
        },
      })
    })

    ctx.inject(['connection'], (scope: Context) => {
      const connection = (scope as Context & { connection: PreviewConnection }).connection
      // 部署回退根: 请求体没带当前会话 cwd 时才用.
      scope.effect(
        () => mountPreviewRoute(connection, this.workspaceRoot),
        'dsh-write-protect: preview route',
      )
    })
  }

  /** 部署 base 的保护路径文本形态 (patch 数组逐行合并). */
  private baseText(): string {
    return this.baseEntries.join('\n')
  }

  /** 部署 base 的额外可写根文本形态 (patch 数组逐行合并). */
  private writableBaseText(): string {
    return this.writableBaseEntries.join('\n')
  }

  /** 当前生效的保护路径文本: 用户在设置页保存过的 patterns 覆盖部署 base. */
  private currentText(): string {
    const value = this.settingsOwner?.get()?.[PATTERNS_FIELD]
    return typeof value === 'string' ? value : this.baseText()
  }

  /** 当前生效的额外可写文本: 用户保存过的 writablePatterns 覆盖部署 base. */
  private currentWritableText(): string {
    const value = this.settingsOwner?.get()?.[WRITABLE_FIELD]
    return typeof value === 'string' ? value : this.writableBaseText()
  }

  /** 当前生效的 broker 加固开关: 用户拨动过设置页开关则以其为准, 否则走部署 base. */
  private currentHardenBroker(): boolean {
    const value = this.settingsOwner?.get()?.[HARDEN_BROKER_FIELD]
    return typeof value === 'boolean' ? value : this.hardenBrokerBase
  }

  /** 逐条告警, 同一文本只出现一次. */
  private warnAll(warnings: readonly string[]): void {
    for (const warning of warnings) {
      if (this.warned.has(warning)) continue
      this.warned.add(warning)
      this.ctx.logger?.warn?.(`dsh-write-protect: ${warning}`)
    }
  }

  /**
   * 展开当前生效文本为 canonical 保护路径与额外可写根, 按
   * (两份文本, 工作区根) 缓存; 同时给出生效的保护路径**原文** (fs 围栏按它逐条
   * 匹配, 不依赖枚举) 与枚举是否被截断.
   *
   * 同步展开有队列项与墙钟双重上限 (`resolve()` 是同步契约, 不能阻塞 Host
   * 事件循环): 结果被截断时先返回已找到的浅层匹配并告警, 同时把该根交给
   * {@link expandInBackground} 在后台按分片补齐, 补齐结果与已有结果取并集.
   * 完整结果只覆盖不丢失: 更差的同步部分结果不会把已拿到的深层匹配置换掉.
   */
  private snapshot(workspaceRoot: string): {
    readOnly: readonly string[]
    writable: readonly string[]
    patterns: string
    truncated: boolean
  } {
    const readOnlyText = this.currentText()
    const writableText = this.currentWritableText()
    const key = `${readOnlyText}\u0000${writableText}\u0000${workspaceRoot}`
    const now = Date.now()
    const previous = this.expanded.get(key)
    if (previous !== undefined && now - previous.at < ttlOf(previous.status)) {
      return {
        readOnly: previous.readOnly,
        writable: previous.writable,
        patterns: readOnlyText,
        truncated: previous.status !== 'complete',
      }
    }
    const readOnly = expandReadOnlyPaths(readOnlyText, workspaceRoot)
    const writable = expandWritablePaths(writableText, workspaceRoot)
    this.warnAll([...readOnly.warnings, ...writable.warnings])
    const truncated = readOnly.truncated === true
    const status = !truncated
      ? 'complete'
      : previous === undefined || previous.status === 'partial' ? 'partial' : previous.status
    const next = {
      at: now,
      readOnly: mergePaths(previous?.readOnly, readOnly.paths),
      writable: writable.paths,
      status,
    } as const
    this.expanded.set(key, next)
    if (truncated) this.expandInBackground(key, readOnlyText, workspaceRoot, writable.paths)
    return { readOnly: next.readOnly, writable: next.writable, patterns: readOnlyText, truncated: status !== 'complete' }
  }

  /**
   * 后台把被同步预算截断的根补齐: 同一时刻只跑一个 (全量遍历很贵), 且启动
   * 间隔不小于 {@link EXPAND_FULL_TTL_MS}. 补全结果与既有结果取并集后写回;
   * 到顶仍不完整 (家目录级工作区) 则记为该根已放弃, 只保留告警给出的"改用
   * 锚定条目"建议. 结果经 generation 校验, 服务释放或配置变化时直接丢弃.
   */
  private expandInBackground(
    key: string,
    readOnlyText: string,
    workspaceRoot: string,
    writable: readonly string[],
  ): void {
    if (this.disposed || this.fullRefresh !== undefined) return
    if (this.exhaustedRoots.has(workspaceRoot)) return
    if (Date.now() - this.fullExpandedAt < EXPAND_FULL_TTL_MS) return
    const generation = this.generation
    this.fullRefresh = { key, generation }
    void expandReadOnlyPathsAsync(readOnlyText, workspaceRoot, {
      shouldStop: () => this.disposed || this.generation !== generation,
    }).then((result) => {
      this.fullRefresh = undefined
      this.fullExpandedAt = Date.now()
      if (this.disposed || this.generation !== generation) return
      this.warnAll(result.warnings)
      if (result.truncated === true) this.exhaustedRoots.add(workspaceRoot)
      const previous = this.expanded.get(key)
      this.expanded.set(key, {
        at: Date.now(),
        readOnly: mergePaths(previous?.readOnly, result.paths),
        writable: previous?.writable ?? writable,
        status: result.truncated === true ? 'exhausted' : 'complete',
      })
    }, (error: unknown) => {
      this.fullRefresh = undefined
      this.fullExpandedAt = Date.now()
      this.ctx.logger?.warn?.(`dsh-write-protect: background expansion failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
   * 追加注入保护路径 (枚举形态给进程沙箱, 原文给 write/edit 围栏), 额外可写根
   * 与 broker 加固开关.
   * @param request - 可选的会话与已批准的模式覆盖.
   * @returns 带有 `readOnlyPatterns` / `readOnlyPaths` / `writablePaths` /
   * `hardenBroker` 的完整逐次调用 policy.
   */
  override resolve(request: Parameters<SandboxPolicyService['resolve']>[0] = {}): SandboxExecutionPolicy {
    const policy = super.resolve(request)
    const { readOnly, writable, patterns } = this.snapshot(policy.workspaceRoot)
    policy.readOnlyPatterns = patterns
    policy.readOnlyPaths = readOnly
    policy.writablePaths = writable
    policy.hardenBroker = this.currentHardenBroker()
    return policy
  }
}

/**
 * settings namespace 的字段集合: 两份多行文本与一个开关, 未编辑时走 base.
 * 与 `WriteProtectSettingsSchema` 的键保持一致.
 */
type WriteProtectSettings =
  & Record<typeof PATTERNS_FIELD, string>
  & Record<typeof WRITABLE_FIELD, string>
  & Record<typeof HARDEN_BROKER_FIELD, boolean>

/** settings namespace 的 schema: 两份多行文本加 broker 加固开关. */
const WriteProtectSettingsSchema = z.object({
  [PATTERNS_FIELD]: z.string(),
  [WRITABLE_FIELD]: z.string(),
  [HARDEN_BROKER_FIELD]: z.boolean(),
})

export default WriteProtectPolicyService

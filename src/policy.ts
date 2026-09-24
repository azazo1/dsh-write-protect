/**
 * 替换 base 的 `sandbox-policy` 行: 在官方 `SandboxPolicyService` 之上增加
 * `readOnlyPaths` 与 `writablePaths`. 保护路径以 gitignore 语义的多行文本
 * 声明, 额外可写根是字面路径列表 (见 `patterns.ts`). 来源按优先级取值:
 * Web 设置页编辑过的用户配置覆盖 patch 数组 (部署 base).
 *
 * 生效的保护路径文本是两份来源的合并: 设置页文本在前, 工作区只读规则文件
 * (默认 `.readonly`, 见 `readonly-file.ts`) 在后. 规则文件按工作区根各一份,
 * 由 `ReadOnlyFileCache` 读取 (自身带短 TTL), 因此 `resolve()` 保持同步契约.
 *
 * 枚举展开是昂贵的扫盘, 不在 `resolve()` 里做: 那里只注入合并后的模式原文,
 * 缓存里已有的展开清单, 与本会话授权. 命令沙箱走异步的 `materialize()`, 设置页
 * 预览走异步展开 —— 它们本来就是 async 入口, 遍历能把事件循环让出去. write /
 * edit 围栏按模式原文逐路径判定, 不依赖任何扫盘结果.
 *
 * 可写授权来自审批 (见 `request-writable-path.ts`): 工作区外的根并进
 * `writablePaths`, 工作区内的保护旁路进 `writableOverrides`; 两者都只在本会话
 * 内存里存在. 同时注册一个 systemPrompt context, 让模型在写入之前就知道哪些
 * 模式受保护, 哪些额外根可写, 以及怎么申请.
 * @module dsh-write-protect/policy
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { lstatSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  DEFAULT_ALLOW_REQUESTS,
  DEFAULT_HARDEN_BROKER,
  DEFAULT_MAX_GRANTS,
  DEFAULT_MAX_READONLY_ENTRIES,
  DEFAULT_READONLY_FILE_NAME,
  DEFAULT_READ_ONLY_PATHS,
  DEFAULT_WATCH_PROTECTED_PATHS,
  DEFAULT_WATCH_TTL_MAX_MS,
  DEFAULT_WATCH_TTL_MIN_MS,
  DEFAULT_WRITABLE_PATHS,
  PROMPT_CONTEXT_ORDER,
  REQUEST_WRITABLE_PATH_TOOL,
  isValidReadonlyFileName,
} from './constants.ts'
import { compileGitignore } from './gitignore.ts'
import { expandReadOnlyPaths, expandWritablePaths } from './patterns.ts'
import { mountPreviewRoute, type PreviewConnection } from './preview-route.ts'
import { EMPTY_READ_ONLY_FILE, ReadOnlyFileCache, mergeReadOnlyText, type ReadOnlyFile } from './readonly-file.ts'
import { ExpansionRefresher, type ExpansionInputs, type ExpansionSnapshot } from './refresh.ts'
import { GrantsService, registerRequestWritablePath, type GrantPolicyHost } from './request-writable-path.ts'

export const name = 'dsh-write-protect-policy'

/** 插件配置: 官方 policy 的部署字段原样保留, 外加保护路径与额外可写根部署 base. */
export interface Config {
  /** 会话启动时的文件沙箱模式 (缺省 `read-only`, 与官方一致). */
  mode?: SandboxMode
  /**
   * 部署工作区根: 官方 resolve 在无会话 (或会话没有 cwd) 时拿它当边界. 本插件不在
   * 它上面展开保护路径 (见 workspaceRootOfSession), 缺省 `process.cwd()`.
   */
  workspaceRoot?: string
  /**
   * 受保护路径部署 base: 每项一行 gitignore 语义模式, 数组逐行合并为生效文本.
   * 不含 `/` 的条目任意层级匹配, 含开头或中间 `/` 的条目锚定工作区根,
   * `//` 开头为文件系统绝对路径; `!` 按 last-match-wins 取反.
   * 用户在 Web 设置页保存过 patterns 文本后该数组不再生效.
   */
  readOnlyPaths?: string[] | Volatile<string[]>
  /**
   * 额外可写根部署 base: 每项一行字面路径, 数组逐行合并为生效文本.
   * 行首 `~` / `~/...` 为当前用户家目录, `$NAME` / `${NAME}` 为环境变量;
   * `//` 或宿主绝对路径按文件系统解析, 其余相对当前工作区 (含 `..`).
   * 只在 `workspace-write` 下并进 allow-list, 不打穿 `read-only`;
   * 保护路径优先. 用户保存过 writablePatterns 文本后该数组不再生效.
   */
  writablePaths?: string[] | Volatile<string[]>
  /**
   * macOS Seatbelt broker 逃逸加固的部署 base, 缺省开启 (见
   * `DEFAULT_HARDEN_BROKER`). 用户在设置页拨动开关后该值不再生效.
   */
  hardenBroker?: boolean | Volatile<boolean>
  /**
   * 工作区只读规则文件名部署 base, 缺省 `.readonly` (见
   * `DEFAULT_READONLY_FILE_NAME`): 工作区根下的这份文件按 gitignore 语义解析,
   * 逐行追加在设置页文本之后; 空串表示关闭该识别. 用户保存过
   * `readonlyFileName` 后该值不再生效.
   */
  readonlyFileName?: string | Volatile<string>
  /**
   * 规则文件条目数上限部署 base, 缺省 200: 超出的条目丢弃并告警.
   * 用户保存过 `maxReadOnlyEntries` 后该值不再生效.
   */
  maxReadOnlyEntries?: number | Volatile<number>
  /**
   * 单会话可写授权条数上限部署 base, 缺省 8 (见 `DEFAULT_MAX_GRANTS`).
   * 用户保存过 `maxGrants` 后该值不再生效.
   */
  maxGrants?: number | Volatile<number>
  /**
   * 是否允许模型申请可写路径的部署 base, 缺省开启 (见
   * `DEFAULT_ALLOW_REQUESTS`). 关掉后 `request_writable_path` 的任何调用都被
   * 拒绝, 提示词也不再引导模型去申请; 用户保存过该字段后此值不再生效.
   */
  allowWritableRequests?: boolean | Volatile<boolean>
  /**
   * 是否监听工作区变化 (命令侧展开清单的保鲜), 缺省开启 (见
   * `DEFAULT_WATCH_PROTECTED_PATHS`). 开启时只给正在运行 agent 的会话的工作区根
   * 装递归 watcher, 变化后立即后台重扫; 关掉后不装 watcher, 只剩自适应 TTL.
   */
  watchProtectedPaths?: boolean | Volatile<boolean>
  /**
   * 自适应刷新时长的下界 (毫秒), 缺省 2000 (见 `DEFAULT_WATCH_TTL_MIN_MS`).
   * 上次展开耗时乘 10 后不低于它.
   */
  watchTtlMinMs?: number | Volatile<number>
  /**
   * 自适应刷新时长的上界 (毫秒), 缺省 30000 (见 `DEFAULT_WATCH_TTL_MAX_MS`).
   * 上次展开耗时乘 10 后不高于它, 也是 watcher 失效时的兜底刷新间隔.
   */
  watchTtlMaxMs?: number | Volatile<number>
  /** 用户保存的保护路径多行文本; 缺省回退 readOnlyPaths. */
  patterns?: string | Volatile<string>
  /** 用户保存的额外可写根多行文本; 缺省回退 writablePaths. */
  writablePatterns?: string | Volatile<string>
}

function currentConfigValue<T>(value: T | Volatile<T> | undefined, fallback: T): T {
  if (value === undefined) return fallback
  const current = typeof value === 'object' && value !== null && 'get' in value
    ? (value as Volatile<T>).get() as T | undefined
    : value
  return current === undefined ? fallback : current
}

/** 会话事件里用得到的部分: 只读 id 与 header.cwd (agent/status 事件也带这个形状). */
interface SessionLike {
  readonly id: string
  readonly header?: { readonly cwd?: string }
}

/** 一次同步解析得到的生效文本, 本会话授权与缓存里已有的枚举清单. */
export interface PolicySnapshot {
  readonly readOnlyPatterns: string
  readonly readOnly: readonly string[]
  readonly writable: readonly string[]
  readonly overrides: readonly string[]
}

/** 设置页三项新配置的取值来源 (用户覆盖优先, 否则部署 base). */
export interface ResolvedConfigValues {
  readonly readonlyFileName: string
  readonly maxReadOnlyEntries: number
  readonly maxGrants: number
  readonly allowWritableRequests: boolean
  readonly watchProtectedPaths: boolean
  readonly watchTtlMinMs: number
  readonly watchTtlMaxMs: number
}

/** 目标当前是否是目录: 不存在或读不到时按非目录处理. */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

export class WriteProtectPolicyService extends SandboxPolicyService {
  // 内联 schema 调用: config catalog 会静态遍历 `static Config`.
  static Config = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    workspaceRoot: z.string(),
    readOnlyPaths: z.array(z.string()).default([...DEFAULT_READ_ONLY_PATHS]).volatile(),
    writablePaths: z.array(z.string()).default([...DEFAULT_WRITABLE_PATHS]).volatile(),
    patterns: z.string().volatile(),
    writablePatterns: z.string().volatile(),
    hardenBroker: z.boolean().default(DEFAULT_HARDEN_BROKER).volatile(),
    readonlyFileName: z.string().default(DEFAULT_READONLY_FILE_NAME).volatile(),
    maxReadOnlyEntries: z.number().default(DEFAULT_MAX_READONLY_ENTRIES).volatile(),
    maxGrants: z.number().default(DEFAULT_MAX_GRANTS).volatile(),
    allowWritableRequests: z.boolean().default(DEFAULT_ALLOW_REQUESTS).volatile(),
    watchProtectedPaths: z.boolean().default(DEFAULT_WATCH_PROTECTED_PATHS).volatile(),
    watchTtlMinMs: z.number().default(DEFAULT_WATCH_TTL_MIN_MS).volatile(),
    watchTtlMaxMs: z.number().default(DEFAULT_WATCH_TTL_MAX_MS).volatile(),
  })

  private readonly readOnlyFiles: ReadOnlyFileCache
  private readonly grants: GrantsService
  /**
   * 会话 id 到工作区根的记忆: 审批工具只拿得到 agent.session.id (agent 类型不
   * 暴露给本模块), 因此这里把每次解析过的会话工作区根记下来, 让它能按 id 解析
   * 同一份 policy; 设置页预览也用它把授权记录对上是哪个工作区. 进程内存态.
   */
  private readonly sessionRoots = new Map<string, string>()
  /**
   * 正在运行 agent 的会话: 会话 id -> 工作区根. watcher 只服务这批会话, 因此这里
   * 按会话 id 记账 (而不是按根计数), 这样 "status 转 idle" 与 "会话销毁" 两条路径
   * 重复触发也不会把计数弄错.
   */
  private readonly runningSessions = new Map<string, string>()
  /** 展开结果的保鲜: watcher + 自适应 TTL, 见 refresh.ts. */
  private readonly refresher: ExpansionRefresher
  private readonly warned = new Set<string>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, config)
    const entries = currentConfigValue(config.readOnlyPaths, [...DEFAULT_READ_ONLY_PATHS])
    const writableEntries = currentConfigValue(config.writablePaths, [...DEFAULT_WRITABLE_PATHS])
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

    this.readOnlyFiles = new ReadOnlyFileCache(
      () => this.currentLimits().maxReadOnlyEntries,
      message => this.warn(message),
    )
    // 授权只在内存中追加到对应会话记录, 不改变只读规则, 不作废只读展开缓存.
    this.grants = new GrantsService(
      () => this.currentLimits().maxGrants,
      () => {},
    )
    this.refresher = new ExpansionRefresher({
      watchingEnabled: () => this.currentLimits().watchProtectedPaths,
      ttlFloorMs: () => this.currentLimits().watchTtlMinMs,
      ttlCeilingMs: () => this.currentLimits().watchTtlMaxMs,
      inputsOf: workspaceRoot => this.expansionInputs(workspaceRoot),
      expand: async (workspaceRoot, inputs) => await this.expandNow(workspaceRoot, inputs),
      onWarning: message => this.warn(message),
    })
    // 保鲜只服务"正在跑的会话": 开始跑时装 watcher, 跑完或会话销毁时摘掉.
    ctx.on('agent/status', ({ agent, status }: { agent: { session: SessionLike }, status: string }) => {
      this.setSessionRunning(agent.session, status === 'running')
    })
    ctx.on('session/disposed', (session: SessionLike) => {
      this.setSessionRunning(session, false)
    })
    ctx.effect(() => () => this.refresher.dispose())

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
          const policy = this.resolve({ session })
          // 会话没有 cwd 时官方 root 是部署根: 那份规则文件不属于任何会话, 不读它.
          const root = session.header?.cwd === undefined ? undefined : policy.workspaceRoot
          const patterns = (root === undefined ? this.currentText() : this.readOnlyTextAt(root)).trim()
          const parts: string[] = []
          if (patterns.length > 0) {
            parts.push(`Write-protected patterns (gitignore semantics; in read-only and workspace-write mode every DSH-enforced operation denies writes beneath matching paths, reads stay allowed; danger-full-access is unrestricted): ${JSON.stringify(patterns)}.`)
          }
          const source = this.currentReadonlyFileName()
          if (source.length > 0) {
            parts.push(`The workspace read-only rules file "${source}" contributes to those patterns; it is read from the session workspace root and cannot be modified by any tool or command.`)
          }
          const writable = policy.writablePaths ?? []
          if (writable.length > 0) {
            parts.push(`Additional writable roots under workspace-write (sandboxed commands and write/edit tools may write here; write-protected paths still win; does not apply in read-only): ${JSON.stringify(writable)}.`)
          }
          const overrides = policy.writableOverrides ?? []
          if (overrides.length > 0) {
            parts.push(`Session write grants that bypass write protection for the write/edit tools and for sandboxed commands: ${JSON.stringify(overrides)}.`)
          }
          if (this.currentLimits().allowWritableRequests) {
            parts.push(`Extra write access is not granted by default. Call ${JSON.stringify(REQUEST_WRITABLE_PATH_TOOL)} when the task will keep writing the same protected path or area (a directory of files to generate, a build output tree, a path outside the workspace that several writes depend on); a single file is written with the ordinary write/edit tools, and if that write is denied, leave it at that. The user decides in an approval prompt, and the grant lasts only for this session.`)
          } else {
            parts.push('Extra write access is not granted by this deployment: do not ask for it.')
          }
          return parts.join(' ')
        },
      })
    })

    // 模型的可写申请工具. 只有组合里确实有工具注册表时才注册; 工具模块静态
    // 依赖官方 `dsh-tools` (peer), 因此没有工具注册表的部署也不会加载到它.
    // 工具始终注册 (schema 稳定), 是否受理由 allowWritableRequests 在调用时判定.
    ctx.inject(['tools'], (scope: Context) => {
      const host: GrantPolicyHost = {
        workspaceRootOfSession: (sessionId, cwd) => this.workspaceRootOfSession(sessionId, cwd),
        resolve: (sessionId, cwd) => this.resolveForSession(sessionId ?? '', cwd),
        protectedPatternFor: (sessionId, cwd, target) => this.protectedPatternFor(sessionId, cwd, target),
        maxGrants: () => this.currentLimits().maxGrants,
        rulesFilePath: workspaceRoot => this.rulesFilePath(workspaceRoot),
        allowRequests: () => this.currentLimits().allowWritableRequests,
      }
      registerRequestWritablePath(scope, this.grants, host)
    })

    ctx.inject(['connection'], (scope: Context) => {
      const connection = (scope as Context & { connection: PreviewConnection }).connection
      scope.effect(
        () => mountPreviewRoute(connection, this),
        'dsh-write-protect: preview route',
      )
    })
  }

  /** 部署 base 的保护路径文本形态 (patch 数组逐行合并). */
  private baseText(): string {
    return currentConfigValue(this.config.readOnlyPaths, [...DEFAULT_READ_ONLY_PATHS]).join('\n')
  }

  /** 部署 base 的额外可写根文本形态 (patch 数组逐行合并). */
  private writableBaseText(): string {
    return currentConfigValue(this.config.writablePaths, [...DEFAULT_WRITABLE_PATHS]).join('\n')
  }

  /** 当前生效的保护路径文本: 用户在设置页保存过的 patterns 覆盖部署 base. */
  private currentText(): string {
    return currentConfigValue(this.config.patterns, this.baseText())
  }

  /** 当前生效的额外可写文本: 用户保存过的 writablePatterns 覆盖部署 base. */
  private currentWritableText(): string {
    return currentConfigValue(this.config.writablePatterns, this.writableBaseText())
  }

  /** 当前生效的 broker 加固开关: 用户拨动过设置页开关则以其为准, 否则走部署 base. */
  private currentHardenBroker(): boolean {
    return currentConfigValue(this.config.hardenBroker, DEFAULT_HARDEN_BROKER)
  }

  /** 当前生效的规则文件名 (空串即关闭识别). */
  currentReadonlyFileName(): string {
    return this.currentLimits().readonlyFileName
  }

  /**
   * 异步展开当前生效文本: 保护路径文本是设置页文本与规则文件文本的合并, 额外
   * 可写根走字面路径展开. 同一 (两份文本, 工作区根) 的进行中请求会合到一次遍历
   * 上; 结果按 TTL 缓存. 本会话授权不在这里展开: 审批阶段就已经拿到 canonical
   * 绝对路径, 由 `resolve()` 直接并进 policy.
   * @param workspaceRoot - 会话工作区根.
   * @returns 展开后的保护路径, 额外可写根与当时的保护路径原文.
   */
  async materialize(workspaceRoot: string): Promise<ExpansionSnapshot> {
    return await this.refresher.materialize(workspaceRoot, this.expansionInputs(workspaceRoot))
  }

  /**
   * 一次展开的输入: 生效保护文本 (设置页文本与规则文件合并) 与额外可写文本, 以及
   * 由这两份文本组成的缓存键. 文本变过就一定要重新展开.
   */
  private expansionInputs(workspaceRoot: string): ExpansionInputs {
    const readOnlyText = this.readOnlyTextAt(workspaceRoot)
    const writableText = this.currentWritableText()
    return { key: [readOnlyText, writableText].join('\u0000'), readOnlyText, writableText }
  }

  /** 真正执行一次展开, 并把各条告警去重后写日志. */
  private async expandNow(workspaceRoot: string, inputs: ExpansionInputs): Promise<ExpansionSnapshot> {
    const readOnly = await expandReadOnlyPaths(inputs.readOnlyText, workspaceRoot)
    const writable = expandWritablePaths(inputs.writableText, workspaceRoot)
    for (const warning of [...readOnly.warnings, ...writable.warnings]) {
      this.warn(warning)
    }
    return {
      readOnly: readOnly.paths,
      writable: writable.paths,
      patterns: inputs.readOnlyText,
    }
  }

  /**
   * 记录 / 撤销一个"正在运行 agent 的会话". watcher 只装给这批会话的工作区根:
   * 开始运行时装上, 运行结束 (或会话销毁) 时摘掉. 同一个根被多个会话共用时按会话
   * 计数, 最后一个会话结束后才摘.
   * @param session - 事件里的会话 (只需要 id 与 header.cwd).
   * @param running - 是否正在运行.
   */
  private setSessionRunning(session: SessionLike | undefined, running: boolean): void {
    const sessionId = session?.id
    if (sessionId === undefined) return
    if (running) {
      const root = this.localWorkspaceRootOf(session)
      if (root === undefined) return
      if (this.runningSessions.get(sessionId) === root) return
      if (this.runningSessions.has(sessionId)) this.setSessionRunning(session, false)
      this.runningSessions.set(sessionId, root)
      this.refresher.addUser(root)
      return
    }
    const root = this.runningSessions.get(sessionId)
    if (root === undefined) return
    this.runningSessions.delete(sessionId)
    this.refresher.removeUser(root)
  }

  /**
   * 会话的本地工作区根 (canonical), 取不到可监听的本地路径时返回 undefined.
   *
   * 今天 dsh 的会话只有本地 cwd 一种形态; 将来出现远端会话时, 这里会拿不到本地
   * 路径 (或拿到远端路径), 于是自然退化成"不装 watcher, 只用 TTL".
   */
  private localWorkspaceRootOf(session: SessionLike | undefined): string | undefined {
    const cwd = session?.header?.cwd
    if (cwd === undefined || cwd.trim().length === 0) return undefined
    return resolvePath(canonicalPath(cwd))
  }

  /** 展开额外可写根文本 (纯字面路径, 不扫盘) 并把告警去重后写日志. */
  private expandWritable(text: string, workspaceRoot: string): readonly string[] {
    const expanded = expandWritablePaths(text, workspaceRoot)
    for (const warning of expanded.warnings) {
      this.warn(warning)
    }
    return expanded.paths
  }

  /**
   * 当前工作区根的规则文件路径 (canonical), 文件名关闭时为 undefined.
   *
   * 这份文件是唯一"硬保护": 它自己改写规则, 因此既不能被任何写入旁路放行, 也不
   * 在可写申请的受理范围内. 要改它只能改设置页的文件名或由用户在编辑器里改.
   * @param workspaceRoot - 会话工作区根.
   */
  rulesFilePath(workspaceRoot: string): string | undefined {
    const name = this.currentLimits().readonlyFileName
    if (name.length === 0) return undefined
    return canonicalPath(resolvePath(workspaceRoot, name))
  }

  /** 某个工作区根的规则文件: 缓存新鲜就用缓存, 否则同步读一次. */
  private readOnlyFileAt(workspaceRoot: string): ReadOnlyFile {
    const name = this.currentLimits().readonlyFileName
    if (name.length === 0) return EMPTY_READ_ONLY_FILE
    return this.readOnlyFiles.read(workspaceRoot, name)
  }

  /** 某个工作区根的生效保护路径文本: 设置页文本与规则文件原文合并. */
  private readOnlyTextAt(workspaceRoot: string): string {
    return mergeReadOnlyText(this.currentText(), this.readOnlyFileAt(workspaceRoot).text)
  }

  /**
   * 会话 id 到工作区根的记忆 (只为设置页预览把授权记录对上是哪个工作区).
   * 每次 resolve() 顺手记录; 进程内存态, 不持久化.
   */
  private rememberSession(sessionId: string, workspaceRoot: string): void {
    this.sessionRoots.set(sessionId, workspaceRoot)
  }

  /**
   * 会话的工作区根: 最近一次 resolve() 记下的那一份, 或调用方从会话日志带来的
   * cwd (`resolve` 成绝对路径, 同时记下). 两者都没有时返回 undefined.
   *
   * 这里刻意**不回退部署根**: 部署根是进程 cwd, 可能就是一棵极大的树 (从 home
   * 启动时的整个 home), 而保护路径展开是一次扫盘 —— 在那里枚举会把 Host 事件循环
   * 堵住几十秒, 表现成整个 dsh 无响应. 没有根就不展开, 由调用方决定怎么办.
   * @param sessionId - 目标会话 id.
   * @param cwd - 会话日志里的 cwd; 缺省表示调用方拿不到.
   * @returns 绝对工作区根, 或 undefined.
   */
  workspaceRootOfSession(sessionId: string, cwd?: string): string | undefined {
    const remembered = this.sessionRoots.get(sessionId)
    if (remembered !== undefined) return remembered
    if (cwd === undefined || cwd.trim().length === 0) return undefined
    const root = resolvePath(cwd)
    this.rememberSession(sessionId, root)
    return root
  }

  /** 当前生效的规则文件条目上限, 会话授权上限与可写申请开关 (供设置页预览复用). */
  limits(): ResolvedConfigValues {
    return this.currentLimits()
  }

  /** 规则文件读取器 (设置页预览直接读一次磁盘, 不依赖缓存). */
  readOnlyFileReader(): ReadOnlyFileCache {
    return this.readOnlyFiles
  }

  /** 会话授权记录 (设置页预览列出当前生效的授权). */
  grantsView(): GrantsService {
    return this.grants
  }

  /**
   * 目标是否被当前生效的保护文本命中, 命中时返回那条模式原文.
   *
   * 判定与 write / edit 围栏同源: 都拿模式原文直接匹配目标路径, 因此不受展开
   * 缓存冷热影响, 也不依赖任何扫盘结果.
   * @param sessionId - 调用所属会话, 缺省表示无会话调用.
   * @param cwd - 会话日志里的 cwd, 供会话尚未被 resolve 过时定位工作区根.
   * @param target - 目标绝对路径.
   * @returns 命中的模式原文, 未命中为 undefined.
   */
  protectedPatternFor(sessionId: string | undefined, cwd: string | undefined, target: string): string | undefined {
    const policy = this.resolveForSession(sessionId ?? '', cwd)
    const text = policy.readOnlyPatterns
    if (typeof text !== 'string' || text.trim().length === 0) return undefined
    // 申请的目标可能是目录 (模型要整棵子树), 也可能是文件或还不存在: gitignore 的
    // 目录标记条目只对目录生效, 因此这里按目标在磁盘上的实际情况判定.
    return compileGitignore(text).match(target, policy.workspaceRoot, isDirectory(target))?.entry.source
  }

  /** 当前生效的规则文件条目上限, 会话授权上限, 可写申请开关与保鲜配置. */
  private currentLimits(): ResolvedConfigValues {
    const watchTtlMinMs = this.positiveLimit(currentConfigValue(this.config.watchTtlMinMs, DEFAULT_WATCH_TTL_MIN_MS), DEFAULT_WATCH_TTL_MIN_MS, 'watchTtlMinMs')
    const watchTtlMaxMs = this.positiveLimit(currentConfigValue(this.config.watchTtlMaxMs, DEFAULT_WATCH_TTL_MAX_MS), DEFAULT_WATCH_TTL_MAX_MS, 'watchTtlMaxMs')
    return {
      readonlyFileName: this.warnAboutFileName(currentConfigValue(this.config.readonlyFileName, DEFAULT_READONLY_FILE_NAME)),
      maxReadOnlyEntries: this.positiveLimit(currentConfigValue(this.config.maxReadOnlyEntries, DEFAULT_MAX_READONLY_ENTRIES), DEFAULT_MAX_READONLY_ENTRIES, 'maxReadOnlyEntries'),
      maxGrants: this.positiveLimit(currentConfigValue(this.config.maxGrants, DEFAULT_MAX_GRANTS), DEFAULT_MAX_GRANTS, 'maxGrants'),
      allowWritableRequests: currentConfigValue(this.config.allowWritableRequests, DEFAULT_ALLOW_REQUESTS),
      watchProtectedPaths: currentConfigValue(this.config.watchProtectedPaths, DEFAULT_WATCH_PROTECTED_PATHS),
      watchTtlMinMs,
      // 上界小于下界时按上下界里较大的那个算, 免得自适应区间反转.
      watchTtlMaxMs: Math.max(watchTtlMinMs, watchTtlMaxMs),
    }
  }

  /** 校验并回退规则文件名, 非法值告警一次. */
  private warnAboutFileName(value: string): string {
    if (value.trim().length === 0) return ''
    if (isValidReadonlyFileName(value)) return value.trim()
    this.warn(`readonlyFileName ${JSON.stringify(value)} is not a plain file name (no path separators, not "." / "..", not git metadata); falling back to "${DEFAULT_READONLY_FILE_NAME}"`)
    return DEFAULT_READONLY_FILE_NAME
  }

  /** 取正数上限, 非法值回退默认并告警一次. */
  private positiveLimit(value: number | undefined, fallback: number, field: string): number {
    if (value === undefined) return fallback
    if (Number.isSafeInteger(value) && value > 0) return value
    this.warn(`${field} must be a positive integer, got ${JSON.stringify(value)}; falling back to ${String(fallback)}`)
    return fallback
  }

  /** 告警去重后写到日志. */
  private warn(message: string): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.ctx.logger?.warn?.(`dsh-write-protect: ${message}`)
  }

  /**
   * 同步解析一次调用的生效文本: 设置页文本与规则文件文本的合并结果, 本会话授权,
   * 以及展开缓存里已有的路径清单 (冷缓存时为空).
   *
   * 这里刻意不做展开: `resolve()` 是同步契约, 扫盘只能放到 `materialize()` 那条
   * async 路径上. `workspaceRoot` 为 undefined 表示没有已知的会话工作区根: 此时
   * 不读规则文件也不展开, 只保留设置页原文与会话授权 (后者已是绝对路径).
   * @param workspaceRoot - 会话工作区根, 未知时为 undefined.
   * @param sessionId - 调用所属会话, 缺省表示无会话调用.
   */
  private snapshot(workspaceRoot: string | undefined, sessionId: string | undefined): PolicySnapshot {
    const settingsText = this.currentText()
    const record = sessionId === undefined ? { extraRoots: [], overrides: [], grants: [] } : this.grants.recordOf(sessionId)
    if (workspaceRoot === undefined) {
      return {
        readOnlyPatterns: settingsText,
        readOnly: [],
        writable: [...record.extraRoots],
        overrides: record.overrides,
      }
    }
    const readOnlyPatterns = this.readOnlyTextAt(workspaceRoot)
    const writableText = this.currentWritableText()
    const cached = this.refresher.peek(workspaceRoot, [readOnlyPatterns, writableText].join('\u0000'))
    const writable = cached?.writable ?? this.expandWritable(writableText, workspaceRoot)
    return {
      readOnlyPatterns,
      readOnly: cached?.readOnly ?? [],
      writable: [...record.extraRoots, ...writable],
      overrides: record.overrides,
    }
  }

  /**
   * 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
   * 追加注入合并后的保护路径原文 (给 write / edit 围栏逐路径判定), 展开缓存里
   * 已有的清单 (冷缓存时为空, `confine()` 会 await {@link materialize}), 额外
   * 可写根, 本会话授权, 保护旁路, 规则文件路径与 broker 加固开关.
   * @param request - 可选的会话与已批准的模式覆盖.
   * @returns 带有 `readOnlyPatterns` / `readOnlyPaths` / `writablePaths` /
   * `writableOverrides` / `rulesFilePath` 的完整逐次调用 policy.
   */
  override resolve(request: Parameters<SandboxPolicyService['resolve']>[0] = {}): SandboxExecutionPolicy {
    const policy = super.resolve(request)
    const sessionId = request.session?.id
    // 只有会话确实带 cwd 时才把它的工作区根当展开基准: 否则官方 root 是部署根
    // (进程 cwd), 在它上面枚举保护路径会堵住 Host 事件循环.
    const root = request.session?.header.cwd === undefined ? undefined : policy.workspaceRoot
    const snapshot = this.snapshot(root, sessionId)
    policy.readOnlyPatterns = snapshot.readOnlyPatterns
    policy.readOnlyPaths = snapshot.readOnly
    policy.writablePaths = snapshot.writable
    policy.writableOverrides = snapshot.overrides
    policy.rulesFilePath = root === undefined ? undefined : this.rulesFilePath(root)
    policy.hardenBroker = this.currentHardenBroker()
    if (sessionId !== undefined && root !== undefined) this.rememberSession(sessionId, root)
    return policy
  }

  /**
   * 按会话 id 解析一次 policy: 给只拿得到会话 id 的消费方 (审批工具) 用. 工作区
   * 根取该会话最近一次解析出来的那一份, 没有就用调用方给的 cwd, 两者都没有时
   * 保护路径不展开也不回退部署根, 只带设置页原文.
   *
   * 这里刻意不走本类覆写过的 `resolve()`: 那一支会先按"无会话"解析一次, 从而把
   * 保护路径的展开基准落到部署根 (进程 cwd) 上. 本方法只借 super 的 mode 与部署
   * 默认值, 保护范围随后全部按会话自己那份重算.
   * @param sessionId - 目标会话 id.
   * @param cwd - 会话日志里的 cwd, 供会话尚未被 resolve 过时定位工作区根.
   */
  resolveForSession(sessionId: string, cwd?: string): SandboxExecutionPolicy {
    const base = super.resolve({})
    const workspaceRoot = this.workspaceRootOfSession(sessionId, cwd)
    const snapshot = this.snapshot(workspaceRoot, sessionId)
    return {
      ...base,
      // 根未知时保留 super 的部署根字段: 此时保护清单为空, 该字段只作为 allow-list
      // 边界存在, 不参与任何保护路径判定.
      workspaceRoot: workspaceRoot ?? base.workspaceRoot,
      sessionId: sessionId as SandboxExecutionPolicy['sessionId'],
      readOnlyPatterns: snapshot.readOnlyPatterns,
      readOnlyPaths: snapshot.readOnly,
      writablePaths: snapshot.writable,
      writableOverrides: snapshot.overrides,
      rulesFilePath: workspaceRoot === undefined ? undefined : this.rulesFilePath(workspaceRoot),
      hardenBroker: this.currentHardenBroker(),
    }
  }
}

export default WriteProtectPolicyService

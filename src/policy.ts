/**
 * 替换 base 的 `sandbox-policy` 行: 在官方 `SandboxPolicyService` 之上增加
 * `readOnlyPaths` 与 `writablePaths`. 保护路径以 gitignore 语义的多行文本
 * 声明, 额外可写根是字面路径列表 (见 `patterns.ts`). 来源按优先级取值:
 * Web 设置页编辑过的用户配置覆盖 patch 数组 (部署 base). 解析结果带 TTL
 * 缓存, 每次 resolve() 注入逐次调用的 policy, 作为 fs 围栏与进程沙箱
 * provider 共同消费的单一事实来源; 同时注册一个 systemPrompt context,
 * 让模型在写入之前就知道哪些路径受保护, 哪些额外根可写, 以及怎么申请.
 *
 * 生效的保护路径文本是两份来源的合并: 设置页文本在前, 工作区只读规则文件
 * (默认 `.readonly`, 见 `readonly-file.ts`) 在后. 规则文件按工作区根各一份,
 * 由 `ReadOnlyFileCache` 读取 (自身带短 TTL), 因此 `resolve()` 保持同步契约.
 *
 * 可写授权来自审批 (见 `request-writable-path.ts`): 工作区外的根并进
 * `writablePaths`, 工作区内的保护旁路进 `writableOverrides`; 两者都只在本会话
 * 内存里存在.
 * @module dsh-write-protect/policy
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { resolve as resolvePath } from 'node:path'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  ALLOW_REQUESTS_FIELD,
  DEFAULT_ALLOW_REQUESTS,
  DEFAULT_HARDEN_BROKER,
  DEFAULT_MAX_GRANTS,
  DEFAULT_MAX_READONLY_ENTRIES,
  DEFAULT_READONLY_FILE_NAME,
  DEFAULT_READ_ONLY_PATHS,
  DEFAULT_WRITABLE_PATHS,
  HARDEN_BROKER_FIELD,
  MAX_GRANTS_FIELD,
  MAX_READONLY_ENTRIES_FIELD,
  PATTERNS_FIELD,
  PLUGIN_ID,
  PROMPT_CONTEXT_ORDER,
  READONLY_FILE_FIELD,
  REQUEST_WRITABLE_PATH_TOOL,
  WRITABLE_FIELD,
  isValidReadonlyFileName,
} from './constants.ts'
import { expandReadOnlyPaths, expandWritablePaths } from './patterns.ts'
import { mountPreviewRoute, type PreviewConnection } from './preview-route.ts'
import { EMPTY_READ_ONLY_FILE, ReadOnlyFileCache, mergeReadOnlyText, type ReadOnlyFile } from './readonly-file.ts'
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

/** 展开结果的缓存有效时长: resolve 每个 tool call 都会调用, glob 枚举有 IO 成本. */
const EXPAND_TTL_MS = 5000

/** 一次解析得到的完整生效文本与展开结果. */
export interface PolicySnapshot {
  readonly readOnlyPatterns: string
  readonly readOnlyFilePatterns: string
  readonly readOnly: readonly string[]
  readonly writable: readonly string[]
  readonly overrides: readonly string[]
  readonly file: ReadOnlyFile
}

/** 设置页三项新配置的取值来源 (用户覆盖优先, 否则部署 base). */
interface ResolvedConfigValues {
  readonly readonlyFileName: string
  readonly maxReadOnlyEntries: number
  readonly maxGrants: number
  readonly allowWritableRequests: boolean
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
  })

  private readonly readOnlyFiles: ReadOnlyFileCache
  private readonly grants: GrantsService
  /**
   * 会话 id 到工作区根的记忆: 审批工具只拿得到 agent.session.id (agent 类型不
   * 暴露给本模块), 因此这里把每次解析过的会话工作区根记下来, 让它能按 id 解析
   * 同一份 policy; 设置页预览也用它把授权记录对上是哪个工作区. 进程内存态.
   */
  private readonly sessionRoots = new Map<string, string>()
  private readOnlyCache: {
    at: number
    key: string
    readOnly: readonly string[]
    readOnlyPatterns: string
    readOnlyFilePatterns: string
    file: ReadOnlyFile
  } = {
    at: 0,
    key: '',
    readOnly: [],
    readOnlyPatterns: '',
    readOnlyFilePatterns: '',
    file: EMPTY_READ_ONLY_FILE,
  }
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
      DEFAULT_MAX_READONLY_ENTRIES,
      message => this.warn(message),
    )
    // 授权只在内存中追加到对应会话记录, 不改变只读规则, 不作废只读展开缓存.
    this.grants = new GrantsService(
      () => this.currentLimits().maxGrants,
      () => {},
    )

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
          const patterns = this.currentReadOnlyText(policy.workspaceRoot).trim()
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
        currentProtectedPaths: (sessionId, cwd) => this.resolveForSession(sessionId ?? '', cwd).readOnlyPaths ?? [],
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

  /** 规则文件名与其上限 (供设置页预览复用同一份配置). */
  limits(): ResolvedConfigValues {
    return this.currentLimits()
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
   * 启动时的整个 home), 而保护路径展开是同步扫盘 —— 在那里枚举会把 Host 事件循环
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

  /** 当前生效的规则文件条目上限, 会话授权上限与可写申请开关. */
  private currentLimits(): ResolvedConfigValues {
    return {
      readonlyFileName: this.warnAboutFileName(currentConfigValue(this.config.readonlyFileName, DEFAULT_READONLY_FILE_NAME)),
      maxReadOnlyEntries: this.positiveLimit(currentConfigValue(this.config.maxReadOnlyEntries, DEFAULT_MAX_READONLY_ENTRIES), DEFAULT_MAX_READONLY_ENTRIES, 'maxReadOnlyEntries'),
      maxGrants: this.positiveLimit(currentConfigValue(this.config.maxGrants, DEFAULT_MAX_GRANTS), DEFAULT_MAX_GRANTS, 'maxGrants'),
      allowWritableRequests: currentConfigValue(this.config.allowWritableRequests, DEFAULT_ALLOW_REQUESTS),
    }
  }

  /** 当前生效的保护路径原文: 设置页文本与规则文件原文合并. */
  currentReadOnlyText(workspaceRoot: string): string {
    return mergeReadOnlyText(this.currentText(), this.readOnlyFileAt(workspaceRoot).text)
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

  /** 设置 / 规则文件变化后作废只读展开缓存. */
  private invalidate(): void {
    this.readOnlyCache = { ...this.readOnlyCache, at: 0, key: '' }
  }

  /**
   * 解析一次调用的完整生效文本: 设置页文本, 规则文件文本, 本会话授权, 以及
   * 合并后的可写文本.
   *
   * 只读展开 (昂贵的扫盘操作) 按 (settingsText, file.text, workspaceRoot) 做 TTL 缓存;
   * 会话授权变动只追加可写根与保护旁路, 不作废只读展开缓存, 避免申请授权后重新扫盘.
   * `workspaceRoot` 为 undefined 表示没有已知的会话工作区根: 此时不读规则文件,
   * 也不做展开 (返回空的路径清单与设置页原文), 因为唯一现成的候选是部署根 (进程
   * cwd), 在那里枚举会同步堵住 Host 事件循环.
   * @param workspaceRoot - 会话工作区根, 未知时为 undefined.
   * @param sessionId - 调用所属会话, 缺省表示无会话调用.
   */
  private snapshot(workspaceRoot: string | undefined, sessionId: string | undefined): PolicySnapshot {
    const settingsText = this.currentText()
    const record = sessionId === undefined ? { extraRoots: [], overrides: [], grants: [] } : this.grants.recordOf(sessionId)
    if (workspaceRoot === undefined) {
      this.warn('no session workspace root is known, so write-protect patterns stay unexpanded (readOnlyPaths / writablePaths are empty) until a session with a cwd resolves the policy')
      return {
        readOnlyPatterns: settingsText,
        readOnlyFilePatterns: '',
        readOnly: [],
        writable: [],
        overrides: record.overrides,
        file: EMPTY_READ_ONLY_FILE,
      }
    }
    const file = this.readOnlyFileAt(workspaceRoot)
    const readOnlyPatterns = mergeReadOnlyText(settingsText, file.text)
    const readOnlyKey = [settingsText, file.text, workspaceRoot].join('\u0000')
    const now = Date.now()
    let readOnlySnapshot: {
      readOnlyPatterns: string
      readOnlyFilePatterns: string
      readOnly: readonly string[]
      file: ReadOnlyFile
    }
    if (now - this.readOnlyCache.at < EXPAND_TTL_MS && this.readOnlyCache.key === readOnlyKey) {
      readOnlySnapshot = this.readOnlyCache
    } else {
      const readOnly = expandReadOnlyPaths(readOnlyPatterns, workspaceRoot)
      for (const warning of readOnly.warnings) {
        this.warn(warning)
      }
      readOnlySnapshot = {
        readOnlyPatterns,
        readOnlyFilePatterns: file.text,
        readOnly: readOnly.paths,
        file,
      }
      this.readOnlyCache = {
        at: now,
        key: readOnlyKey,
        ...readOnlySnapshot,
      }
    }

    const writableSettingsText = this.currentWritableText()
    const writableText = [...record.extraRoots, writableSettingsText].filter(line => line.trim().length > 0).join('\n')
    const writable = expandWritablePaths(writableText, workspaceRoot)
    for (const warning of writable.warnings) {
      this.warn(warning)
    }

    return {
      readOnlyPatterns: readOnlySnapshot.readOnlyPatterns,
      readOnlyFilePatterns: readOnlySnapshot.readOnlyFilePatterns,
      readOnly: readOnlySnapshot.readOnly,
      writable: writable.paths,
      overrides: record.overrides,
      file: readOnlySnapshot.file,
    }
  }

  /** 展开一次生效文本 (供设置页预览复用同一套解析; 不带任何会话授权). */
  snapshotForPreview(workspaceRoot: string): PolicySnapshot {
    return this.snapshot(workspaceRoot, undefined)
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
   * 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
   * 追加注入合并后的保护路径 (原文与展开形态), 规则文件原文, 额外可写根,
   * 本会话授权, 保护旁路与 broker 加固开关.
   *
   * 展开只在**确实知道会话工作区根**时进行 (会话日志里的 cwd); 会话没有 cwd 时
   * 不做回退: 官方 root 此时是部署根 (进程 cwd), 可能是一棵极大的树, 在那里枚举
   * 保护路径会同步堵住 Host 事件循环.
   * @param request - 可选的会话与已批准的模式覆盖.
   * @returns 带有 `readOnlyPatterns` / `readOnlyPaths` / `writablePaths` /
   * `writableOverrides` / `hardenBroker` 的完整逐次调用 policy.
   */
  override resolve(request: Parameters<SandboxPolicyService['resolve']>[0] = {}): SandboxExecutionPolicy {
    const policy = super.resolve(request)
    const sessionId = request.session?.id
    const root = request.session?.header.cwd === undefined ? undefined : policy.workspaceRoot
    const snapshot = this.snapshot(root, sessionId)
    policy.readOnlyPatterns = snapshot.readOnlyPatterns
    policy.readOnlyPaths = snapshot.readOnly
    policy.readOnlyFilePatterns = snapshot.readOnlyFilePatterns
    policy.writablePaths = snapshot.writable
    policy.writableOverrides = snapshot.overrides
    policy.writableGrants = sessionId === undefined
      ? []
      : this.grants.recordOf(sessionId).grants.map(grant => grant.path)
    policy.rulesFilePath = root === undefined ? undefined : this.rulesFilePath(root)
    policy.hardenBroker = this.currentHardenBroker()
    if (sessionId !== undefined && root !== undefined) this.rememberSession(sessionId, root)
    return policy
  }

  /**
   * 按会话 id 解析一次 policy: 给只拿得到会话 id 的消费方 (审批工具) 用. 工作区
   * 根取该会话最近一次解析出来的那一份, 没有就用调用方给的 cwd, 两者都没有时
   * 保护路径不展开 (readOnlyPaths / writablePaths 为空) —— 不回退部署根.
   *
   * 这里刻意不走本类覆写过的 `resolve()`: 那一支会先按"无会话"解析一次, 从而把
   * 保护路径展开到部署根 (进程 cwd) 上. 部署根很大时那是一次几十秒的同步扫盘,
   * Host 事件循环会被它堵死. 本方法只借 super 的 mode 与部署默认值, 保护范围随后
   * 全部按会话自己那份重算.
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
      readOnlyFilePatterns: snapshot.readOnlyFilePatterns,
      writablePaths: snapshot.writable,
      writableOverrides: snapshot.overrides,
      writableGrants: this.grants.recordOf(sessionId).grants.map(grant => grant.path),
      rulesFilePath: workspaceRoot === undefined ? undefined : this.rulesFilePath(workspaceRoot),
      hardenBroker: this.currentHardenBroker(),
    }
  }
}

/**
 * settings namespace 的字段集合: 两份多行文本, 三项数值 / 文本配置与两个开关,
 * 未编辑时走 base. 与 `WriteProtectSettingsSchema` 的键保持一致.
 */
type WriteProtectSettings =
  & Record<typeof PATTERNS_FIELD, string>
  & Record<typeof WRITABLE_FIELD, string>
  & Record<typeof HARDEN_BROKER_FIELD, boolean>
  & Record<typeof READONLY_FILE_FIELD, string>
  & Record<typeof MAX_READONLY_ENTRIES_FIELD, number>
  & Record<typeof MAX_GRANTS_FIELD, number>
  & Record<typeof ALLOW_REQUESTS_FIELD, boolean>

/** settings namespace 的 schema: 两份多行文本, 三项配置, 两个开关. */
const WriteProtectSettingsSchema = z.object({
  [PATTERNS_FIELD]: z.string(),
  [WRITABLE_FIELD]: z.string(),
  [HARDEN_BROKER_FIELD]: z.boolean(),
  [READONLY_FILE_FIELD]: z.string(),
  [MAX_READONLY_ENTRIES_FIELD]: z.number(),
  [MAX_GRANTS_FIELD]: z.number(),
  [ALLOW_REQUESTS_FIELD]: z.boolean(),
})

export default WriteProtectPolicyService

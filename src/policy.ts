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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { resolve as resolvePath } from 'node:path'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
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
  /**
   * 工作区只读规则文件名部署 base, 缺省 `.readonly` (见
   * `DEFAULT_READONLY_FILE_NAME`): 工作区根下的这份文件按 gitignore 语义解析,
   * 逐行追加在设置页文本之后; 空串表示关闭该识别. 用户保存过
   * `readonlyFileName` 后该值不再生效.
   */
  readonlyFileName?: string
  /**
   * 规则文件条目数上限部署 base, 缺省 200: 超出的条目丢弃并告警.
   * 用户保存过 `maxReadOnlyEntries` 后该值不再生效.
   */
  maxReadOnlyEntries?: number
  /**
   * 单会话可写授权条数上限部署 base, 缺省 8 (见 `DEFAULT_MAX_GRANTS`).
   * 用户保存过 `maxGrants` 后该值不再生效.
   */
  maxGrants?: number
  /**
   * 是否允许模型申请可写路径的部署 base, 缺省开启 (见
   * `DEFAULT_ALLOW_REQUESTS`). 关掉后 `request_writable_path` 的任何调用都被
   * 拒绝, 提示词也不再引导模型去申请; 用户保存过该字段后此值不再生效.
   */
  allowWritableRequests?: boolean
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
    readOnlyPaths: z.array(z.string()).default([...DEFAULT_READ_ONLY_PATHS]),
    writablePaths: z.array(z.string()).default([...DEFAULT_WRITABLE_PATHS]),
    hardenBroker: z.boolean().default(DEFAULT_HARDEN_BROKER),
    readonlyFileName: z.string().default(DEFAULT_READONLY_FILE_NAME),
    maxReadOnlyEntries: z.number().default(DEFAULT_MAX_READONLY_ENTRIES),
    maxGrants: z.number().default(DEFAULT_MAX_GRANTS),
    allowWritableRequests: z.boolean().default(DEFAULT_ALLOW_REQUESTS),
  })

  private readonly baseEntries: readonly string[]
  private readonly writableBaseEntries: readonly string[]
  private readonly hardenBrokerBase: boolean
  private readonly readonlyFileNameBase: string
  private readonly maxReadOnlyEntriesBase: number
  private readonly maxGrantsBase: number
  private readonly allowRequestsBase: boolean
  private readonly readOnlyFiles: ReadOnlyFileCache
  private readonly grants: GrantsService
  /**
   * 会话 id 到工作区根的记忆: 审批工具只拿得到 agent.session.id (agent 类型不
   * 暴露给本模块), 因此这里把每次解析过的会话工作区根记下来, 让它能按 id 解析
   * 同一份 policy; 设置页预览也用它把授权记录对上是哪个工作区. 进程内存态.
   */
  private readonly sessionRoots = new Map<string, string>()
  private settingsOwner: SettingsScope<WriteProtectSettings> | undefined
  private cache: {
    at: number
    key: string
    readOnly: readonly string[]
    writable: readonly string[]
    overrides: readonly string[]
    readOnlyPatterns: string
    readOnlyFilePatterns: string
    file: ReadOnlyFile
  } = {
    at: 0,
    key: '',
    readOnly: [],
    writable: [],
    overrides: [],
    readOnlyPatterns: '',
    readOnlyFilePatterns: '',
    file: EMPTY_READ_ONLY_FILE,
  }
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
    this.readonlyFileNameBase = this.warnAboutFileName(config.readonlyFileName ?? DEFAULT_READONLY_FILE_NAME)
    this.maxReadOnlyEntriesBase = this.positiveLimit(config.maxReadOnlyEntries, DEFAULT_MAX_READONLY_ENTRIES, 'maxReadOnlyEntries')
    this.maxGrantsBase = this.positiveLimit(config.maxGrants, DEFAULT_MAX_GRANTS, 'maxGrants')
    this.allowRequestsBase = config.allowWritableRequests ?? DEFAULT_ALLOW_REQUESTS
    this.readOnlyFiles = new ReadOnlyFileCache(
      this.maxReadOnlyEntriesBase,
      message => this.warn(message),
    )
    this.grants = new GrantsService(
      () => this.currentLimits().maxGrants,
      () => this.invalidate(),
    )

    // Web 设置页的持久化配置: composition base 是 patch 的数组与开关, 用户保存过
    // 的值覆盖对应字段; 编辑后缓存失效实时生效.
    ctx.inject(['settings'], (scope: Context) => {
      const owner = scope.settings.register(PLUGIN_ID, WriteProtectSettingsSchema, {
        base: {
          [PATTERNS_FIELD]: this.baseText(),
          [WRITABLE_FIELD]: this.writableBaseText(),
          [HARDEN_BROKER_FIELD]: this.hardenBrokerBase,
          [READONLY_FILE_FIELD]: this.readonlyFileNameBase,
          [MAX_READONLY_ENTRIES_FIELD]: this.maxReadOnlyEntriesBase,
          [MAX_GRANTS_FIELD]: this.maxGrantsBase,
          [ALLOW_REQUESTS_FIELD]: this.allowRequestsBase,
        },
      })
      this.settingsOwner = owner
      owner.watch(() => this.invalidate())
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
          const policy = this.resolve({ session })
          const patterns = this.currentReadOnlyText(policy.workspaceRoot).trim()
          const parts: string[] = []
          if (patterns.length > 0) {
            parts.push(`Write-protected patterns (gitignore semantics; all DSH-enforced operations deny writes beneath matching paths; reads stay allowed): ${JSON.stringify(patterns)}.`)
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
            parts.push(`Session write grants that bypass write protection for the write/edit tools (sandboxed commands still see the read-only mount): ${JSON.stringify(overrides)}.`)
          }
          if (this.currentLimits().allowWritableRequests) {
            parts.push(`Extra write access is not granted by default: call ${JSON.stringify(REQUEST_WRITABLE_PATH_TOOL)} with a path and a one-sentence justification when a write was denied by write protection or the task needs a path outside the workspace. The user decides in an approval prompt, and the grant lasts only for this session.`)
          } else {
            parts.push('Extra write access is not granted by this deployment: do not ask for it, and treat denied writes as final.')
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
        resolve: sessionId => this.resolveForSession(sessionId ?? ''),
        currentProtectedPaths: sessionId => this.resolveForSession(sessionId ?? '').readOnlyPaths ?? [],
        maxGrants: () => this.currentLimits().maxGrants,
        rulesFilePath: workspaceRoot => this.rulesFilePath(workspaceRoot),
        allowRequests: () => this.currentLimits().allowWritableRequests,
      }
      registerRequestWritablePath(scope, this.grants, host)
    })

    ctx.inject(['connection'], (scope: Context) => {
      const connection = (scope as Context & { connection: PreviewConnection }).connection
      // 部署回退根: 请求体没带当前会话 cwd 时才用.
      scope.effect(
        () => mountPreviewRoute(connection, this.workspaceRoot, this),
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

  /** 预览用: 按会话 id 回查它最近一次解析出来的工作区根. */
  workspaceRootOfSession(sessionId: string): string | undefined {
    return this.sessionRoots.get(sessionId)
  }

  /**
   * 按会话 id 取回工作区根, 缺失时回退部署根并记下 (审批工具在会话第一次
   * 解析之前就调用的兜底路径).
   */
  private workspaceRootForSession(sessionId: string): string {
    const remembered = this.sessionRoots.get(sessionId)
    if (remembered !== undefined) return remembered
    this.rememberSession(sessionId, this.workspaceRoot)
    return this.workspaceRoot
  }

  /** 当前生效的规则文件条目上限, 会话授权上限与可写申请开关. */
  private currentLimits(): ResolvedConfigValues {
    const section = this.settingsOwner?.get()
    const fileName = section?.[READONLY_FILE_FIELD]
    const maxEntries = section?.[MAX_READONLY_ENTRIES_FIELD]
    const maxGrants = section?.[MAX_GRANTS_FIELD]
    const allowRequests = section?.[ALLOW_REQUESTS_FIELD]
    return {
      readonlyFileName: this.warnAboutFileName(typeof fileName === 'string' ? fileName : this.readonlyFileNameBase),
      maxReadOnlyEntries: this.positiveLimit(typeof maxEntries === 'number' ? maxEntries : this.maxReadOnlyEntriesBase, DEFAULT_MAX_READONLY_ENTRIES, 'maxReadOnlyEntries'),
      maxGrants: this.positiveLimit(typeof maxGrants === 'number' ? maxGrants : this.maxGrantsBase, DEFAULT_MAX_GRANTS, 'maxGrants'),
      allowWritableRequests: typeof allowRequests === 'boolean' ? allowRequests : this.allowRequestsBase,
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

  /** 设置 / 授权 / 规则文件变化后作废展开缓存. */
  private invalidate(): void {
    this.cache = { ...this.cache, at: 0, key: '' }
  }

  /**
   * 解析一次调用的完整生效文本: 设置页文本, 规则文件文本, 本会话授权, 以及
   * 合并后的可写文本; 按 key 做 TTL 缓存. 展开告警对每条只告警一次.
   */
  private snapshot(workspaceRoot: string, sessionId: string | undefined): PolicySnapshot {
    const settingsText = this.currentText()
    const writableSettingsText = this.currentWritableText()
    const file = this.readOnlyFileAt(workspaceRoot)
    const readOnlyPatterns = mergeReadOnlyText(settingsText, file.text)
    const record = sessionId === undefined ? { extraRoots: [], overrides: [], grants: [] } : this.grants.recordOf(sessionId)
    const writableText = [...record.extraRoots, writableSettingsText].filter(line => line.trim().length > 0).join('\n')
    const key = [settingsText, file.text, writableText, record.overrides.join('\n'), workspaceRoot].join('\u0000')
    const now = Date.now()
    if (now - this.cache.at < EXPAND_TTL_MS && this.cache.key === key) {
      return {
        readOnlyPatterns: this.cache.readOnlyPatterns,
        readOnlyFilePatterns: this.cache.readOnlyFilePatterns,
        readOnly: this.cache.readOnly,
        writable: this.cache.writable,
        overrides: this.cache.overrides,
        file: this.cache.file,
      }
    }
    const readOnly = expandReadOnlyPaths(readOnlyPatterns, workspaceRoot)
    const writable = expandWritablePaths(writableText, workspaceRoot)
    for (const warning of [...readOnly.warnings, ...writable.warnings]) {
      this.warn(warning)
    }
    this.cache = {
      at: now,
      key,
      readOnly: readOnly.paths,
      writable: writable.paths,
      overrides: record.overrides,
      readOnlyPatterns,
      readOnlyFilePatterns: file.text,
      file,
    }
    return {
      readOnlyPatterns,
      readOnlyFilePatterns: file.text,
      readOnly: readOnly.paths,
      writable: writable.paths,
      overrides: record.overrides,
      file,
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
   * @param request - 可选的会话与已批准的模式覆盖.
   * @returns 带有 `readOnlyPatterns` / `readOnlyPaths` / `writablePaths` /
   * `writableOverrides` / `hardenBroker` 的完整逐次调用 policy.
   */
  override resolve(request: Parameters<SandboxPolicyService['resolve']>[0] = {}): SandboxExecutionPolicy {
    const policy = super.resolve(request)
    const sessionId = request.session?.id
    const snapshot = this.snapshot(policy.workspaceRoot, sessionId)
    policy.readOnlyPatterns = snapshot.readOnlyPatterns
    policy.readOnlyPaths = snapshot.readOnly
    policy.readOnlyFilePatterns = snapshot.readOnlyFilePatterns
    policy.writablePaths = snapshot.writable
    policy.writableOverrides = snapshot.overrides
    policy.writableGrants = sessionId === undefined
      ? []
      : this.grants.recordOf(sessionId).grants.map(grant => grant.path)
    policy.rulesFilePath = this.rulesFilePath(policy.workspaceRoot)
    policy.hardenBroker = this.currentHardenBroker()
    if (sessionId !== undefined) this.rememberSession(sessionId, policy.workspaceRoot)
    return policy
  }

  /**
   * 按会话 id 解析一次 policy: 给只拿得到会话 id 的消费方 (审批工具) 用. 工作区
   * 根取该会话最近一次解析出来的那一份, 因此与围栏看到的 policy 是同一个根;
   * 会话对象本身拿不到, 因此不再走官方 resolve 的会话分支 (模式回落到部署默认).
   * @param sessionId - 目标会话 id.
   */
  resolveForSession(sessionId: string): SandboxExecutionPolicy {
    const policy = this.resolve()
    const workspaceRoot = this.workspaceRootForSession(sessionId)
    const snapshot = this.snapshot(workspaceRoot, sessionId)
    return {
      ...policy,
      workspaceRoot,
      sessionId: sessionId as SandboxExecutionPolicy['sessionId'],
      readOnlyPatterns: snapshot.readOnlyPatterns,
      readOnlyPaths: snapshot.readOnly,
      readOnlyFilePatterns: snapshot.readOnlyFilePatterns,
      writablePaths: snapshot.writable,
      writableOverrides: snapshot.overrides,
      writableGrants: this.grants.recordOf(sessionId).grants.map(grant => grant.path),
      rulesFilePath: this.rulesFilePath(workspaceRoot),
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

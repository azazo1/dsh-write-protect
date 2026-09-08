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
import { DEFAULT_READ_ONLY_PATHS, DEFAULT_WRITABLE_PATHS, PATTERNS_FIELD, PLUGIN_ID, PROMPT_CONTEXT_ORDER, WRITABLE_FIELD } from './constants.ts'
import { expandReadOnlyPaths, expandWritablePaths } from './patterns.ts'
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
}

/** 展开结果的缓存有效时长: resolve 每个 tool call 都会调用, glob 枚举有 IO 成本. */
const EXPAND_TTL_MS = 5000

export class WriteProtectPolicyService extends SandboxPolicyService {
  // 内联 schema 调用: config catalog 会静态遍历 `static Config`.
  static Config = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    workspaceRoot: z.string(),
    readOnlyPaths: z.array(z.string()).default([...DEFAULT_READ_ONLY_PATHS]),
    writablePaths: z.array(z.string()).default([...DEFAULT_WRITABLE_PATHS]),
  })

  private readonly baseEntries: readonly string[]
  private readonly writableBaseEntries: readonly string[]
  private settingsOwner: SettingsScope<Record<typeof PATTERNS_FIELD | typeof WRITABLE_FIELD, string>> | undefined
  private cache: { at: number, key: string, readOnly: readonly string[], writable: readonly string[] } = {
    at: 0,
    key: '',
    readOnly: [],
    writable: [],
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

    // Web 设置页的持久化配置: composition base 是 patch 的数组, 用户保存过
    // 的文本覆盖对应字段; 编辑后缓存失效实时生效.
    ctx.inject(['settings'], (scope: Context) => {
      const owner = scope.settings.register(PLUGIN_ID, WriteProtectSettingsSchema, {
        base: { [PATTERNS_FIELD]: this.baseText(), [WRITABLE_FIELD]: this.writableBaseText() },
      })
      this.settingsOwner = owner
      owner.watch(() => {
        this.cache = { at: 0, key: '', readOnly: [], writable: [] }
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
          const { readOnly, writable } = this.snapshot(this.resolve({ session }).workspaceRoot)
          const parts: string[] = []
          if (readOnly.length > 0) {
            parts.push(`Write-protected paths (all DSH-enforced operations deny writes beneath them; reads stay allowed): ${JSON.stringify(readOnly)}.`)
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

  /**
   * 展开当前生效文本为 canonical 保护路径与额外可写根, 按
   * (两份文本, 工作区根) 做 TTL 缓存. 展开告警对每条只告警一次.
   */
  private snapshot(workspaceRoot: string): { readOnly: readonly string[], writable: readonly string[] } {
    const readOnlyText = this.currentText()
    const writableText = this.currentWritableText()
    const key = `${readOnlyText}\u0000${writableText}\u0000${workspaceRoot}`
    const now = Date.now()
    if (now - this.cache.at < EXPAND_TTL_MS && this.cache.key === key) {
      return { readOnly: this.cache.readOnly, writable: this.cache.writable }
    }
    const readOnly = expandReadOnlyPaths(readOnlyText, workspaceRoot)
    const writable = expandWritablePaths(writableText, workspaceRoot)
    for (const warning of [...readOnly.warnings, ...writable.warnings]) {
      if (!this.warned.has(warning)) {
        this.warned.add(warning)
        this.ctx.logger?.warn?.(`dsh-write-protect: ${warning}`)
      }
    }
    this.cache = { at: now, key, readOnly: readOnly.paths, writable: writable.paths }
    return { readOnly: readOnly.paths, writable: writable.paths }
  }

  /**
   * 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
   * 追加注入解析后的保护路径与额外可写根.
   * @param request - 可选的会话与已批准的模式覆盖.
   * @returns 带有 `readOnlyPaths` 与 `writablePaths` 的完整逐次调用 policy.
   */
  override resolve(request: Parameters<SandboxPolicyService['resolve']>[0] = {}): SandboxExecutionPolicy {
    const policy = super.resolve(request)
    const { readOnly, writable } = this.snapshot(policy.workspaceRoot)
    policy.readOnlyPaths = readOnly
    policy.writablePaths = writable
    return policy
  }
}

/** settings namespace 的 schema: 两份多行文本, 未编辑时为 undefined (走 base). */
const WriteProtectSettingsSchema = z.object({
  [PATTERNS_FIELD]: z.string(),
  [WRITABLE_FIELD]: z.string(),
})

export default WriteProtectPolicyService

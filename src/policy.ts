/**
 * 替换 base 的 `sandbox-policy` 行: 在官方 `SandboxPolicyService` 之上增加
 * `readOnlyPaths` — 保护路径以 gitignore 语义的多行文本声明 (见
 * `patterns.ts`), 来源按优先级取值: Web 设置页编辑过的用户配置 (settings
 * namespace 的 patterns 字段) 覆盖 patch 配置的 `readOnlyPaths` 数组 (部署
 * base). 解析结果带 TTL 缓存, 每次 resolve() 注入逐次调用的 policy, 作为
 * fs 围栏与进程沙箱 provider 共同消费的单一事实来源; 同时注册一个
 * systemPrompt context, 让模型在写入之前就知道哪些路径受保护.
 * @module dsh-write-protect/policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DEFAULT_READ_ONLY_PATHS, PATTERNS_FIELD, PLUGIN_ID, PROMPT_CONTEXT_ORDER } from './constants.ts'
import { expandReadOnlyPaths } from './patterns.ts'

export const name = 'dsh-write-protect-policy'

/** 插件配置: 官方 policy 的部署字段原样保留, 外加保护路径部署 base. */
export interface Config {
  /** 会话启动时的文件沙箱模式 (缺省 `read-only`, 与官方一致). */
  mode?: SandboxMode
  /** 无会话调用与会话没有 cwd 时的回退工作区根 (缺省 `process.cwd()`). */
  workspaceRoot?: string
  /**
   * 受保护路径部署 base (数组形态). 用户在 Web 设置页保存过 patterns 文本后
   * 该数组不再生效; 未编辑时数组逐行合并为生效文本.
   */
  readOnlyPaths?: string[]
}

/** 展开结果的缓存有效时长: resolve 每个 tool call 都会调用, glob 枚举有 IO 成本. */
const EXPAND_TTL_MS = 5000

export class WriteProtectPolicyService extends SandboxPolicyService {
  // 内联 schema 调用: config catalog 会静态遍历 `static Config`.
  static Config = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    workspaceRoot: z.string(),
    readOnlyPaths: z.array(z.string()).default([...DEFAULT_READ_ONLY_PATHS]),
  })

  private readonly baseEntries: readonly string[]
  private settingsOwner: SettingsScope<Record<typeof PATTERNS_FIELD, string>> | undefined
  private cache: { at: number, key: string, paths: readonly string[] } = { at: 0, key: '', paths: [] }
  private readonly warned = new Set<string>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const entries = config.readOnlyPaths ?? []
    for (const entry of entries) {
      if (entry.trim().length === 0) {
        throw new Error('dsh-write-protect: readOnlyPaths entries must be non-empty strings')
      }
    }
    this.baseEntries = entries

    // Web 设置页的持久化配置: composition base 是 patch 的 readOnlyPaths,
    // 用户保存过的 patterns 文本覆盖它; 编辑后缓存失效实时生效.
    ctx.inject(['settings'], (scope: Context) => {
      const owner = scope.settings.register(PLUGIN_ID, WriteProtectSettingsSchema, {
        base: { [PATTERNS_FIELD]: this.baseText() },
      })
      this.settingsOwner = owner
      owner.watch(() => {
        this.cache = { at: 0, key: '', paths: [] }
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
          const paths = this.expanded(this.resolve({ session }).workspaceRoot)
          if (paths.length === 0) return ''
          return `Write-protected paths (all DSH-enforced operations deny writes beneath them; reads stay allowed): ${JSON.stringify(paths)}.`
        },
      })
    })
  }

  /** 部署 base 的文本形态 (patch 数组逐行合并). */
  private baseText(): string {
    return this.baseEntries.join('\n')
  }

  /** 当前生效文本: 用户在设置页保存过的 patterns 覆盖部署 base. */
  private currentText(): string {
    const value = this.settingsOwner?.get()?.[PATTERNS_FIELD]
    return typeof value === 'string' ? value : this.baseText()
  }

  /**
   * 展开当前生效文本为 canonical 保护路径, 按 (文本, 工作区根) 做 TTL 缓存.
   * 展开告警 (如 glob 遍历预算耗尽) 对每条只告警一次.
   */
  private expanded(workspaceRoot: string): readonly string[] {
    const text = this.currentText()
    const key = `${text}\u0000${workspaceRoot}`
    const now = Date.now()
    if (now - this.cache.at < EXPAND_TTL_MS && this.cache.key === key) return this.cache.paths
    const { paths, warnings } = expandReadOnlyPaths(text, workspaceRoot)
    for (const warning of warnings) {
      if (!this.warned.has(warning)) {
        this.warned.add(warning)
        this.ctx.logger?.warn?.(`dsh-write-protect: ${warning}`)
      }
    }
    this.cache = { at: now, key, paths }
    return paths
  }

  /**
   * 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
   * 追加注入解析后的保护路径.
   * @param request - 可选的会话与已批准的模式覆盖.
   * @returns 带有 `readOnlyPaths` 的完整逐次调用 policy.
   */
  override resolve(request: Parameters<SandboxPolicyService['resolve']>[0] = {}): SandboxExecutionPolicy {
    const policy = super.resolve(request)
    policy.readOnlyPaths = this.expanded(policy.workspaceRoot)
    return policy
  }
}

/** settings namespace 的 schema: patterns 是多行文本, 未编辑时为 undefined (走 base). */
const WriteProtectSettingsSchema = z.object({
  [PATTERNS_FIELD]: z.string(),
})

export default WriteProtectPolicyService

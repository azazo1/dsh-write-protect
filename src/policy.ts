/**
 * 替换 base 的 `sandbox-policy` 行: 在官方 `SandboxPolicyService` 之上增加
 * `readOnlyPaths` — 每次 resolve() 时把配置项解析为 canonical 路径并注入
 * 逐次调用的 policy, 作为 fs 围栏与进程沙箱 provider 共同消费的单一事实来源;
 * 同时注册一个 systemPrompt context, 让模型在写入之前就知道哪些路径受保护,
 * 避免反复撞墙.
 * @module dsh-write-protect/policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DEFAULT_READ_ONLY_PATHS, PROMPT_CONTEXT_ORDER, resolveReadOnlyPaths } from './shared.ts'

export const name = 'dsh-write-protect-policy'

/** 插件配置: 官方 policy 的部署字段原样保留, 外加保护路径配置项. */
export interface Config {
  /** 会话启动时的文件沙箱模式 (缺省 `read-only`, 与官方一致). */
  mode?: SandboxMode
  /** 无会话调用与会话没有 cwd 时的回退工作区根 (缺省 `process.cwd()`). */
  workspaceRoot?: string
  /**
   * 受保护路径配置项: 相对路径相对会话工作区根解析, 绝对路径原样使用;
   * 空白项在加载时报错.
   */
  readOnlyPaths?: string[]
}

export class WriteProtectPolicyService extends SandboxPolicyService {
  // 内联 schema 调用: config catalog 会静态遍历 `static Config`.
  static Config = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    workspaceRoot: z.string(),
    readOnlyPaths: z.array(z.string()).default([...DEFAULT_READ_ONLY_PATHS]),
  })

  private readonly entries: readonly string[]

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const entries = config.readOnlyPaths ?? []
    for (const entry of entries) {
      if (entry.trim().length === 0) {
        throw new Error('dsh-write-protect: readOnlyPaths entries must be non-empty strings')
      }
    }
    this.entries = entries

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
          const paths = resolveReadOnlyPaths(this.entries, this.resolve({ session }).workspaceRoot)
          if (paths.length === 0) return ''
          return `Write-protected paths (all DSH-enforced operations deny writes beneath them; reads stay allowed): ${JSON.stringify(paths)}.`
        },
      })
    })
  }

  /**
   * 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
   * 追加注入解析后的保护路径.
   * @param request - 可选的会话与已批准的模式覆盖.
   * @returns 带有 `readOnlyPaths` 的完整逐次调用 policy.
   */
  override resolve(request: Parameters<SandboxPolicyService['resolve']>[0] = {}): SandboxExecutionPolicy {
    const policy = super.resolve(request)
    policy.readOnlyPaths = resolveReadOnlyPaths(this.entries, policy.workspaceRoot)
    return policy
  }
}

export default WriteProtectPolicyService

/**
 * 撤回通知: 用户撤回一条本会话授权之后, 把这件事作为一条模型可见的消息投进会话.
 *
 * 为什么不是只靠系统提示词: 提示词里那份清单是**状态** ("现在能写哪几处"), 授权
 * 被撤回后它自己就变了, 但模型从中看不出**是谁在什么时候撤的**; 它也可能正在一次
 * turn 中途按旧快照继续往那里写, 撞上拒绝之后开始瞎试. 这条消息补的是**事件**
 * 那一半: 明确告诉模型"用户撤回的是这条, 现在那里重新受保护".
 *
 * 投递走 `agent.inject` 而不是 `agent.steer`: 排进模型下一步, 空闲时不唤醒会话
 * (不替用户烧 token). 消息本身以 `user/message` 写进会话日志, 因此 dsh 重启、
 * 同一会话恢复之后模型照样看得到 —— 这正是"重启后知晓"的全部实现, 不需要任何
 * 落盘记录 (新建会话本来就没有历史授权可谈).
 * @module dsh-write-protect/grant-notice
 */

import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Grant } from './request-writable-path.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * 本插件投给模型的事件性通知. 归到 `notice` 形态: 一次性事件, 不覆盖任何
     * 旧快照, 轨迹里按一行说明展开.
     */
    'write-protect': {
      readonly kind: 'write-protect'
      readonly form: 'notice'
      /** 不展开就能读到的一行说明 (用户可见, 因此与插件界面同为中文). */
      readonly summary: string
    }
  }
}

/** 通知投递结果: `queued` 表示已排进该会话; `no-session` 表示它当前没有活着的 agent. */
export type GrantNoticeOutcome = 'queued' | 'no-session'

/** `agents` 服务的取用形状: 按会话 id 找 live agent, 只用到它的 `inject`. */
export interface WriteProtectAgents {
  get(id: string): { inject(message: UserMessage): void } | undefined
}

/**
 * 从 host 上下文取 `agents` 服务 (可能缺席, 例如极简组合或单测).
 *
 * 取用形状刻意收窄到 `get()` + `inject()`: 本模块只需要"按会话 id 投一条消息",
 * 不引入 agent 包的完整类型.
 * @param ctx - Host 上下文.
 * @returns 可用的 agents 端口, 组合里没有该服务时为 undefined.
 */
export function agentsPortOf(ctx: Context): WriteProtectAgents | undefined {
  return ctx.get('agents') as unknown as WriteProtectAgents | undefined
}

/** 两类授权被撤回之后各自要说明的后果. */
const CONSEQUENCE: Record<Grant['kind'], string> = {
  override: 'It had overridden write protection inside the session workspace; that protection applies again, so the write/edit tools and sandboxed commands deny writes beneath it.',
  'extra-root': 'It had made that path writable while it is outside the session workspace; writes beneath it are denied again.',
}

/**
 * 撤回通知的正文 (模型可见).
 * @param grant - 被撤回的授权.
 * @returns 一段纯文本.
 */
export function grantRevokedText(grant: Grant): string {
  return [
    `The user withdrew the session write grant on "${grant.path}" from the session's write-access panel.`,
    CONSEQUENCE[grant.kind],
    'Do not retry those writes while it stays withdrawn; if the work truly needs access again, ask the user with request_writable_path.',
  ].join(' ')
}

/** 撤回通知在轨迹里的一行说明. */
export function grantRevokedSummary(grant: Grant): string {
  return boundContextSummary(`撤回写入授权: ${grant.path}`)
}

/**
 * 把一条撤回通知投进会话.
 * @param agents - agents 服务端口; 缺省表示该组合没有这个服务.
 * @param sessionId - 目标会话 id.
 * @param grant - 被撤回的授权.
 * @returns 投递结果.
 */
export function notifyGrantRevoked(
  agents: WriteProtectAgents | undefined,
  sessionId: string,
  grant: Grant,
): GrantNoticeOutcome {
  const agent = agents?.get(sessionId)
  if (agent === undefined) return 'no-session'
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: grantRevokedText(grant) }],
    source: { kind: 'write-protect', form: 'notice', summary: grantRevokedSummary(grant) },
  }))
  return 'queued'
}

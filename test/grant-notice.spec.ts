// grant-notice: 撤回之后投给会话的那条消息.
//
// 断言的是"投给了谁, 以什么身份, 说了什么": 消息必须带本插件自己的 source kind 与
// notice 形态 (轨迹里按事件行展开), 正文要点到被撤回的路径并指回 request_writable_path,
// 没有 live agent 时如实报告没有投出去.

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentsPortOf, grantRevokedText, notifyGrantRevoked, type WriteProtectAgents } from '../src/grant-notice.ts'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

interface Injected {
  readonly sessionId: string
  readonly message: UserMessage
}

/** agents 替身: 只有 session-1 有活着的 agent. */
function fakeAgents(): WriteProtectAgents & { injected: Injected[] } {
  const injected: Injected[] = []
  return {
    injected,
    get: (id) => id === 'session-1' ? { inject: (message) => { injected.push({ sessionId: id, message }) } } : undefined,
  }
}

/** 取消息里的文本: 撤回通知是单段纯文本. */
function textOf(message: UserMessage): string {
  return message.content.map(part => part.type === 'text' ? part.text : '').join('')
}

describe('grantRevokedText', () => {
  it('说明撤回, 后果与下一步该怎么做', () => {
    const text = grantRevokedText({ path: '/ws/protected', kind: 'override' })
    expect(text).toContain('"/ws/protected"')
    expect(text).toContain('protection applies again')
    expect(text).toContain('request_writable_path')
  })

  it('工作区外的额外可写根说清它本来在工作区之外', () => {
    expect(grantRevokedText({ path: '/tmp/scratch', kind: 'extra-root' })).toContain('outside the session workspace')
  })
})

describe('notifyGrantRevoked', () => {
  it('把通知投给目标会话, 并带上本插件的 notice 来源', () => {
    const agents = fakeAgents()
    expect(notifyGrantRevoked(agents, 'session-1', { path: '/ws/protected', kind: 'override' })).toBe('queued')
    expect(agents.injected).toHaveLength(1)
    const { sessionId, message } = agents.injected[0]!
    expect(sessionId).toBe('session-1')
    expect(message.role).toBe('user')
    expect(textOf(message)).toContain('/ws/protected')
    expect(message.source).toMatchObject({ kind: 'write-protect', form: 'notice' })
    expect((message.source as { summary: string }).summary).toContain('/ws/protected')
  })

  it('目标会话没有活着的 agent 时报告 no-session, 什么都不投', () => {
    const agents = fakeAgents()
    expect(notifyGrantRevoked(agents, 'session-2', { path: '/ws/x', kind: 'override' })).toBe('no-session')
    expect(agents.injected).toEqual([])
    expect(notifyGrantRevoked(undefined, 'session-1', { path: '/ws/x', kind: 'override' })).toBe('no-session')
  })
})

describe('agentsPortOf', () => {
  it('组合里有 agents 服务时可用, 没有时为 undefined', () => {
    const agents = fakeAgents()
    const withAgents = new Context()
    withAgents.provide('agents', agents)
    expect(agentsPortOf(withAgents)?.get('session-1')).toBeDefined()
    expect(agentsPortOf(new Context())).toBeUndefined()
  })
})

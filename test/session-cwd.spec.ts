// sessionCwdOf: 设置页预览从 client sessions store 取当前会话 cwd.

import { describe, expect, it } from 'vitest'
import { sessionCwdOf, type SessionsLike } from '../src/client/session-cwd.ts'

function sessions(snap: { current?: string, byId?: Record<string, { cwd?: string, parentId?: string }> }): SessionsLike {
  return { list: { getSnapshot: () => snap } }
}

describe('sessionCwdOf', () => {
  it('没有 sessions 或没有选中会话时返回 undefined', () => {
    expect(sessionCwdOf(undefined)).toBeUndefined()
    expect(sessionCwdOf({})).toBeUndefined()
    expect(sessionCwdOf(sessions({ byId: { a: { cwd: '/ws' } } }))).toBeUndefined()
  })

  it('返回当前会话的 cwd', () => {
    expect(sessionCwdOf(sessions({
      current: 's1',
      byId: { s1: { cwd: '/Users/me/project' } },
    }))).toBe('/Users/me/project')
  })

  it('当前会话没有 cwd 时沿 parentId 向上找', () => {
    expect(sessionCwdOf(sessions({
      current: 'child',
      byId: {
        child: { parentId: 'parent' },
        parent: { cwd: '/ws/app' },
      },
    }))).toBe('/ws/app')
  })

  it('空 cwd 不算, 继续向上', () => {
    expect(sessionCwdOf(sessions({
      current: 'child',
      byId: {
        child: { cwd: '   ', parentId: 'parent' },
        parent: { cwd: '/ws' },
      },
    }))).toBe('/ws')
  })

  it('整条链都没有 cwd 时返回 undefined', () => {
    expect(sessionCwdOf(sessions({
      current: 'child',
      byId: {
        child: { parentId: 'parent' },
        parent: {},
      },
    }))).toBeUndefined()
  })
})

// sessionCwdOf / sessionCwdById: 设置页预览要当前选中会话的 cwd, 会话区的写入
// 权限 tab 要它自己那条会话的 cwd.

import { describe, expect, it } from 'vitest'
import { sessionCwdById, sessionCwdOf, type SessionListRow, type SessionsLike } from '../src/client/session-cwd.ts'

/** 被主视图持有的行 (界面上当前选中的会话). */
function mainView(row: SessionListRow): SessionListRow {
  return { ...row, retainedBy: { mainView: 1 } }
}

function sessions(byId: Record<string, SessionListRow>): SessionsLike {
  return { list: { getSnapshot: () => ({ byId }) } }
}

describe('sessionCwdOf', () => {
  it('没有 sessions 服务时返回 undefined', () => {
    expect(sessionCwdOf(undefined)).toBeUndefined()
    expect(sessionCwdOf({})).toBeUndefined()
    expect(sessionCwdOf({ list: { getSnapshot: () => ({}) } })).toBeUndefined()
  })

  it('没有被主视图持有的会话时返回 undefined', () => {
    expect(sessionCwdOf(sessions({ s1: { cwd: '/ws' } }))).toBeUndefined()
    expect(sessionCwdOf(sessions({ s1: { cwd: '/ws', retainedBy: { workspaceOperation: 1 } } }))).toBeUndefined()
    expect(sessionCwdOf(sessions({ s1: { cwd: '/ws', retainedBy: { mainView: 0 } } }))).toBeUndefined()
  })

  it('返回当前选中会话的 cwd, 不被别的会话干扰', () => {
    expect(sessionCwdOf(sessions({
      other: { cwd: '/ws/other' },
      s1: mainView({ cwd: '/Users/me/project' }),
    }))).toBe('/Users/me/project')
  })

  it('当前会话没有 cwd 时沿 parentId 向上找', () => {
    expect(sessionCwdOf(sessions({
      child: mainView({ parentId: 'parent' }),
      parent: { cwd: '/ws/app' },
    }))).toBe('/ws/app')
  })

  it('空 cwd 不算, 继续向上', () => {
    expect(sessionCwdOf(sessions({
      child: mainView({ cwd: '   ', parentId: 'parent' }),
      parent: { cwd: '/ws' },
    }))).toBe('/ws')
  })

  it('整条链都没有 cwd 时返回 undefined', () => {
    expect(sessionCwdOf(sessions({
      child: mainView({ parentId: 'parent' }),
      parent: {},
    }))).toBeUndefined()
  })
})

describe('sessionCwdById', () => {
  it('按 id 取 cwd, 不管它有没有被主视图持有', () => {
    expect(sessionCwdById(sessions({
      other: mainView({ cwd: '/ws/other' }),
      child: { cwd: '/ws/child' },
    }), 'child')).toBe('/ws/child')
  })

  it('该会话没有 cwd 时沿 parentId 向上找 (子 agent 的情形)', () => {
    expect(sessionCwdById(sessions({
      child: { parentId: 'parent' },
      parent: { cwd: '/ws/app' },
    }), 'child')).toBe('/ws/app')
  })

  it('没有 sessions 服务或 id 不给 / 查不到时返回 undefined', () => {
    expect(sessionCwdById(undefined, 's1')).toBeUndefined()
    expect(sessionCwdById(sessions({ s1: { cwd: '/ws' } }), undefined)).toBeUndefined()
    expect(sessionCwdById(sessions({ s1: { cwd: '/ws' } }), '')).toBeUndefined()
    expect(sessionCwdById(sessions({ s1: { cwd: '/ws' } }), 'missing')).toBeUndefined()
  })
})

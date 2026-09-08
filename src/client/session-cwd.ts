/**
 * 从 client sessions store 取当前会话 cwd. 子会话沿 parentId 向上找,
 * 因为子 agent 的摘要不一定自带 cwd, 执法却仍相对父会话工作区.
 * @module dsh-write-protect/client/session-cwd
 */

/** sessions.list 快照的最小形状, 避免耦合 session-controller 的类型导出. */
export interface SessionListSnap {
  current?: string
  byId?: Record<string, { cwd?: string, parentId?: string } | undefined>
}

/** ctx.sessions 的最小形状. */
export interface SessionsLike {
  list?: { getSnapshot(): SessionListSnap }
}

const PARENT_HOPS = 8

/**
 * 当前选中会话的 cwd; 没有选中会话或整条祖先链都没有 cwd 时返回 undefined.
 * @param sessions - client 的 sessions 服务, 缺省则无法识别.
 */
export function sessionCwdOf(sessions: SessionsLike | undefined): string | undefined {
  const snap = sessions?.list?.getSnapshot?.()
  if (snap === undefined) return undefined
  let id = snap.current
  for (let hop = 0; id !== undefined && hop < PARENT_HOPS; hop += 1) {
    const info = snap.byId?.[id]
    const cwd = typeof info?.cwd === 'string' ? info.cwd.trim() : ''
    if (cwd.length > 0) return cwd
    id = info?.parentId
  }
  return undefined
}

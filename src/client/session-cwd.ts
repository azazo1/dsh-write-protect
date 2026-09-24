/**
 * 从 client sessions store 取当前选中会话的 cwd.
 *
 * sessions store 本身不表达"选中", 选中态由持有方写在列表行的 `retainedBy` 上:
 * 主视图 (workspace navigation) 用 `mainView` 持有当前会话, 所以被 `mainView`
 * 持有的那一行就是界面上正在看的会话 —— 与官方 DocumentTitle / ui-session 的判定
 * 同一个来源.
 *
 * 会话自己没有 cwd 时沿 `parentId` 向上找, 因为子 agent 的摘要不一定自带 cwd,
 * 执法却仍相对父会话工作区.
 * @module dsh-write-protect/client/session-cwd
 */

/** sessions.list 快照里本模块用到的行字段 (避免耦合 session-controller 的类型导出). */
export interface SessionListRow {
  cwd?: string
  parentId?: string
  /** 本地持有计数, 键是持有来源 (例如 mainView). */
  retainedBy?: Readonly<Record<string, number>>
}

/** sessions.list 快照的最小形状. */
export interface SessionListSnap {
  byId?: Record<string, SessionListRow | undefined>
}

/** ctx.sessions 的最小形状. */
export interface SessionsLike {
  list?: { getSnapshot(): SessionListSnap }
}

/** 主视图持有来源的键名: 被它持有时就是当前选中的会话. */
const MAIN_VIEW_SOURCE = 'mainView'

const PARENT_HOPS = 8

/** 快照里主视图持有的会话 id; 没有选中会话时返回 undefined. */
function selectedSessionId(snap: SessionListSnap): string | undefined {
  for (const [id, row] of Object.entries(snap.byId ?? {})) {
    if ((row?.retainedBy?.[MAIN_VIEW_SOURCE] ?? 0) > 0) return id
  }
  return undefined
}

/**
 * 当前选中会话的 cwd; 没有选中会话或整条祖先链都没有 cwd 时返回 undefined.
 * @param sessions - client 的 sessions 服务, 缺省则无法识别.
 */
export function sessionCwdOf(sessions: SessionsLike | undefined): string | undefined {
  const snap = sessions?.list?.getSnapshot?.()
  if (snap === undefined) return undefined
  let id = selectedSessionId(snap)
  for (let hop = 0; id !== undefined && hop < PARENT_HOPS; hop += 1) {
    const info = snap.byId?.[id]
    const cwd = typeof info?.cwd === 'string' ? info.cwd.trim() : ''
    if (cwd.length > 0) return cwd
    id = info?.parentId
  }
  return undefined
}

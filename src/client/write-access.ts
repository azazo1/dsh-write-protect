/**
 * 会话写入权限面板的数据面: 与 Host 的 `/api/dsh-write-protect.grants` 对话,
 * 并校验回来的响应形状. 组件只持有"最近一次结果 + 进行中标记", 取数与写操作全在
 * 这里 (与设置页预览同一个套路: 走 `/api` 鉴权通道, `credentials: same-origin`).
 * @module dsh-write-protect/client/write-access
 */

import {
  GRANTS_PATH,
  type GrantKind,
  type GrantPreview,
  type GrantsAction,
  type GrantsResponse,
} from '../constants.ts'

/** 注入给面板组件的取数与写操作. */
export interface WriteAccessFace {
  /** 读一次该会话当前的授权清单. */
  load(): Promise<GrantsResponse>
  /** 手动加一条本会话的临时授权 (工作区内按保护旁路, 工作区外按额外可写根). */
  add(path: string): Promise<GrantsResponse>
  /** 撤回一条授权; Host 侧同时向该会话投一条通知. */
  revoke(path: string): Promise<GrantsResponse>
}

/** 授权类型的中文名 (面板列表与添加结果都用它). */
export function grantKindLabel(kind: GrantKind): string {
  return kind === 'override' ? '保护旁路' : '额外可写根'
}

function isGrantKind(value: unknown): value is GrantKind {
  return value === 'override' || value === 'extra-root'
}

/** 校验一条授权条目. */
function decodeGrant(value: unknown): GrantPreview | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.path !== 'string' || !isGrantKind(record.kind)) return undefined
  return { path: record.path, kind: record.kind }
}

/**
 * 校验一次响应: 面板只认形状完整的对象, 免得界面把半截数据画成"没有授权".
 * @param payload - 已解析的 JSON.
 * @param status - 用于错误文案的 HTTP 状态码.
 */
function decodeResponse(payload: unknown, status: number): GrantsResponse {
  if (typeof payload !== 'object' || payload === null) throw new Error(`grants request failed (${String(status)}): malformed response`)
  const record = payload as Record<string, unknown>
  if (typeof record.error === 'string') throw new Error(record.error)
  if (typeof record.workspaceRoot !== 'string' || typeof record.mode !== 'string' || !Array.isArray(record.grants)) {
    throw new Error(`grants request failed (${String(status)}): malformed response`)
  }
  const grants = record.grants.map(decodeGrant).filter((grant): grant is GrantPreview => grant !== undefined)
  const notice = record.notice === 'queued' || record.notice === 'no-session' ? record.notice : undefined
  const changed = record.changed
  return {
    workspaceRoot: record.workspaceRoot,
    mode: record.mode,
    maxGrants: typeof record.maxGrants === 'number' ? record.maxGrants : 0,
    grants,
    ...typeof changed === 'object' && changed !== null
      && typeof (changed as Record<string, unknown>).path === 'string'
      && isGrantKind((changed as Record<string, unknown>).kind)
      && ((changed as Record<string, unknown>).action === 'add' || (changed as Record<string, unknown>).action === 'revoke')
      ? {
        changed: {
          path: (changed as { path: string }).path,
          kind: (changed as { kind: GrantKind }).kind,
          action: (changed as { action: 'add' | 'revoke' }).action,
        },
      }
      : {},
    ...notice === undefined ? {} : { notice },
  }
}

/** 发一次面板请求. */
async function requestGrants(
  sessionId: string,
  action: GrantsAction,
  body: { path?: string, cwd?: string },
): Promise<GrantsResponse> {
  const response = await fetch(GRANTS_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      sessionId,
      action,
      ...body.cwd === undefined ? {} : { cwd: body.cwd },
      ...body.path === undefined ? {} : { path: body.path },
    }),
  })
  const text = await response.text()
  if (text.length === 0) throw new Error(`grants request failed (${String(response.status)}, empty body)`)
  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    throw new Error(`grants request failed (${String(response.status)}): ${text.slice(0, 180)}`)
  }
  if (!response.ok) throw new Error(String((payload as { error?: unknown }).error ?? `grants request failed (${String(response.status)})`))
  return decodeResponse(payload, response.status)
}

/**
 * 造一个绑定到某会话的面板数据面.
 * @param sessionId - 目标会话 id.
 * @param cwdOf - 该会话的 cwd 读取函数 (Host 侧靠它定位工作区根).
 */
export function createWriteAccessFace(sessionId: string, cwdOf: () => string | undefined): WriteAccessFace {
  const scope = (): { cwd?: string } => {
    const cwd = cwdOf()
    return cwd === undefined ? {} : { cwd }
  }
  return {
    load: async () => await requestGrants(sessionId, 'list', scope()),
    add: async path => await requestGrants(sessionId, 'add', { path, ...scope() }),
    revoke: async path => await requestGrants(sessionId, 'revoke', { path, ...scope() }),
  }
}

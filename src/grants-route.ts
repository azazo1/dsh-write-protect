/**
 * 会话写入权限面板的入口: 挂在 Connection 的 `/api` Fetch 路由上, 走官方鉴权,
 * 由会话区的 "写入权限" tab 调用. 一次请求一个动作:
 *
 *   - `list`: 列出该会话当前持有的授权 (面板打开 / 刷新);
 *   - `add`: 用户手动把某条路径加成本会话的临时授权 —— 工作区内的按保护旁路
 *     (`override`), 工作区外的按额外可写根 (`extra-root`), 与模型申请批准后的
 *     记录完全同质, 因此同样只活在内存里, 重启即消失;
 *   - `revoke`: 撤回一条授权, 目标重新落回当前的保护判定, 并向该会话投一条
 *     通知消息 (见 `grant-notice.ts`).
 *
 * 这条通道的调用者就是用户本人 (面板里的按钮), 因此不像 `request_writable_path`
 * 那样走审批弹窗; 鉴权由 `/api` 通道本身负责. 路径解析与保护判定复用模型申请那
 * 一套 (`resolveLiteralPath` / `isPathUnder` / 规则文件硬保护), 免得两侧对同一条
 * 路径给出不同结论.
 * @module dsh-write-protect/grants-route
 */

import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { FetchRouteConnection } from './connection.ts'
import {
  GRANTS_PATH,
  type GrantChange,
  type GrantKind,
  type GrantPreview,
  type GrantsRequest,
  type GrantsResponse,
} from './constants.ts'
import { isPathUnder } from './containment.ts'
import type { GrantNoticeOutcome } from './grant-notice.ts'
import { resolveLiteralPath } from './patterns.ts'
import type { Grant, GrantsService } from './request-writable-path.ts'

const MAX_BODY_BYTES = 64 * 1024

/** 面板需要的插件侧信息: 会话 → 工作区根, 当前 policy, 授权上限与撤回通知. */
export interface GrantsPolicyHost {
  /**
   * 会话的工作区根: 已记住的那份, 或请求体带来的 cwd. 两者都没有时为 undefined ——
   * 与可写申请一样不回退部署根 (部署根可能是一棵极大的树).
   * @param sessionId - 目标会话.
   * @param cwd - 会话日志里的 cwd.
   */
  workspaceRootOfSession(sessionId: string, cwd?: string): string | undefined
  /**
   * 解析一次该会话的 policy (取保护模式; 工作区根已按上面那份定死).
   * @param sessionId - 目标会话.
   * @param cwd - 会话日志里的 cwd.
   */
  resolve(sessionId: string, cwd?: string): SandboxExecutionPolicy
  /** 单会话授权条数上限. */
  maxGrants(): number
  /** 当前工作区根的只读规则文件路径 (文件名关闭时为 undefined). */
  rulesFilePath(workspaceRoot: string): string | undefined
  /**
   * 把一条撤回通知投给该会话.
   * @param sessionId - 目标会话.
   * @param grant - 被撤回的授权.
   */
  notifyRevoked(sessionId: string, grant: Grant): GrantNoticeOutcome
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

/** 解析请求体: 会话 id 必须给出, 动作必须在三种之内, add / revoke 必须带路径. */
function decodeRequest(value: unknown): GrantsRequest {
  if (typeof value !== 'object' || value === null) throw new Error('grants body must be an object')
  const record = value as Record<string, unknown>
  const sessionId = record.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new Error('grants body needs a non-empty sessionId')
  }
  const action = record.action
  if (action !== 'list' && action !== 'add' && action !== 'revoke') {
    throw new Error('action must be "list", "add" or "revoke"')
  }
  const cwd = record.cwd
  if (cwd !== undefined && typeof cwd !== 'string') throw new Error('cwd must be a string')
  const path = record.path
  if (path !== undefined && typeof path !== 'string') throw new Error('path must be a string')
  if (action !== 'list' && (path === undefined || path.trim().length === 0)) {
    throw new Error(`action "${action}" needs a non-empty path`)
  }
  return {
    sessionId: sessionId.trim(),
    action,
    ...typeof cwd === 'string' && cwd.trim().length > 0 ? { cwd: cwd.trim() } : {},
    ...path === undefined ? {} : { path },
  }
}

/** 面板要的授权清单. */
function grantPreviews(grants: readonly Grant[]): readonly GrantPreview[] {
  return grants.map(grant => ({ path: grant.path, kind: grant.kind }))
}

/**
 * 组装一次响应: 授权清单始终是最新的, 改动与投递结果按动作附上.
 * @param host - 面板需要的插件侧信息.
 * @param grants - 授权表.
 * @param sessionId - 目标会话.
 * @param policy - 该会话当前的 policy.
 * @param extra - 本次动作的变更与投递结果.
 */
function view(
  host: GrantsPolicyHost,
  grants: GrantsService,
  sessionId: string,
  policy: SandboxExecutionPolicy,
  extra: { changed?: GrantChange, notice?: GrantNoticeOutcome } = {},
): GrantsResponse {
  return {
    workspaceRoot: policy.workspaceRoot,
    mode: policy.mode,
    maxGrants: host.maxGrants(),
    grants: grantPreviews(grants.listOf(sessionId)),
    ...extra.changed === undefined ? {} : { changed: extra.changed },
    ...extra.notice === undefined ? {} : { notice: extra.notice },
  }
}

/**
 * 手动添加一条授权: 与可写申请同一套解析与硬保护规则, 只是不经过审批.
 *
 * 目标落在工作区内时记成保护旁路 —— 用户加它的动机通常正是"放开被保护的目录",
 * 而不是重复声明本来就写得进去的位置; 落在工作区外时记成额外可写根 (与设置页的
 * 额外可写根同一条通道).
 * @param host - 面板需要的插件侧信息.
 * @param grants - 授权表.
 * @param body - 已解析的请求体 (`action: 'add'`).
 * @param workspaceRoot - 会话工作区根.
 * @returns 成功时是响应体, 失败时是错误响应.
 */
async function addGrant(
  host: GrantsPolicyHost,
  grants: GrantsService,
  body: GrantsRequest,
  workspaceRoot: string,
): Promise<Response> {
  const raw = body.path ?? ''
  const resolution = resolveLiteralPath(raw, workspaceRoot)
  // "已经在工作区内"不算拒绝理由: 这里恰恰要受理工作区内的路径 (按保护旁路记录).
  const blocking = resolution.warnings.filter(warning => !warning.includes('already inside the workspace'))
  if (blocking.length > 0) return jsonError(400, `cannot add "${raw}": ${blocking[0]!}`)
  if (resolution.path === undefined) {
    return jsonError(400, `cannot add "${raw}": give an absolute path, or one relative to the session workspace`)
  }
  const target = resolution.path
  const rulesFile = host.rulesFilePath(workspaceRoot)
  if (rulesFile !== undefined && target === rulesFile) {
    return jsonError(400, `"${raw}" is the workspace write-protect rules file, which is read-only by design and cannot be granted`)
  }
  const kind: GrantKind = await isPathUnder(target, workspaceRoot) ? 'override' : 'extra-root'
  const granted = grants.grant(body.sessionId, target, kind)
  if (!granted.ok) return jsonError(400, `cannot add "${target}": ${granted.reason}`)
  return Response.json(view(host, grants, body.sessionId, host.resolve(body.sessionId, body.cwd), {
    changed: { path: target, kind, action: 'add' },
  }))
}

/**
 * 撤回一条授权并通知会话. 路径按面板给的原文精确匹配; 原文对不上时再试一次
 * canonical 形态, 免得调用方多写或少写一个分隔符就撤不掉.
 * @param host - 面板需要的插件侧信息.
 * @param grants - 授权表.
 * @param body - 已解析的请求体 (`action: 'revoke'`).
 * @param workspaceRoot - 会话工作区根.
 * @returns 成功时是响应体, 失败时是错误响应.
 */
function revokeGrant(
  host: GrantsPolicyHost,
  grants: GrantsService,
  body: GrantsRequest,
  workspaceRoot: string,
): Response {
  const raw = (body.path ?? '').trim()
  let outcome = grants.revoke(body.sessionId, raw)
  if (!outcome.ok) {
    const canonical = canonicalPath(raw)
    if (canonical !== raw) outcome = grants.revoke(body.sessionId, canonical)
  }
  if (!outcome.ok) return jsonError(400, `cannot revoke "${raw}": ${outcome.reason}`)
  const notice = host.notifyRevoked(body.sessionId, outcome.removed)
  return Response.json(view(host, grants, body.sessionId, host.resolve(body.sessionId, body.cwd), {
    changed: { path: outcome.removed.path, kind: outcome.removed.kind, action: 'revoke' },
    notice,
  }))
}

/**
 * 注册会话写入权限面板的路由. 返回 disposer, 交给 ctx.effect.
 * @param connection - Host connection 服务.
 * @param grants - 授权表.
 * @param host - 面板需要的插件侧信息.
 */
export function mountGrantsRoute(
  connection: FetchRouteConnection,
  grants: GrantsService,
  host: GrantsPolicyHost,
): () => void {
  const dispose = connection.fetch.register({
    path: GRANTS_PATH,
    methods: ['POST'],
    fetch: async (request) => {
      try {
        const text = await request.text()
        if (text.length > MAX_BODY_BYTES) return jsonError(400, 'grants body too large')
        const body = decodeRequest(JSON.parse(text) as unknown)
        const workspaceRoot = host.workspaceRootOfSession(body.sessionId, body.cwd)
        if (workspaceRoot === undefined) {
          return jsonError(400, `cannot resolve the workspace root of session "${body.sessionId}"; open that session before managing its write grants (no deployment-root fallback)`)
        }
        if (body.action === 'add') return await addGrant(host, grants, body, workspaceRoot)
        if (body.action === 'revoke') return revokeGrant(host, grants, body, workspaceRoot)
        return Response.json(view(host, grants, body.sessionId, host.resolve(body.sessionId, body.cwd)))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return jsonError(400, message)
      }
    },
  })
  return () => {
    void dispose()
  }
}

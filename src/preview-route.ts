/**
 * 设置页预览入口: 挂在 Connection 的 `/api` Fetch 路由上, 走官方鉴权,
 * 避免裸 webServer 路由 401 空 body. POST 当前草稿, 不写 settings.
 * 工作区根优先用请求体里的当前会话 cwd, 缺省才用部署回退根.
 *
 * 预览还会读一次工作区只读规则文件 (按配置的文件名), 并列出本会话已批准的可写
 * 授权: 前者是生效保护路径的一部分来源, 后者解释了为什么某条被保护的路径现在
 * 写得进去. 没有 policy service 时 (单测或极简组合) 这两块按空处理.
 * @module dsh-write-protect/preview-route
 */

import { resolve as resolvePath } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { PREVIEW_PATH } from './constants.ts'
import { previewPaths } from './preview.ts'
import { EMPTY_READ_ONLY_FILE, type ReadOnlyFile } from './readonly-file.ts'
import type { Grant } from './request-writable-path.ts'

const MAX_BODY_BYTES = 256 * 1024

/** Connection.fetch.register 的最小形状. */
export interface PreviewConnection {
  fetch: {
    register(route: {
      path: string
      methods: readonly string[]
      fetch: (request: Request) => Promise<Response>
    }): () => void | Promise<void>
  }
}

/**
 * 预览需要的插件侧信息: 生效的规则文件名与其读取器, 以及按工作区根回查的本会话
 * 授权. 由 policy service 以自身为实参提供.
 */
export interface PreviewPolicyHost {
  /** 当前生效的规则文件名 (空串表示关闭识别). */
  currentReadonlyFileName(): string
  /** 规则文件读取器 (预览要看到刚写入磁盘的内容, 因此走 refresh). */
  readOnlyFileReader(): { refresh(workspaceRoot: string, fileName: string): ReadOnlyFile }
  /** 本会话授权表. */
  grantsView(): {
    recordsForWorkspace(workspaceRoot: string, cwdOf: (sessionId: string) => string | undefined): readonly Grant[]
  }
  /** 按会话 id 回查它的工作区根 (预览请求体只带 cwd, 因此可能查不到). */
  workspaceRootOfSession(sessionId: string): string | undefined
}

function decodeDraft(value: unknown): {
  patterns: string
  writablePatterns: string
  workspaceRoot?: string
} {
  if (typeof value !== 'object' || value === null) throw new Error('preview body must be an object')
  const record = value as Record<string, unknown>
  const patterns = record.patterns
  const writablePatterns = record.writablePatterns
  const workspaceRoot = record.workspaceRoot
  if (patterns !== undefined && typeof patterns !== 'string') throw new Error('patterns must be a string')
  if (writablePatterns !== undefined && typeof writablePatterns !== 'string') {
    throw new Error('writablePatterns must be a string')
  }
  if (workspaceRoot !== undefined && typeof workspaceRoot !== 'string') {
    throw new Error('workspaceRoot must be a string')
  }
  const trimmedRoot = typeof workspaceRoot === 'string' ? workspaceRoot.trim() : ''
  return {
    patterns: typeof patterns === 'string' ? patterns : '',
    writablePatterns: typeof writablePatterns === 'string' ? writablePatterns : '',
    ...trimmedRoot.length > 0 ? { workspaceRoot: trimmedRoot } : {},
  }
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

/** 与官方 sandbox-policy 同一套工作区根规范化: 先解 symlink, 再绝对化. */
function resolvePreviewRoot(path: string): string {
  return resolvePath(canonicalPath(path))
}

/** 读一次规则文件 (走 policy 持有的缓存并按需重读); 没有 host 或关闭识别时为空. */
function readPreviewFile(host: PreviewPolicyHost | undefined, workspaceRoot: string): ReadOnlyFile {
  if (host === undefined) return EMPTY_READ_ONLY_FILE
  const fileName = host.currentReadonlyFileName()
  if (fileName.length === 0) return EMPTY_READ_ONLY_FILE
  return host.readOnlyFileReader().refresh(workspaceRoot, fileName)
}

/**
 * 注册预览 Fetch 路由. 返回 disposer, 交给 ctx.effect.
 * @param connection - Host connection 服务.
 * @param fallbackRoot - 请求未带会话 cwd 时的部署回退根.
 * @param host - 可选的插件侧信息 (规则文件与授权列表); 缺省时这两块按空处理.
 */
export function mountPreviewRoute(
  connection: PreviewConnection,
  fallbackRoot: string,
  host?: PreviewPolicyHost,
): () => void {
  const dispose = connection.fetch.register({
    path: PREVIEW_PATH,
    methods: ['POST'],
    fetch: async (request) => {
      try {
        const text = await request.text()
        if (text.length > MAX_BODY_BYTES) return jsonError(400, 'preview body too large')
        const draft = decodeDraft(JSON.parse(text) as unknown)
        const requestedRoot = draft.workspaceRoot
        const workspaceRoot = requestedRoot === undefined
          ? fallbackRoot
          : resolvePreviewRoot(requestedRoot)
        const grants = host === undefined
          ? []
          : host.grantsView().recordsForWorkspace(workspaceRoot, sessionId => host.workspaceRootOfSession(sessionId))
        return Response.json({
          ...previewPaths(draft.patterns, draft.writablePatterns, workspaceRoot, readPreviewFile(host, workspaceRoot), grants),
          workspaceSource: requestedRoot === undefined ? 'fallback' : 'session',
        })
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

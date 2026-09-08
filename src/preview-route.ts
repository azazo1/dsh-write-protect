/**
 * 设置页预览入口: 挂在 Connection 的 `/api` Fetch 路由上, 走官方鉴权,
 * 避免裸 webServer 路由 401 空 body. POST 当前草稿, 不写 settings.
 * 工作区根优先用请求体里的当前会话 cwd, 缺省才用部署回退根.
 * @module dsh-write-protect/preview-route
 */

import { resolve as resolvePath } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { PREVIEW_PATH } from './constants.ts'
import { previewPaths } from './preview.ts'

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

/**
 * 注册预览 Fetch 路由. 返回 disposer, 交给 ctx.effect.
 * @param connection - Host connection 服务.
 * @param fallbackRoot - 请求未带会话 cwd 时的部署回退根.
 */
export function mountPreviewRoute(
  connection: PreviewConnection,
  fallbackRoot: string,
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
        return Response.json({
          ...previewPaths(draft.patterns, draft.writablePatterns, workspaceRoot),
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

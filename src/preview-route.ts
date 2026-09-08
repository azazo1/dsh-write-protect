/**
 * 设置页预览入口: 挂在 Connection 的 `/api` Fetch 路由上, 走官方鉴权,
 * 避免裸 webServer 路由 401 空 body. POST 当前草稿, 不写 settings.
 * @module dsh-write-protect/preview-route
 */

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

function decodeDraft(value: unknown): { patterns: string, writablePatterns: string } {
  if (typeof value !== 'object' || value === null) throw new Error('preview body must be an object')
  const record = value as Record<string, unknown>
  const patterns = record.patterns
  const writablePatterns = record.writablePatterns
  if (patterns !== undefined && typeof patterns !== 'string') throw new Error('patterns must be a string')
  if (writablePatterns !== undefined && typeof writablePatterns !== 'string') {
    throw new Error('writablePatterns must be a string')
  }
  return {
    patterns: typeof patterns === 'string' ? patterns : '',
    writablePatterns: typeof writablePatterns === 'string' ? writablePatterns : '',
  }
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

/**
 * 注册预览 Fetch 路由. 返回 disposer, 交给 ctx.effect.
 * @param connection - Host connection 服务.
 * @param workspaceRoot - 预览使用的工作区根 (部署回退根).
 */
export function mountPreviewRoute(
  connection: PreviewConnection,
  workspaceRoot: string,
): () => void {
  const dispose = connection.fetch.register({
    path: PREVIEW_PATH,
    methods: ['POST'],
    fetch: async (request) => {
      try {
        const text = await request.text()
        if (text.length > MAX_BODY_BYTES) return jsonError(400, 'preview body too large')
        const draft = decodeDraft(JSON.parse(text) as unknown)
        return Response.json(previewPaths(draft.patterns, draft.writablePatterns, workspaceRoot))
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

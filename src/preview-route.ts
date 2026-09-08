/**
 * 设置页预览的 HTTP 入口: POST 当前草稿, 返回展开结果. 不写 settings.
 * webServer 缺失时不挂载 (单元测试与无 Web 的组合).
 * @module dsh-write-protect/preview-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { PREVIEW_PATH } from './constants.ts'
import { previewPaths } from './preview.ts'

const MAX_BODY_BYTES = 256 * 1024

/** 预览需要的 webServer.register 最小形状. */
export interface PreviewWebServer {
  register(route: {
    kind: 'exact'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 可选的连接鉴权面, 与官方 Web 组合的 requestRejection 对齐. */
export interface PreviewConnection {
  requestRejection?(request: { headers: unknown }): number | undefined
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  })
  response.end(body)
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('preview body too large'))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
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

/**
 * 注册预览路由. 返回 disposer, 交给 ctx.effect.
 * @param webServer - Host webServer 服务.
 * @param workspaceRoot - 预览使用的工作区根 (部署回退根).
 * @param connection - 可选鉴权.
 */
export function mountPreviewRoute(
  webServer: PreviewWebServer,
  workspaceRoot: string,
  connection?: PreviewConnection,
): () => void {
  return webServer.register({
    kind: 'exact',
    path: PREVIEW_PATH,
    async handler(request, response) {
      try {
        const rejection = connection?.requestRejection?.(request)
        if (rejection !== undefined) {
          response.writeHead(rejection)
          response.end()
          return
        }
        if (request.method !== 'POST') {
          writeJson(response, 405, { error: 'POST only' })
          return
        }
        const draft = decodeDraft(JSON.parse(await readBody(request)) as unknown)
        writeJson(response, 200, previewPaths(draft.patterns, draft.writablePatterns, workspaceRoot))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        writeJson(response, 400, { error: message })
      }
    },
  })
}

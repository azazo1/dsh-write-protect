// mountPreviewRoute: 请求体必须带当前会话 cwd. 没有根就直接 400 —— 不回退部署根
// (部署根是进程 cwd, 可能是一棵极大的树, 在那里同步展开会堵住 Host 事件循环).

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { resolve as resolvePath, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PREVIEW_PATH } from '../src/constants.ts'
import { mountPreviewRoute, type PreviewConnection } from '../src/preview-route.ts'
import { projectTmpDir } from './fixture-root.ts'

type Handler = (request: Request) => Promise<Response>

function fakeConnection(): { connection: PreviewConnection, handler: () => Handler } {
  let handler: Handler | undefined
  const connection: PreviewConnection = {
    fetch: {
      register(route) {
        expect(route.path).toBe(PREVIEW_PATH)
        expect(route.methods).toEqual(['POST'])
        handler = route.fetch
        return () => {}
      },
    },
  }
  return {
    connection,
    handler: () => {
      if (handler === undefined) throw new Error('preview route was not registered')
      return handler
    },
  }
}

async function post(handler: Handler, body: unknown): Promise<{ status: number, json: Record<string, unknown> }> {
  const response = await handler(new Request('http://dsh.local/api/dsh-write-protect.preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: response.status, json: await response.json() as Record<string, unknown> }
}

let sessionWs: string

beforeAll(() => {
  sessionWs = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-preview-session-')))
  mkdirSync(join(sessionWs, 'gitdir'))
})

afterAll(() => {
  rmSync(sessionWs, { recursive: true, force: true })
})

describe('mountPreviewRoute', () => {
  it('未带 workspaceRoot 时返回 400, 不回退部署根', async () => {
    const fake = fakeConnection()
    mountPreviewRoute(fake.connection)
    const result = await post(fake.handler(), { patterns: 'gitdir', writablePatterns: '' })
    expect(result.status).toBe(400)
    expect(String(result.json.error)).toContain('session workspace root')
  })

  it('请求体带当前会话 cwd 时按该根展开', async () => {
    const fake = fakeConnection()
    mountPreviewRoute(fake.connection)
    const result = await post(fake.handler(), {
      patterns: 'gitdir',
      writablePatterns: '',
      workspaceRoot: sessionWs,
    })
    expect(result.status).toBe(200)
    expect(result.json.workspaceRoot).toBe(sessionWs)
    expect(result.json.readOnly).toEqual([join(sessionWs, 'gitdir')])
  })

  it('空白 workspaceRoot 视为缺省, 同样 400', async () => {
    const fake = fakeConnection()
    mountPreviewRoute(fake.connection)
    const result = await post(fake.handler(), { patterns: 'gitdir', workspaceRoot: '  ' })
    expect(result.status).toBe(400)
    expect(String(result.json.error)).toContain('session workspace root')
  })

  it('非字符串 workspaceRoot 返回 400', async () => {
    const fake = fakeConnection()
    mountPreviewRoute(fake.connection)
    const result = await post(fake.handler(), { patterns: 'gitdir', workspaceRoot: ['/ws'] })
    expect(result.status).toBe(400)
    expect(result.json.error).toBe('workspaceRoot must be a string')
  })

  it('会话 cwd 会按官方规则规范化', async () => {
    const fake = fakeConnection()
    mountPreviewRoute(fake.connection)
    const result = await post(fake.handler(), {
      patterns: '',
      workspaceRoot: join(sessionWs, '.', 'gitdir', '..'),
    })
    expect(result.status).toBe(200)
    expect(result.json.workspaceRoot).toBe(resolvePath(sessionWs))
  })
})

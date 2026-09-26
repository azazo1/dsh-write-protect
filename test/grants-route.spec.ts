// mountGrantsRoute: 会话写入权限面板的三个动作.
//
// 真实 GrantsService + 替身 host (工作区根 / policy / 授权上限 / 撤回通知): 路由
// 自身那条链路 (请求体校验, 路径解析, 规则文件硬保护, 分类, 清单) 全跑真实代码,
// 只有"哪个会话是哪个工作区"与"通知投给谁"由替身回答 —— 那两件事在真实组合里分别
// 来自 session 事件与 agent runtime.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GRANTS_PATH } from '../src/constants.ts'
import { mountGrantsRoute, type GrantsPolicyHost } from '../src/grants-route.ts'
import type { FetchRouteConnection } from '../src/connection.ts'
import { GrantsService, type Grant } from '../src/request-writable-path.ts'
import { projectTmpDir } from './fixture-root.ts'

type Handler = (request: Request) => Promise<Response>

const SESSION_ID = 'session-1'

interface Fake {
  connection: FetchRouteConnection
  handler: () => Handler
}

function fakeHost(workspaceRoot: string, maxGrants = 8): GrantsPolicyHost & { details: { notified: Grant[] } } {
  const details = { notified: [] as Grant[] }
  return {
    details,
    workspaceRootOfSession: (sessionId) => sessionId === SESSION_ID ? workspaceRoot : undefined,
    resolve: () => ({
      mode: 'workspace-write',
      workspaceRoot,
      sessionId: SESSION_ID,
      readOnlyPaths: [],
      readOnlyPatterns: '',
    }) as never,
    maxGrants: () => maxGrants,
    rulesFilePath: (root) => join(root, '.readonly'),
    notifyRevoked: (_sessionId, grant) => {
      details.notified.push(grant)
      return 'queued'
    },
  }
}

function fakeConnection(): Fake {
  let handler: Handler | undefined
  const connection: FetchRouteConnection = {
    fetch: {
      register(route) {
        expect(route.path).toBe(GRANTS_PATH)
        expect(route.methods).toEqual(['POST'])
        handler = route.fetch
        return () => {}
      },
    },
  }
  return {
    connection,
    handler: () => {
      if (handler === undefined) throw new Error('grants route was not registered')
      return handler
    },
  }
}

async function post(handler: Handler, body: unknown): Promise<{ status: number, json: Record<string, unknown> }> {
  const response = await handler(new Request(`http://dsh.local${GRANTS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: response.status, json: await response.json() as Record<string, unknown> }
}

let base: string
let workspace: string
let outside: string
let grants: GrantsService

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-grants-')))
  workspace = join(base, 'ws')
  outside = join(base, 'outside')
  mkdirSync(join(workspace, 'protected'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  grants = new GrantsService(() => 8, () => {})
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** 起一次路由 + 替身 host, 返回请求入口与 host 记录. */
function mount(): { fake: Fake, host: GrantsPolicyHost & { details: { notified: Grant[] } } } {
  const fake = fakeConnection()
  const host = fakeHost(workspace)
  mountGrantsRoute(fake.connection, grants, host)
  return { fake, host }
}

describe('mountGrantsRoute', () => {
  it('list 返回该会话的授权清单与上限', async () => {
    const { fake } = mount()
    grants.grant(SESSION_ID, outside, 'extra-root')
    const result = await post(fake.handler(), { sessionId: SESSION_ID, action: 'list', cwd: workspace })
    expect(result.status).toBe(200)
    expect(result.json.workspaceRoot).toBe(workspace)
    expect(result.json.mode).toBe('workspace-write')
    expect(result.json.maxGrants).toBe(8)
    expect(result.json.grants).toEqual([{ path: outside, kind: 'extra-root' }])
  })

  it('add 工作区外的路径记成额外可写根', async () => {
    const { fake } = mount()
    const result = await post(fake.handler(), { sessionId: SESSION_ID, action: 'add', path: '../outside', cwd: workspace })
    expect(result.status).toBe(200)
    expect(result.json.changed).toEqual({ path: outside, kind: 'extra-root', action: 'add' })
    expect(grants.listOf(SESSION_ID)).toEqual([{ path: outside, kind: 'extra-root' }])
  })

  it('add 工作区内的路径记成保护旁路', async () => {
    const { fake } = mount()
    const result = await post(fake.handler(), { sessionId: SESSION_ID, action: 'add', path: 'protected', cwd: workspace })
    expect(result.status).toBe(200)
    expect(result.json.changed).toEqual({
      path: join(workspace, 'protected'),
      kind: 'override',
      action: 'add',
    })
    expect(grants.listOf(SESSION_ID)).toEqual([{ path: join(workspace, 'protected'), kind: 'override' }])
  })

  it('add 拒绝通配符与规则文件本身', async () => {
    const { fake } = mount()
    const wildcard = await post(fake.handler(), { sessionId: SESSION_ID, action: 'add', path: 'protected/*.ts', cwd: workspace })
    expect(wildcard.status).toBe(400)
    expect(String(wildcard.json.error)).toContain('glob metacharacters')
    const rules = await post(fake.handler(), { sessionId: SESSION_ID, action: 'add', path: '.readonly', cwd: workspace })
    expect(rules.status).toBe(400)
    expect(String(rules.json.error)).toContain('rules file')
    expect(grants.listOf(SESSION_ID)).toEqual([])
  })

  it('add 超过 maxGrants 时拒绝并说明原因', async () => {
    const fake = fakeConnection()
    grants = new GrantsService(() => 1, () => {})
    mountGrantsRoute(fake.connection, grants, fakeHost(workspace, 1))
    const first = await post(fake.handler(), { sessionId: SESSION_ID, action: 'add', path: 'protected', cwd: workspace })
    expect(first.status).toBe(200)
    const second = await post(fake.handler(), { sessionId: SESSION_ID, action: 'add', path: 'outside', cwd: workspace })
    expect(second.status).toBe(400)
    expect(String(second.json.error)).toContain('maximum')
  })

  it('revoke 撤回授权并投递通知', async () => {
    const { fake, host } = mount()
    grants.grant(SESSION_ID, join(workspace, 'protected'), 'override')
    const result = await post(fake.handler(), {
      sessionId: SESSION_ID,
      action: 'revoke',
      path: join(workspace, 'protected'),
      cwd: workspace,
    })
    expect(result.status).toBe(200)
    expect(result.json.changed).toEqual({ path: join(workspace, 'protected'), kind: 'override', action: 'revoke' })
    expect(result.json.notice).toBe('queued')
    expect(result.json.grants).toEqual([])
    expect(host.details.notified).toEqual([{ path: join(workspace, 'protected'), kind: 'override' }])
    expect(grants.recordOf(SESSION_ID).grants).toEqual([])
  })

  it('revoke 未持有过的路径返回 400, 也不投递通知', async () => {
    const { fake, host } = mount()
    const result = await post(fake.handler(), { sessionId: SESSION_ID, action: 'revoke', path: outside, cwd: workspace })
    expect(result.status).toBe(400)
    expect(String(result.json.error)).toContain('no write grant')
    expect(host.details.notified).toEqual([])
  })

  it('请求体校验: 缺 sessionId, 动作非法, 动作缺路径都返回 400', async () => {
    const { fake } = mount()
    const handler = fake.handler()
    expect((await post(handler, { action: 'list' })).status).toBe(400)
    expect((await post(handler, { sessionId: SESSION_ID, action: 'drop' })).status).toBe(400)
    const missingPath = await post(handler, { sessionId: SESSION_ID, action: 'add' })
    expect(missingPath.status).toBe(400)
    expect(String(missingPath.json.error)).toContain('needs a non-empty path')
  })

  it('会话工作区根未知时不回退部署根, 直接 400', async () => {
    const { fake } = mount()
    const result = await post(fake.handler(), { sessionId: 'other-session', action: 'list', cwd: workspace })
    expect(result.status).toBe(400)
    expect(String(result.json.error)).toContain('no deployment-root fallback')
  })
})

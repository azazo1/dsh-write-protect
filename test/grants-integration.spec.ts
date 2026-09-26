// 端到端 (host 半区): 会话面板的 `/api` 路由 → 真实的 WriteProtectPolicyService →
// 逐次调用的 policy 与撤回通知.
//
// 与 grants-route.spec 的区别: 那里用替身 host 覆盖路由自身的判定, 这里跑真实
// policy 服务, 因此验证的是接线 —— 面板加进去的授权确实出现在该会话的 policy 里,
// 撤回之后又消失, 并且通知真的投到了该会话的 agent 上.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GRANTS_PATH, PREVIEW_PATH } from '../src/constants.ts'
import { WriteProtectPolicyService, type Config } from '../src/policy.ts'
import { projectTmpDir } from './fixture-root.ts'

type Handler = (request: Request) => Promise<Response>

const SESSION_ID = 'session-1'

let base: string
let workspace: string
let outside: string
let ctx: Context
let policy: WriteProtectPolicyService
let handlers: Map<string, Handler>
let injected: { role: string, text: string, source: unknown }[]
/** agents 替身认为"活着"的会话; 移掉它即可复现 agent 已销毁的场景. */
let liveSessions: Set<string>

async function boot(): Promise<void> {
  ctx = new Context()
  handlers = new Map()
  injected = []
  liveSessions = new Set([SESSION_ID])
  ctx.provide('sessionProjections', { register: () => {}, stateOf: () => undefined })
  ctx.provide('connection', {
    fetch: {
      register(route: { path: string, fetch: Handler }) {
        handlers.set(route.path, route.fetch)
        return () => { handlers.delete(route.path) }
      },
    },
  })
  ctx.provide('agents', {
    get: (id: string) => liveSessions.has(id)
      ? {
        inject: (message: { role: string, content: { type: string, text?: string }[], source: unknown }) => {
          injected.push({
            role: message.role,
            text: message.content.map(part => part.text ?? '').join(''),
            source: message.source,
          })
        },
      }
      : undefined,
  })
  await ctx.plugin(WriteProtectPolicyService, {
    mode: 'workspace-write',
    workspaceRoot: workspace,
    readOnlyPaths: ['.git'],
    readonlyFileName: '.readonly',
  } satisfies Partial<Config>)
  policy = (ctx as unknown as { sandboxPolicy: WriteProtectPolicyService }).sandboxPolicy
}

/** 发一次面板请求. */
async function post(body: unknown): Promise<{ status: number, json: Record<string, unknown> }> {
  const handler = handlers.get(GRANTS_PATH)
  if (handler === undefined) throw new Error('grants route was not mounted')
  const response = await handler(new Request(`http://dsh.local${GRANTS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: response.status, json: await response.json() as Record<string, unknown> }
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-grants-e2e-')))
  workspace = join(base, 'ws')
  outside = join(base, 'outside')
  mkdirSync(join(workspace, 'protected'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  await boot()
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('会话面板与 policy 的接线', () => {
  it('两条路由都挂在 connection 上', () => {
    expect([...handlers.keys()].sort()).toEqual([GRANTS_PATH, PREVIEW_PATH])
  })

  it('面板加的工作区外路径进入该会话的 writablePaths', async () => {
    const added = await post({ sessionId: SESSION_ID, action: 'add', path: '../outside', cwd: workspace })
    expect(added.status).toBe(200)
    expect(policy.resolveForSession(SESSION_ID, workspace).writablePaths).toContain(outside)
  })

  it('面板加的工作区内路径进入该会话的 writableOverrides, 撤回后消失', async () => {
    const protectedPath = join(workspace, 'protected')
    const added = await post({ sessionId: SESSION_ID, action: 'add', path: 'protected', cwd: workspace })
    expect(added.json.changed).toEqual({ path: protectedPath, kind: 'override', action: 'add' })
    expect(policy.resolveForSession(SESSION_ID, workspace).writableOverrides).toEqual([protectedPath])

    const revoked = await post({ sessionId: SESSION_ID, action: 'revoke', path: protectedPath, cwd: workspace })
    expect(revoked.status).toBe(200)
    expect(revoked.json.notice).toBe('queued')
    expect(revoked.json.grants).toEqual([])
    // 撤回之后这条授权既不在旁路里, 也不在额外可写根里.
    const policyAfter = policy.resolveForSession(SESSION_ID, workspace)
    expect(policyAfter.writableOverrides).toEqual([])
    expect(policyAfter.writablePaths).toEqual([])
  })

  it('撤回之后通知投到该会话, 带本插件的 notice 来源', async () => {
    await post({ sessionId: SESSION_ID, action: 'add', path: 'protected', cwd: workspace })
    await post({ sessionId: SESSION_ID, action: 'revoke', path: join(workspace, 'protected'), cwd: workspace })
    expect(injected).toHaveLength(1)
    const notice = injected[0]!
    expect(notice.role).toBe('user')
    expect(notice.text).toContain(join(workspace, 'protected'))
    expect(notice.source).toMatchObject({ kind: 'write-protect', form: 'notice' })
  })

  it('会话没有活着的 agent 时通知投不出去, 授权照样撤回', async () => {
    await post({ sessionId: SESSION_ID, action: 'add', path: 'protected', cwd: workspace })
    liveSessions.clear()
    const revoked = await post({ sessionId: SESSION_ID, action: 'revoke', path: join(workspace, 'protected'), cwd: workspace })
    expect(revoked.status).toBe(200)
    expect(revoked.json.notice).toBe('no-session')
    expect(revoked.json.grants).toEqual([])
    expect(injected).toEqual([])
    expect(policy.resolveForSession(SESSION_ID, workspace).writableOverrides).toEqual([])
  })
})

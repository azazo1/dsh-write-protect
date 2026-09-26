// createWriteAccessFace: 会话面板的数据面.
//
// 断言的是发出去的请求体与回来的响应被怎么解读: 会话 id 与 cwd 必须带上 (Host 靠
// 后者定位工作区根), 失败要变成可读的错误而不是让界面把半截数据当成"没有授权".

import { afterEach, describe, expect, it, vi } from 'vitest'
import { GRANTS_PATH } from '../src/constants.ts'
import { createWriteAccessFace, grantKindLabel } from '../src/client/write-access.ts'

interface Sent {
  url: string
  init: { method?: string, body?: string }
}

/** 把 fetch 换成一个固定回应的替身, 并记录发出去的请求. */
function stubFetch(payload: unknown, ok = true, status = 200): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', (url: string, init: Sent['init']) => {
    sent.push({ url, init })
    return Promise.resolve({
      ok,
      status,
      text: () => Promise.resolve(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    })
  })
  return sent
}

function bodyOf(sent: Sent): Record<string, unknown> {
  return JSON.parse(sent.init.body ?? '{}') as Record<string, unknown>
}

const EMPTY_VIEW = { workspaceRoot: '/ws', mode: 'workspace-write', maxGrants: 8, grants: [] }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createWriteAccessFace', () => {
  it('load 带上会话 id 与 cwd, 并把响应读成面板状态', async () => {
    const sent = stubFetch({ ...EMPTY_VIEW, grants: [{ path: '/ws/protected', kind: 'override' }] })
    const view = await createWriteAccessFace('session-1', () => '/ws').load()
    expect(sent[0]!.url).toBe(GRANTS_PATH)
    expect(sent[0]!.init.method).toBe('POST')
    expect(bodyOf(sent[0]!)).toEqual({ sessionId: 'session-1', action: 'list', cwd: '/ws' })
    expect(view.grants).toEqual([{ path: '/ws/protected', kind: 'override' }])
    expect(view.maxGrants).toBe(8)
  })

  it('没有 cwd 时不编一个出来, 交给 Host 报缺少工作区根', async () => {
    const sent = stubFetch(EMPTY_VIEW)
    await createWriteAccessFace('session-1', () => undefined).load()
    expect(bodyOf(sent[0]!)).toEqual({ sessionId: 'session-1', action: 'list' })
  })

  it('add 把路径原文交给 Host, revoke 带回通知结果', async () => {
    const sent = stubFetch({ ...EMPTY_VIEW, changed: { path: '/ws/a', kind: 'override', action: 'add' } })
    const face = createWriteAccessFace('session-1', () => '/ws')
    await face.add('~/scratch')
    expect(bodyOf(sent[0]!)).toEqual({ sessionId: 'session-1', action: 'add', cwd: '/ws', path: '~/scratch' })

    const revoked = stubFetch({ ...EMPTY_VIEW, notice: 'no-session' })
    const after = await face.revoke('/ws/protected')
    expect(bodyOf(revoked[0]!)).toEqual({ sessionId: 'session-1', action: 'revoke', cwd: '/ws', path: '/ws/protected' })
    expect(after.notice).toBe('no-session')
  })

  it('形状不全的条目被丢掉, 而不是让界面显示一条残缺授权', async () => {
    stubFetch({
      ...EMPTY_VIEW,
      grants: [{ path: '/ws/a', kind: 'override' }, { path: '/ws/b' }, { path: 3, kind: 'nope' }],
    })
    const view = await createWriteAccessFace('session-1', () => '/ws').load()
    expect(view.grants).toEqual([{ path: '/ws/a', kind: 'override' }])
  })

  it('失败时抛出 Host 给的原因, 空 body 与非法 JSON 也各有话说', async () => {
    stubFetch({ error: 'cannot add "/ws/a": glob metacharacters' }, false, 400)
    const face = createWriteAccessFace('session-1', () => '/ws')
    await expect(face.add('/ws/*')).rejects.toThrow('glob metacharacters')

    stubFetch('', false, 500)
    await expect(face.load()).rejects.toThrow('empty body')

    stubFetch('<html>', false, 502)
    await expect(face.load()).rejects.toThrow('grants request failed (502)')
  })

  it('授权类型有中文名', () => {
    expect(grantKindLabel('override')).toBe('保护旁路')
    expect(grantKindLabel('extra-root')).toBe('额外可写根')
  })
})

// WriteProtectPolicyService: settings 通道 (部署 base 与用户覆盖) 到逐次调用
// policy 的注入语义. settings 与 sessionProjections 由最小替身提供, 替身按官方
// 契约做 base -> 用户 section 的分层, 并用注册时的 schema 校验解析结果.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  ALLOW_REQUESTS_FIELD, DEFAULT_ALLOW_REQUESTS, DEFAULT_HARDEN_BROKER,
  DEFAULT_MAX_GRANTS, DEFAULT_MAX_READONLY_ENTRIES, DEFAULT_READONLY_FILE_NAME,
  DEFAULT_READ_ONLY_PATHS, DEFAULT_WATCH_PROTECTED_PATHS, DEFAULT_WATCH_TTL_MAX_MS,
  DEFAULT_WATCH_TTL_MIN_MS, DEFAULT_WRITABLE_PATHS,
  HARDEN_BROKER_FIELD, MAX_GRANTS_FIELD, MAX_READONLY_ENTRIES_FIELD,
  PATTERNS_FIELD, READONLY_FILE_FIELD, WATCH_FIELD, WATCH_TTL_MAX_FIELD,
  WATCH_TTL_MIN_FIELD, WRITABLE_FIELD,
} from '../src/constants.ts'
import { WriteProtectPolicyService, type Config } from '../src/policy.ts'
import { projectTmpDir } from './fixture-root.ts'

/** 会话替身: policy 只用到会话 id 与 `header.cwd`. */
function sessionStub(cwd = '/ws'): never {
  return { id: 'session-1', header: { cwd } } as never
}

interface FakeSettings {
  /** 模拟用户在设置页保存的 section (留空表示从未保存过). */
  save(section: Record<string, unknown>): void
  /** 注册时收到的 base (部署层). */
  base(): Record<string, unknown>
}

function fakeSettings(config: Partial<Config>): FakeSettings {
  const state: Record<string, unknown> = {
    [HARDEN_BROKER_FIELD]: config.hardenBroker ?? DEFAULT_HARDEN_BROKER,
    [READONLY_FILE_FIELD]: config.readonlyFileName ?? DEFAULT_READONLY_FILE_NAME,
    [MAX_READONLY_ENTRIES_FIELD]: config.maxReadOnlyEntries ?? DEFAULT_MAX_READONLY_ENTRIES,
    [MAX_GRANTS_FIELD]: config.maxGrants ?? DEFAULT_MAX_GRANTS,
    [ALLOW_REQUESTS_FIELD]: config.allowWritableRequests ?? DEFAULT_ALLOW_REQUESTS,
    [WATCH_FIELD]: config.watchProtectedPaths ?? DEFAULT_WATCH_PROTECTED_PATHS,
    [WATCH_TTL_MIN_FIELD]: config.watchTtlMinMs ?? DEFAULT_WATCH_TTL_MIN_MS,
    [WATCH_TTL_MAX_FIELD]: config.watchTtlMaxMs ?? DEFAULT_WATCH_TTL_MAX_MS,
    [PATTERNS_FIELD]: config.patterns,
    [WRITABLE_FIELD]: config.writablePatterns,
  }
  return {
    save(section) {
      Object.assign(state, section)
    },
    base: () => state,
  }
}

/** 挂载 policy 服务, 返回服务, settings 替身与最近一次提示词文本. */
async function setup(config: Partial<Config> = {}): Promise<{
  policy: WriteProtectPolicyService
  settings: FakeSettings
  promptText: () => string
}> {
  const ctx = new Context()
  const settings = fakeSettings(config)
  const state = settings.base()
  const ref = <T>(key: string) => ({ get: () => state[key] as T })
  const runtimeConfig = {
    workspaceRoot: '/ws',
    mode: 'workspace-write',
    ...config,
    readOnlyPaths: config.readOnlyPaths ?? [...DEFAULT_READ_ONLY_PATHS],
    writablePaths: config.writablePaths ?? [...DEFAULT_WRITABLE_PATHS],
    patterns: ref<string | undefined>(PATTERNS_FIELD),
    writablePatterns: ref<string | undefined>(WRITABLE_FIELD),
    hardenBroker: ref<boolean>(HARDEN_BROKER_FIELD),
    readonlyFileName: ref<string>(READONLY_FILE_FIELD),
    maxReadOnlyEntries: ref<number>(MAX_READONLY_ENTRIES_FIELD),
    maxGrants: ref<number>(MAX_GRANTS_FIELD),
    allowWritableRequests: ref<boolean>(ALLOW_REQUESTS_FIELD),
    watchProtectedPaths: ref<boolean>(WATCH_FIELD),
    watchTtlMinMs: ref<number>(WATCH_TTL_MIN_FIELD),
    watchTtlMaxMs: ref<number>(WATCH_TTL_MAX_FIELD),
  }
  // 投影替身要带 stateOf: 提示词组装会经 resolve() 读沙箱模式覆盖.
  ctx.provide('sessionProjections', { register: () => {}, stateOf: () => undefined })
  let text = ''
  ctx.provide('systemPrompt', {
    context: (entry: { text: (context: unknown) => string }) => {
      text = entry.text({ agent: { session: { id: 'session-1', header: { cwd: '/ws' } } } })
    },
    getContextOrder: () => 0,
  })
  await ctx.plugin({
    name: 'write-protect-policy-test',
    apply(inner) {
      new WriteProtectPolicyService(inner, runtimeConfig as unknown as Config)
    },
  })
  const policy = (ctx as unknown as { sandboxPolicy: WriteProtectPolicyService }).sandboxPolicy
  return { policy, settings, promptText: () => text }
}

describe('WriteProtectPolicyService 的 settings 通道', () => {
  it('resolve() 注入 broker 加固开关, 缺省开启', async () => {
    const { policy, settings } = await setup()
    expect(policy.resolve({}).hardenBroker).toBe(true)
    expect(settings.base()[HARDEN_BROKER_FIELD]).toBe(true)
  })

  it('部署 base 关掉后 resolve() 为 false', async () => {
    const { policy } = await setup({ hardenBroker: false })
    expect(policy.resolve({}).hardenBroker).toBe(false)
  })

  it('设置页保存的开关覆盖部署 base', async () => {
    const { policy, settings } = await setup({ hardenBroker: false })
    settings.save({ [HARDEN_BROKER_FIELD]: true })
    expect(policy.resolve({}).hardenBroker).toBe(true)
  })

  it('设置页关掉开关后 resolve() 为 false', async () => {
    const { policy, settings } = await setup()
    settings.save({ [HARDEN_BROKER_FIELD]: false })
    expect(policy.resolve({}).hardenBroker).toBe(false)
  })

  it('resolve() 注入生效的保护路径原文, 供 fs 围栏按模式判定', async () => {
    const { policy, settings } = await setup({ readOnlyPaths: ['.git', 'secrets/*.pem'] })
    expect(policy.resolve({}).readOnlyPatterns).toBe('.git\nsecrets/*.pem')
    // 用户保存过的文本覆盖部署 base: 原文随之切换, fs 围栏按新文本匹配.
    settings.save({ [PATTERNS_FIELD]: '/secrets' })
    expect(policy.resolve({}).readOnlyPatterns).toBe('/secrets')
  })

  it('两份文本仍按 settings 覆盖 base, 与开关互不影响', async () => {
    const { policy, settings } = await setup({ readOnlyPaths: ['.git'] })
    settings.save({ [PATTERNS_FIELD]: '/secrets', [HARDEN_BROKER_FIELD]: false })
    const resolved = policy.resolve({ session: sessionStub() })
    expect(resolved.readOnlyPatterns).toBe('/secrets')
    expect(resolved.hardenBroker).toBe(false)
    // resolve() 是同步契约, 冷缓存不扫盘; 枚举路径要等 materialize().
    expect(resolved.readOnlyPaths).toEqual([])
    await policy.materialize('/ws')
    expect(policy.resolve({ session: sessionStub() }).readOnlyPaths).toEqual(['/ws/secrets'])
  })

  it('规则文件名, 上限与三个开关都走同一套 base 与用户覆盖', async () => {
    const { policy, settings } = await setup()
    expect(settings.base()[READONLY_FILE_FIELD]).toBe('.readonly')
    expect(settings.base()[MAX_READONLY_ENTRIES_FIELD]).toBe(200)
    expect(settings.base()[MAX_GRANTS_FIELD]).toBe(8)
    expect(settings.base()[ALLOW_REQUESTS_FIELD]).toBe(true)
    expect(settings.base()[WATCH_FIELD]).toBe(true)
    expect(settings.base()[WATCH_TTL_MIN_FIELD]).toBe(2000)
    expect(settings.base()[WATCH_TTL_MAX_FIELD]).toBe(30000)
    expect(policy.limits()).toEqual({
      readonlyFileName: '.readonly',
      maxReadOnlyEntries: 200,
      maxGrants: 8,
      allowWritableRequests: true,
      watchProtectedPaths: true,
      watchTtlMinMs: 2000,
      watchTtlMaxMs: 30000,
    })
    settings.save({
      [READONLY_FILE_FIELD]: 'rules.txt',
      [MAX_READONLY_ENTRIES_FIELD]: 5,
      [MAX_GRANTS_FIELD]: 2,
      [ALLOW_REQUESTS_FIELD]: false,
      [WATCH_FIELD]: false,
      [WATCH_TTL_MIN_FIELD]: 500,
      [WATCH_TTL_MAX_FIELD]: 4000,
    })
    expect(policy.limits()).toEqual({
      readonlyFileName: 'rules.txt',
      maxReadOnlyEntries: 5,
      maxGrants: 2,
      allowWritableRequests: false,
      watchProtectedPaths: false,
      watchTtlMinMs: 500,
      watchTtlMaxMs: 4000,
    })
  })

  it('上界小于下界时按较大的那个算, 非法值回退默认', async () => {
    const { policy } = await setup({ watchTtlMinMs: 5000, watchTtlMaxMs: 1000 })
    expect(policy.limits().watchTtlMinMs).toBe(5000)
    expect(policy.limits().watchTtlMaxMs).toBe(5000)
    const { policy: fallback } = await setup({ watchTtlMinMs: 0, watchTtlMaxMs: -1 })
    expect(fallback.limits().watchTtlMinMs).toBe(DEFAULT_WATCH_TTL_MIN_MS)
    expect(fallback.limits().watchTtlMaxMs).toBe(DEFAULT_WATCH_TTL_MAX_MS)
  })

  it('部署 base 可以关掉可写申请', async () => {
    const { policy } = await setup({ allowWritableRequests: false })
    expect(policy.limits().allowWritableRequests).toBe(false)
  })

  it('规则文件名置空即关闭识别, 非法名字回退默认', async () => {
    const { policy, settings } = await setup()
    settings.save({ [READONLY_FILE_FIELD]: '   ' })
    expect(policy.currentReadonlyFileName()).toBe('')
    expect(policy.rulesFilePath('/ws')).toBeUndefined()
    settings.save({ [READONLY_FILE_FIELD]: '../escape' })
    expect(policy.currentReadonlyFileName()).toBe('.readonly')
    expect(policy.rulesFilePath('/ws')).toBe('/ws/.readonly')
  })

  it('部署 base 的非法上限回退默认值', async () => {
    const { policy } = await setup({ maxGrants: 0, maxReadOnlyEntries: -3 })
    expect(policy.limits()).toEqual({
      readonlyFileName: '.readonly',
      maxReadOnlyEntries: 200,
      maxGrants: 8,
      allowWritableRequests: true,
      watchProtectedPaths: true,
      watchTtlMinMs: 2000,
      watchTtlMaxMs: 30000,
    })
  })

  it('无会话根时不展开保护路径: 原文进 readOnlyPatterns, 路径清单为空', async () => {
    // 没有已知工作区根时唯一现成的候选是部署根 (进程 cwd), 在那里枚举可能是一次
    // 几十秒的同步扫盘, 因此直接不展开.
    const { policy } = await setup({ readOnlyPaths: ['secrets/', '!/secrets/public.pem'] })
    const resolved = policy.resolve({})
    expect(resolved.readOnlyPatterns).toBe('secrets/\n!/secrets/public.pem')
    expect(resolved.readOnlyPaths).toEqual([])
    expect(resolved.writablePaths).toEqual([])
    expect(resolved.rulesFilePath).toBeUndefined()
  })

  it('会话带 cwd 时按该根展开 (规则文件条目并入并可被取反剔除)', async () => {
    const workspace = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-rules-')))
    mkdirSync(join(workspace, 'secrets'))
    mkdirSync(join(workspace, 'secrets', 'public.pem'))
    try {
      const { policy } = await setup({ workspaceRoot: workspace, readOnlyPaths: ['secrets/', '!/secrets/public.pem'] })
      const resolved = policy.resolve({ session: sessionStub(workspace) })
      // 原文在同步的 resolve() 里就能拿到, 展开清单要等 materialize().
      expect(resolved.readOnlyPatterns).toBe('secrets/\n!/secrets/public.pem')
      expect(resolved.readOnlyPaths).toEqual([])
      expect((await policy.materialize(workspace)).readOnly).toEqual([join(workspace, 'secrets')])
      expect(policy.resolve({ session: sessionStub(workspace) }).readOnlyPaths).toEqual([join(workspace, 'secrets')])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('WriteProtectPolicyService 的提示词', () => {
  it('默认引导模型在需要反复写同一片区域时才申请', async () => {
    const { promptText } = await setup()
    const text = promptText()
    expect(text).toContain('request_writable_path')
    expect(text).toContain('will keep writing the same protected path or area')
    expect(text).toContain('a single file is written with the ordinary write/edit tools')
    // 保护只在 read-only 与 workspace-write 下成立, 提示词要点明这个边界.
    expect(text).toContain('danger-full-access is unrestricted')
  })

  it('关掉可写申请后提示词只说本部署不授予', async () => {
    const { promptText } = await setup({ allowWritableRequests: false })
    const text = promptText()
    expect(text).toContain('do not ask for it')
    expect(text).not.toContain('will keep writing the same protected path or area')
  })
})

describe('resolveForSession 的工作区根', () => {
  it('用会话 cwd 定位工作区根, 不在部署根上做展开', async () => {
    // 部署根与会话工作区各放一个 .git: 只有会话那一份允许出现在结果里. 这条断言
    // 同时守住了"审批工具不在部署根 (进程 cwd) 上同步扫盘"这条边界 —— 部署根可能
    // 是整棵 home, 在那里枚举会把 Host 事件循环堵住几十秒.
    const deployment = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-dep-')))
    const sessionCwd = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-cwd-')))
    mkdirSync(join(deployment, '.git'))
    mkdirSync(join(sessionCwd, '.git'))
    try {
      const { policy } = await setup({ workspaceRoot: deployment, readOnlyPaths: ['.git'] })
      const resolved = policy.resolveForSession('session-unknown', sessionCwd)
      expect(resolved.workspaceRoot).toBe(sessionCwd)
      // 展开基准是会话工作区根: 部署根那一侧的 .git 不该出现在结果里.
      expect((await policy.materialize(sessionCwd)).readOnly).toEqual([join(sessionCwd, '.git')])
      expect(policy.resolveForSession('session-unknown', sessionCwd).readOnlyPaths).toEqual([join(sessionCwd, '.git')])
      // cwd 与会话记录都没有时不展开, 也不回退部署根.
      const noRoot = policy.resolveForSession('session-unknown-2')
      expect(noRoot.readOnlyPaths).toEqual([])
      expect(noRoot.rulesFilePath).toBeUndefined()
    } finally {
      rmSync(deployment, { recursive: true, force: true })
      rmSync(sessionCwd, { recursive: true, force: true })
    }
  })
})

describe('会话授权与只读展开缓存解耦', () => {
  it('批准会话授权后直接并入 policy, 不会作废只读展开缓存 (避免重新扫盘)', async () => {
    const workspace = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-grant-cache-')))
    mkdirSync(join(workspace, '.git'))
    try {
      const { policy } = await setup({ workspaceRoot: workspace, readOnlyPaths: ['.git'] })
      const session = { id: 'session-grant-1', header: { cwd: workspace } } as never
      // 展开缓存先热起来 (命令侧或预览的一次 materialize 即可).
      await policy.materialize(workspace)
      const first = policy.resolve({ session })
      expect(first.readOnlyPaths).toEqual([join(workspace, '.git')])
      expect(first.writableOverrides).toEqual([])

      // 模拟授予可写权限 (向 GrantsService 写入一条授权)
      const grants = policy.grantsView()
      grants.grant('session-grant-1', join(workspace, '.git', 'HEAD'), 'override')

      // 下一次 resolve: 只读展开结果必须稳定复用同一个数组引用 (未重新扫盘), 同时包含新的 override
      const second = policy.resolve({ session })
      expect(second.readOnlyPaths).toBe(first.readOnlyPaths)
      expect(second.writableOverrides).toEqual([join(workspace, '.git', 'HEAD')])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

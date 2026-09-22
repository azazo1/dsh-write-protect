// WriteProtectPolicyService: settings 通道 (部署 base 与用户覆盖) 到逐次调用
// policy 的注入语义. settings 与 sessionProjections 由最小替身提供, 替身按官方
// 契约做 base -> 用户 section 的分层, 并用注册时的 schema 校验解析结果.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ALLOW_REQUESTS_FIELD, HARDEN_BROKER_FIELD, MAX_GRANTS_FIELD, MAX_READONLY_ENTRIES_FIELD, PATTERNS_FIELD, PLUGIN_ID, READONLY_FILE_FIELD, WRITABLE_FIELD } from '../src/constants.ts'
import { WriteProtectPolicyService, type Config } from '../src/policy.ts'
import { projectTmpDir } from './fixture-root.ts'

/** 会话替身: policy 只用到会话 id 与 `header.cwd`. */
function sessionStub(cwd = '/ws'): never {
  return { id: 'session-1', header: { cwd } } as never
}

/** schemastery schema 的可调用形态 (校验/套用默认值). */
type SectionSchema = ((value: Record<string, unknown>) => Record<string, unknown>) & { toJSON?: () => unknown }

interface FakeSettings {
  service: { register: (ns: string, schema: SectionSchema, options: { base?: Record<string, unknown> }) => unknown }
  /** 模拟用户在设置页保存的 section (留空表示从未保存过). */
  save(section: Record<string, unknown>): void
  /** 注册时收到的 base (部署层). */
  base(): Record<string, unknown>
}

function fakeSettings(): FakeSettings {
  let user: Record<string, unknown> = {}
  let base: Record<string, unknown> = {}
  return {
    service: {
      register: (_ns, schema, options) => {
        base = options.base ?? {}
        const owner = {
          get: () => schema({ ...base, ...user }),
          watch: () => () => {},
          update: async (patch: Record<string, unknown>) => {
            user = { ...user, ...patch }
          },
          replace: async (section: Record<string, unknown>) => {
            user = section
          },
        }
        return owner
      },
    },
    save(section) {
      user = section
    },
    base: () => base,
  }
}

/** 挂载 policy 服务, 返回服务, settings 替身与最近一次提示词文本. */
async function setup(config: Partial<Config> = {}): Promise<{
  policy: WriteProtectPolicyService
  settings: FakeSettings
  promptText: () => string
}> {
  const ctx = new Context()
  const settings = fakeSettings()
  // 投影替身要带 stateOf: 提示词组装会经 resolve() 读沙箱模式覆盖.
  ctx.provide('sessionProjections', { register: () => {}, stateOf: () => undefined })
  ctx.provide('settings', settings.service)
  let text = ''
  ctx.provide('systemPrompt', {
    context: (entry: { text: (context: unknown) => string }) => {
      text = entry.text({ agent: { session: { id: 'session-1', header: { cwd: '/ws' } } } })
    },
    getContextOrder: () => 0,
  })
  await ctx.plugin(WriteProtectPolicyService, { workspaceRoot: '/ws', mode: 'workspace-write', ...config })
  // settings 注入是异步 fiber: 让 inject 回调先跑完再断言.
  await new Promise(resolve => setTimeout(resolve, 0))
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

  it('两份文本仍按 settings 覆盖 base, 与开关互不影响', async () => {
    const { policy, settings } = await setup({ readOnlyPaths: ['.git'] })
    settings.save({ [PATTERNS_FIELD]: '/secrets', [HARDEN_BROKER_FIELD]: false })
    const resolved = policy.resolve({ session: sessionStub() })
    // 文本换成 /secrets 后 .git 不再受保护 (锚定字面条目即使不存在也保留).
    expect(resolved.readOnlyPaths).toEqual(['/ws/secrets'])
    expect(resolved.hardenBroker).toBe(false)
  })

  it('规则文件名, 两个上限与可写申请开关都走同一套 base 与用户覆盖', async () => {
    const { policy, settings } = await setup()
    expect(settings.base()[READONLY_FILE_FIELD]).toBe('.readonly')
    expect(settings.base()[MAX_READONLY_ENTRIES_FIELD]).toBe(200)
    expect(settings.base()[MAX_GRANTS_FIELD]).toBe(8)
    expect(settings.base()[ALLOW_REQUESTS_FIELD]).toBe(true)
    expect(policy.limits()).toEqual({ readonlyFileName: '.readonly', maxReadOnlyEntries: 200, maxGrants: 8, allowWritableRequests: true })
    settings.save({
      [READONLY_FILE_FIELD]: 'rules.txt',
      [MAX_READONLY_ENTRIES_FIELD]: 5,
      [MAX_GRANTS_FIELD]: 2,
      [ALLOW_REQUESTS_FIELD]: false,
    })
    expect(policy.limits()).toEqual({ readonlyFileName: 'rules.txt', maxReadOnlyEntries: 5, maxGrants: 2, allowWritableRequests: false })
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
    expect(policy.limits()).toEqual({ readonlyFileName: '.readonly', maxReadOnlyEntries: 200, maxGrants: 8, allowWritableRequests: true })
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
      expect(resolved.readOnlyPaths).toEqual([join(workspace, 'secrets')])
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
      expect(resolved.readOnlyPaths).toEqual([join(sessionCwd, '.git')])
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

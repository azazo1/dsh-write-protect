// WriteProtectPolicyService: settings 通道 (部署 base 与用户覆盖) 到逐次调用
// policy 的注入语义. settings 与 sessionProjections 由最小替身提供, 替身按官方
// 契约做 base -> 用户 section 的分层, 并用注册时的 schema 校验解析结果.

import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HARDEN_BROKER_FIELD, PATTERNS_FIELD, PLUGIN_ID, WRITABLE_FIELD } from '../src/constants.ts'
import { WriteProtectPolicyService, type Config } from '../src/policy.ts'
import { projectTmpDir } from './fixture-root.ts'

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

/** 挂载 policy 服务, 返回服务与 settings 替身 (替身可随后模拟用户保存). */
async function setup(config: Partial<Config> = {}): Promise<{ policy: WriteProtectPolicyService, settings: FakeSettings }> {
  const ctx = new Context()
  const settings = fakeSettings()
  ctx.provide('sessionProjections', { register: () => {} })
  ctx.provide('settings', settings.service)
  await ctx.plugin(WriteProtectPolicyService, { workspaceRoot: '/ws', mode: 'workspace-write', ...config })
  // settings 注入是异步 fiber: 让 inject 回调先跑完再断言.
  await new Promise(resolve => setTimeout(resolve, 0))
  const policy = (ctx as unknown as { sandboxPolicy: WriteProtectPolicyService }).sandboxPolicy
  return { policy, settings }
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
    // 用户保存过的文本覆盖部署 base: 原文随之切换 (枚举清单可能被预算截断, 原文不会).
    settings.save({ [PATTERNS_FIELD]: '/secrets' })
    expect(policy.resolve({}).readOnlyPatterns).toBe('/secrets')
  })

  it('两份文本仍按 settings 覆盖 base, 与开关互不影响', async () => {
    const { policy, settings } = await setup({ readOnlyPaths: ['.git'] })
    settings.save({ [PATTERNS_FIELD]: '/secrets', [HARDEN_BROKER_FIELD]: false })
    const resolved = policy.resolve({})
    // 文本换成 /secrets 后 .git 不再受保护 (锚定字面条目即使不存在也保留).
    expect(resolved.readOnlyPaths).toEqual(['/ws/secrets'])
    expect(resolved.hardenBroker).toBe(false)
  })
})

describe('WriteProtectPolicyService 的有界展开', () => {
  let bigRoot: string

  beforeAll(() => {
    // 目录数超过同步项数预算 (EXPAND_SYNC_BUDGET), 让同步展开必然被截断;
    // .git 放在最深层, 只有后台异步补全才会找到它.
    bigRoot = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-big-')))
    for (let index = 0; index < 900; index += 1) {
      mkdirSync(join(bigRoot, `d${String(index).padStart(4, '0')}`))
    }
    mkdirSync(join(bigRoot, 'd0899', '.git'))
  })

  afterAll(() => {
    rmSync(bigRoot, { recursive: true, force: true })
  })

  it('同步 resolve() 被预算截断时先给浅层结果并告警, 后台补全后深层匹配出现', async () => {
    const { policy } = await setup({ workspaceRoot: bigRoot, readOnlyPaths: ['.git'] })
    const first = policy.resolve({})
    // 同步遍历有界: 不能因为工作区大就把 Host 事件循环拖住.
    expect(first.readOnlyPaths).toEqual([])

    const target = join(bigRoot, 'd0899', '.git')
    const deadline = Date.now() + 5000
    let found: readonly string[] = []
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      found = policy.resolve({}).readOnlyPaths ?? []
      if (found.includes(target)) break
    }
    expect(found).toContain(target)
    // 后台结果不会被后续更差的同步部分结果覆盖.
    expect(policy.resolve({}).readOnlyPaths).toContain(target)
  })
})

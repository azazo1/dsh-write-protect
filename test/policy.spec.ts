// WriteProtectPolicyService: settings 通道 (部署 base 与用户覆盖) 到逐次调用
// policy 的注入语义. settings 与 sessionProjections 由最小替身提供, 替身按官方
// 契约做 base -> 用户 section 的分层, 并用注册时的 schema 校验解析结果.

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { HARDEN_BROKER_FIELD, PATTERNS_FIELD, PLUGIN_ID, WRITABLE_FIELD } from '../src/constants.ts'
import { WriteProtectPolicyService, type Config } from '../src/policy.ts'

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

  it('两份文本仍按 settings 覆盖 base, 与开关互不影响', async () => {
    const { policy, settings } = await setup({ readOnlyPaths: ['.git'] })
    settings.save({ [PATTERNS_FIELD]: '/secrets', [HARDEN_BROKER_FIELD]: false })
    const resolved = policy.resolve({})
    // 文本换成 /secrets 后 .git 不再受保护 (锚定字面条目即使不存在也保留).
    expect(resolved.readOnlyPaths).toEqual(['/ws/secrets'])
    expect(resolved.hardenBroker).toBe(false)
  })
})

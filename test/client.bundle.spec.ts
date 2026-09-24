// Client bundle 的最小入口验证: 构建产物在 VM 中以假 module loader 执行,
// 断言 registration id 等于包名, inject 与 apply 齐备, 且产物没有顶层 ESM
// import/export (loader 模块形态). 平台模块 (react, dsh-client-store,
// ui-primitives) 由 loader 的模块表提供, 其余逻辑必须内联.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'

const PLUGIN_ID = 'dsh-write-protect'

/** loader 模块表里本插件允许请求的模块. */
const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
])

/** 请求过的模块, 由假 loader 记录. */
const requested: string[] = []

/** 平台模块的最小替身: 形状够 factory 与 apply 跑通即可. */
function fakePlatformModule(id: string): unknown {
  if (id === 'react') {
    return {
      createElement: () => null,
      useState: () => [null, () => {}],
      useSyncExternalStore: () => '',
    }
  }
  if (id === 'react/jsx-runtime') {
    return { jsx: () => null, jsxs: () => null, Fragment: null }
  }
  if (id === '@deepseek-ai/dsh-client-store') {
    return { createSnapshotStore: (initial: unknown) => ({ get: () => initial, set: () => {}, subscribe: () => () => {} }) }
  }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return { SettingsForm: () => null, SettingsValueField: () => null, Switch: () => null, Tag: () => null }
  }
  throw new Error(`unexpected require: ${id}`)
}

let code: string

beforeAll(() => {
  code = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
})

function loadModule(): { id?: string, factory?: (require: (id: string) => unknown) => Record<string, unknown> } {
  const registrations: unknown[] = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (registration: unknown) => registrations.push(registration),
      },
    },
    require: (id: string) => fakePlatformModule(id),
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  expect(registrations).toHaveLength(1)
  return registrations[0] as { id?: string, factory?: (require: (id: string) => unknown) => Record<string, unknown> }
}

describe('client bundle loader 注册', () => {
  it('产物包含 __ModuleLoader__.load 且无顶层 ESM import/export', () => {
    expect(code).toContain('__ModuleLoader__.load')
    // 模块形态: require 注入的 CJS, 不能保留 ESM 语法.
    expect(code).not.toMatch(/^import\s/m)
    expect(code).not.toMatch(/^export\s/m)
  })

  it('registration id 等于包名, factory 返回的模块带 inject 与 apply', () => {
    const handoff = loadModule()
    expect(handoff.id).toBe(PLUGIN_ID)
    expect(typeof handoff.factory).toBe('function')
    const moduleExports = handoff.factory!((id: string) => {
      requested.push(id)
      return fakePlatformModule(id)
    })
    expect(moduleExports.inject).toContain('configForms')
    expect(moduleExports.inject).toContain('slots')
    expect(moduleExports.inject).toContain('sessions')
    expect(typeof moduleExports.apply).toBe('function')
  })

  it('只向 loader 请求模块表里的模块, 其余逻辑全部内联', () => {
    requested.length = 0
    const handoff = loadModule()
    handoff.factory!((id: string) => {
      requested.push(id)
      return fakePlatformModule(id)
    })
    for (const id of requested) {
      expect(PLATFORM_MODULES.has(id)).toBe(true)
    }
    // 界面逻辑与文案应打包进产物 (纯内联).
    expect(code).toContain('保护路径')
    expect(code).toContain('额外可写根')
    expect(code).toContain('监视被保护路径')
    expect(code).toContain('预览')
    expect(code).toContain('未生效')
    expect(code).toContain('workspaceRoot')
  })
})

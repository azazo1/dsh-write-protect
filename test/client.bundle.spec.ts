// Client bundle 的最小入口验证: 构建产物在 VM 中以假 module loader 执行,
// 断言 registration id 等于包名, inject 与 apply 齐备, 且产物没有顶层 ESM
// import/export (loader 模块形态).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'

const PLUGIN_ID = 'dsh-write-protect'

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
    require: (id: string) => {
      if (id === 'react') return { createElement: () => null, useState: () => [null, () => {}], useSyncExternalStore: () => '' }
      throw new Error(`unexpected require: ${id}`)
    },
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
      if (id === 'react') return { createElement: () => null, useState: () => [null, () => {}], useSyncExternalStore: () => '' }
      throw new Error(`unexpected require: ${id}`)
    })
    expect(moduleExports.inject).toContain('settingsScope')
    expect(moduleExports.inject).toContain('slots')
    expect(typeof moduleExports.apply).toBe('function')
  })

  it('产物内联了全部逻辑, 只向 loader 请求 react', () => {
    // gitignore 语法的提示文案与页面标题都应打包进产物 (纯内联, 无其余外部请求).
    expect(code).toContain('写入保护')
    expect(code).toContain('其余匹配任意层级')
    expect(code).toContain('按最后匹配生效')
    expect(code).toContain('通配只匹配已存在的路径')
    expect(code).toContain('额外可写根')
    expect(code).toContain('不打穿 read-only')
    expect(code).toContain('当前用户家目录')
    expect(code).toContain('$NAME')
  })
})

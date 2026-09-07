// expandReadOnlyPaths: gitignore 风格配置文本到 canonical 保护路径的展开语义
// (安全核心之一). 展开在真实文件系统的临时工作区内验证.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expandReadOnlyPaths, parsePatternLines } from '../src/patterns.ts'

let ws: string

beforeAll(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-wp-patterns-')))
  mkdirSync(join(ws, '.git'))
  mkdirSync(join(ws, 'secrets'))
  mkdirSync(join(ws, 'src', 'nested'), { recursive: true })
  writeFileSync(join(ws, 'secrets', 'a.pem'), 'x')
  writeFileSync(join(ws, 'secrets', 'b.pem'), 'x')
  writeFileSync(join(ws, 'keystore.bin'), 'x')
})

afterAll(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('parsePatternLines', () => {
  it('跳过空行与 # 注释, 解析 ! 前缀与尾部斜杠; 前导 / 保留 (绝对路径)', () => {
    expect(parsePatternLines([
      '',
      '# 注释行',
      '.git/',
      '!  ',
      '/etc/pki',
      '!dist',
    ].join('\n'))).toEqual([
      { negated: false, pattern: '.git' },
      { negated: false, pattern: '/etc/pki' },
      { negated: true, pattern: 'dist' },
    ])
  })
})

describe('expandReadOnlyPaths 字面条目', () => {
  it('相对条目锚定工作区根; 不存在的路径保留词法形态', () => {
    const { paths } = expandReadOnlyPaths('.git\nnode_modules', ws)
    expect(paths).toEqual([join(ws, '.git'), join(ws, 'node_modules')])
  })

  it('canonical 化并去重: 不同写法的同一目标只保留一条', () => {
    // `./src/nested/..` 词法归一后与 `src` 相同, 去重为一条.
    const { paths } = expandReadOnlyPaths('src\n./src/nested/..', ws)
    expect(paths).toEqual([join(ws, 'src')])
  })

  it('绝对条目原样生效', () => {
    const abs = join(ws, 'keystore.bin')
    const { paths } = expandReadOnlyPaths(abs, ws)
    expect(paths).toEqual([abs])
  })
})

describe('expandReadOnlyPaths glob 条目', () => {
  it('* 匹配单段内任意字符, 只收集存在的路径', () => {
    const { paths } = expandReadOnlyPaths('secrets/*.pem', ws)
    expect(paths).toEqual([join(ws, 'secrets', 'a.pem'), join(ws, 'secrets', 'b.pem')])
  })

  it('? 匹配单字符', () => {
    const { paths } = expandReadOnlyPaths('secrets/?.pem', ws)
    expect(paths).toEqual([join(ws, 'secrets', 'a.pem'), join(ws, 'secrets', 'b.pem')])
  })

  it('** 递归匹配后代目录', () => {
    const { paths } = expandReadOnlyPaths('src/**/nested', ws)
    expect(paths).toEqual([join(ws, 'src', 'nested')])
  })

  it('glob 匹配到的目录按目录级语义保护后代', () => {
    const { paths } = expandReadOnlyPaths('secret*', ws)
    expect(paths).toEqual([join(ws, 'secrets')])
  })

  it('**/.git 同时覆盖工作区根与任意嵌套层级的 .git', () => {
    mkdirSync(join(ws, 'src', 'nested', '.git'), { recursive: true })
    const { paths } = expandReadOnlyPaths('**/.git', ws)
    expect(paths).toEqual([join(ws, '.git'), join(ws, 'src', 'nested', '.git')])
  })
})

describe('expandReadOnlyPaths 取反', () => {
  it('! 条目从展开结果中剔除匹配项', () => {
    const { paths } = expandReadOnlyPaths('secrets/*.pem\n!secrets/b.pem', ws)
    expect(paths).toEqual([join(ws, 'secrets', 'a.pem')])
  })

  it('取反不影响不匹配的条目', () => {
    const { paths } = expandReadOnlyPaths('.git\nsecrets/*.pem\n!secrets/a.pem\n!does-not-exist', ws)
    expect(paths).toEqual([join(ws, '.git'), join(ws, 'secrets', 'b.pem')])
  })
})

describe('expandReadOnlyPaths 杂项', () => {
  it('空文本与纯注释展开为空列表', () => {
    const { paths } = expandReadOnlyPaths('# 只有一段注释\n\n   \n', ws)
    expect(paths).toEqual([])
  })

  it('配置行展开告警为空 (无预算问题)', () => {
    const { warnings } = expandReadOnlyPaths('.git\nsecrets/*', ws)
    expect(warnings).toEqual([])
  })

  it('绝对 glob 条目按其字面前缀展开', () => {
    const { paths } = expandReadOnlyPaths(`${ws}/secret*`, ws)
    expect(paths).toEqual([join(ws, 'secrets')])
  })
})

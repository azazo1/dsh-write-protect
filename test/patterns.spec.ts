// expandReadOnlyPaths: gitignore 语义配置文本到 canonical 保护路径的展开语义
// (安全核心之一). 展开在真实文件系统的临时工作区内验证.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expandReadOnlyPaths, parsePatternLines } from '../src/patterns.ts'
import { projectTmpDir } from './fixture-root.ts'

let ws: string

beforeAll(() => {
  ws = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-patterns-')))
  mkdirSync(join(ws, 'gitdir'))
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
  it('解析注释, 取反, 目录标记, 锚定与 // 绝对扩展; 未转义尾部空格被移除', () => {
    expect(parsePatternLines([
      '',
      '   ',
      '# 注释行',
      'gitdir/',
      '!  ',
      '/etc/pki',
      '//etc/pki',
      'a/b/',
      '\\#hash',
      '\\!important.txt',
      'name  ',
      'with\\ space ',
    ].join('\n'))).toEqual([
      { negated: false, dirOnly: true, anchored: false, fsAbsolute: false, segments: ['gitdir'], source: 'gitdir' },
      { negated: false, dirOnly: false, anchored: true, fsAbsolute: false, segments: ['etc', 'pki'], source: 'etc/pki' },
      { negated: false, dirOnly: false, anchored: true, fsAbsolute: true, segments: ['etc', 'pki'], source: 'etc/pki' },
      { negated: false, dirOnly: true, anchored: true, fsAbsolute: false, segments: ['a', 'b'], source: 'a/b' },
      { negated: false, dirOnly: false, anchored: false, fsAbsolute: false, segments: ['\\#hash'], source: '\\#hash' },
      { negated: false, dirOnly: false, anchored: false, fsAbsolute: false, segments: ['\\!important.txt'], source: '\\!important.txt' },
      { negated: false, dirOnly: false, anchored: false, fsAbsolute: false, segments: ['name'], source: 'name' },
      { negated: false, dirOnly: false, anchored: false, fsAbsolute: false, segments: ['with\\ space'], source: 'with\\ space' },
    ])
  })
})

describe('expandReadOnlyPaths 锚定语义', () => {
  it('不含分隔符的条目在任意层级匹配 (gitignore 非锚定语义)', () => {
    mkdirSync(join(ws, 'src', 'nested', 'gitdir'), { recursive: true })
    const { paths } = expandReadOnlyPaths('gitdir', ws)
    expect(paths).toEqual([join(ws, 'gitdir'), join(ws, 'src', 'nested', 'gitdir')])
  })

  it('锚定条目只匹配工作区根下的对应路径', () => {
    const { paths } = expandReadOnlyPaths('/gitdir', ws)
    expect(paths).toEqual([join(ws, 'gitdir')])
  })

  it('锚定字面条目不存在时保留词法形态, 非锚定条目只收集存在路径', () => {
    expect(expandReadOnlyPaths('/dist/a.txt', ws).paths).toEqual([join(ws, 'dist', 'a.txt')])
    expect(expandReadOnlyPaths('node_modules', ws).paths).toEqual([])
  })

  it('// 前缀条目按文件系统绝对路径展开', () => {
    expect(expandReadOnlyPaths(`//${ws}/keystore.bin`, ws).paths).toEqual([join(ws, 'keystore.bin')])
    expect(expandReadOnlyPaths(`//${ws}/secret*`, ws).paths).toEqual([join(ws, 'secrets')])
  })
})

describe('expandReadOnlyPaths glob 语义', () => {
  it('* 匹配单段内任意字符, ? 匹配单字符, 都不跨段', () => {
    const a = join(ws, 'secrets', 'a.pem')
    const b = join(ws, 'secrets', 'b.pem')
    expect(expandReadOnlyPaths('secrets/*.pem', ws).paths).toEqual([a, b])
    expect(expandReadOnlyPaths('secrets/?.pem', ws).paths).toEqual([a, b])
  })

  it('段内连续星号按普通 * 处理', () => {
    expect(expandReadOnlyPaths('secret**', ws).paths).toEqual([join(ws, 'secrets')])
  })

  it('[...] 字符类含取反与 POSIX 类形式', () => {
    const a = join(ws, 'secrets', 'a.pem')
    const b = join(ws, 'secrets', 'b.pem')
    expect(expandReadOnlyPaths('secrets/[ab].pem', ws).paths).toEqual([a, b])
    expect(expandReadOnlyPaths('secrets/[!ab].pem', ws).paths).toEqual([])
    expect(expandReadOnlyPaths('secrets/[[:alpha:]].pem', ws).paths).toEqual([a, b])
    expect(expandReadOnlyPaths('secrets/[[:digit:]].pem', ws).paths).toEqual([])
  })

  it('** 独立成段时匹配零或多层目录', () => {
    expect(expandReadOnlyPaths('src/**/nested', ws).paths).toEqual([join(ws, 'src', 'nested')])
  })

  it('尾部 / 只匹配目录', () => {
    expect(expandReadOnlyPaths('secret*/', ws).paths).toEqual([join(ws, 'secrets')])
    expect(expandReadOnlyPaths('keystore.bin/', ws).paths).toEqual([])
  })

  it('尾部 /** 保护命名目录本身, 裸 ** 保护起始根本身', () => {
    expect(expandReadOnlyPaths('secrets/**', ws).paths).toEqual([join(ws, 'secrets')])
    expect(expandReadOnlyPaths('/**', ws).paths).toEqual([ws])
  })
})

describe('expandReadOnlyPaths 取反 (last-match-wins)', () => {
  it('! 条目剔除顺序靠前的展开结果', () => {
    const { paths } = expandReadOnlyPaths('secrets/*.pem\n!secrets/b.pem', ws)
    expect(paths).toEqual([join(ws, 'secrets', 'a.pem')])
  })

  it('靠后的正向条目重新纳入被取反的路径', () => {
    const { paths } = expandReadOnlyPaths('!secrets/b.pem\nsecrets/*.pem', ws)
    expect(paths).toEqual([join(ws, 'secrets', 'a.pem'), join(ws, 'secrets', 'b.pem')])
  })

  it('目录标记的取反不影响同名文件', () => {
    const { paths } = expandReadOnlyPaths('keystore.bin\n!keystore.bin/', ws)
    expect(paths).toEqual([join(ws, 'keystore.bin')])
  })

  it('锚定取反剔除深层展开结果', () => {
    mkdirSync(join(ws, 'src', 'nested', 'gitdir'), { recursive: true })
    const { paths } = expandReadOnlyPaths('**/gitdir\n!src/nested/gitdir', ws)
    expect(paths).toEqual([join(ws, 'gitdir')])
  })
})

describe('expandReadOnlyPaths 杂项', () => {
  it('空文本与纯注释展开为空列表', () => {
    const { paths } = expandReadOnlyPaths('# 只有一段注释\n\n   \n', ws)
    expect(paths).toEqual([])
  })

  it('配置行展开告警为空 (无预算问题)', () => {
    const { warnings } = expandReadOnlyPaths('/gitdir\nsecrets/*', ws)
    expect(warnings).toEqual([])
  })

  it('canonical 化并去重: 不同写法的同一目标只保留一条', () => {
    // `./src/nested/..` 词法归一后与 `src` 相同, 去重为一条.
    const { paths } = expandReadOnlyPaths('src\n./src/nested/..', ws)
    expect(paths).toEqual([join(ws, 'src')])
  })
})

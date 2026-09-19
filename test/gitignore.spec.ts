// gitignore.ts: 模式解析与逐路径匹配 (纯逻辑, 不碰文件系统, 因此这组用例不建
// 任何临时目录). 它是 write/edit 围栏的判定核心, 也是枚举展开共用的语义来源.

import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileGitignore, parsePatternLines } from '../src/gitignore.ts'

/** 平台中立的工作区根: 纯字符串用例也要能在 Windows 上跑. */
const root = resolve(process.platform === 'win32' ? 'C:\\ws' : '/ws')
/** 绝对模式 (`//` 前缀) 用正斜杠形态书写. */
const posix = (path: string): string => path.replaceAll('\\', '/')

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

describe('compileGitignore 逐路径匹配', () => {
  it('空文本与纯注释不命中任何路径', () => {
    const set = compileGitignore('# 注释\n\n')
    expect(set.entries).toEqual([])
    expect(set.match(join(root, '.git', 'config'), root, false)).toBeUndefined()
  })

  it('非锚定条目在任意层级命中, 并由命中的目录保护其后代', () => {
    const set = compileGitignore('.git')
    expect(set.match(join(root, '.git', 'config'), root, false)).toEqual({
      path: join(root, '.git'),
      entry: expect.objectContaining({ source: '.git' }),
    })
    // 深层嵌套: 没有枚举, 纯靠逐级前缀判定就能落到最近的那个 .git 上.
    const deep = join(root, 'a', 'b', 'c', '.git', 'objects', 'ab', 'cdef')
    expect(set.match(deep, root, false)?.path).toBe(join(root, 'a', 'b', 'c', '.git'))
  })

  it('锚定条目只作用于工作区根, 不含分隔符的条目才跨层级', () => {
    const anchored = compileGitignore('/.git')
    expect(anchored.match(join(root, '.git', 'config'), root, false)?.path).toBe(join(root, '.git'))
    expect(anchored.match(join(root, 'nested', '.git', 'config'), root, false)).toBeUndefined()
  })

  it('// 绝对条目保护工作区外的位置, 同样按前缀覆盖其后代', () => {
    const outside = resolve(root, '..', 'outside')
    const set = compileGitignore(`//${posix(join(outside, 'secrets'))}`)
    expect(set.match(join(outside, 'secrets', 'a.pem'), root, false)?.path).toBe(join(outside, 'secrets'))
    expect(set.match(join(outside, 'other', 'a.pem'), root, false)).toBeUndefined()
  })

  it('相对条目不作用于工作区外的同名路径', () => {
    const set = compileGitignore('.git')
    const outside = resolve(root, '..', 'elsewhere')
    expect(set.match(join(outside, '.git', 'config'), root, false)).toBeUndefined()
  })

  it('尾部 / 只匹配目录: 文件目标不命中, 同名的目录祖先照常命中', () => {
    const set = compileGitignore('build/')
    // 裸路径的目录性未知时按命中处理 (宁可多挡).
    expect(set.match(join(root, 'build'), root, null)?.path).toBe(join(root, 'build'))
    // write/edit 的目标是文件: 同名文件不该被只匹配目录的条目挡住.
    expect(set.match(join(root, 'build'), root, false)).toBeUndefined()
    // 但目录祖先命中的话, 后代照常受保护.
    expect(set.match(join(root, 'build', 'out.txt'), root, false)?.path).toBe(join(root, 'build'))
  })

  it('取反按 last-match-wins, 且被取反放行的目录可以重新敞开', () => {
    const set = compileGitignore('gitdir\n!src/nested/gitdir')
    expect(set.match(join(root, 'gitdir', 'config'), root, false)?.path).toBe(join(root, 'gitdir'))
    const reopened = join(root, 'src', 'nested', 'gitdir')
    expect(set.match(join(reopened, 'config'), root, false)).toBeUndefined()
    // 被取反的目录内部再出现的匹配仍然生效 (前缀围栏只在命中的那一层收口).
    const deeper = join(reopened, 'deep', 'gitdir')
    expect(set.match(join(deeper, 'config'), root, false)?.path).toBe(deeper)
  })

  it('受保护目录内部无法用取反重新放行后代', () => {
    const set = compileGitignore('secrets\n!secrets/example.pem')
    expect(set.match(join(root, 'secrets', 'example.pem'), root, false)?.path).toBe(join(root, 'secrets'))
  })

  it('通配不跨段, ** 独立成段才递归', () => {
    const single = compileGitignore('src/*/gitdir')
    expect(single.match(join(root, 'src', 'a', 'gitdir', 'x'), root, false)).toBeDefined()
    expect(single.match(join(root, 'src', 'a', 'b', 'gitdir', 'x'), root, false)).toBeUndefined()
    const recursive = compileGitignore('src/**/gitdir')
    expect(recursive.match(join(root, 'src', 'a', 'b', 'gitdir', 'x'), root, false)).toBeDefined()
  })

  it('大小写敏感可配置, 缺省按平台', () => {
    const insensitive = compileGitignore('.GIT', { caseSensitive: false })
    expect(insensitive.match(join(root, '.git', 'config'), root, false)).toBeDefined()
    const sensitive = compileGitignore('.GIT', { caseSensitive: true })
    expect(sensitive.match(join(root, '.git', 'config'), root, false)).toBeUndefined()
  })

  it('工作区根本身也算候选 (/** 覆盖整棵工作区)', () => {
    const set = compileGitignore('/**')
    expect(set.match(root, root, true)?.path).toBe(root)
    expect(set.match(join(root, 'anything', 'deep'), root, false)).toBeDefined()
  })
})

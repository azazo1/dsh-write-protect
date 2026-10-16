// expandTildeAndEnv: `~` / `$NAME` 展开, 以及 `\` 在 Windows 上是分隔符而不是转义符.
// expandPatternLine / expandPatternText: 同一套展开在模式列表上的形态 (绝对路径写成
// `//`, 替换值按字面转义, 用户自己的通配与转义保留).

import { describe, expect, it } from 'vitest'
import { escapesWithBackslash, expandPatternLine, expandPatternText, expandTildeAndEnv, pathApiOf } from '../src/path-expand.ts'
import { compileGitignore } from '../src/gitignore.ts'

const WINDOWS_HOME = 'C:\\Users\\tester'
const POSIX_HOME = '/home/tester'

describe('expandTildeAndEnv 平台差异', () => {
  it('Windows 上反斜杠是分隔符, 路径原样保留', () => {
    expect(expandTildeAndEnv('C:\\Users\\tester\\Library\\pnpm', { platform: 'win32', home: WINDOWS_HOME }))
      .toEqual({ ok: 'C:\\Users\\tester\\Library\\pnpm' })
  })

  it('Windows 上 ~\\... 与 ~/... 都展开为家目录', () => {
    expect(expandTildeAndEnv('~\\Library\\pnpm', { platform: 'win32', home: WINDOWS_HOME }))
      .toEqual({ ok: 'C:\\Users\\tester\\Library\\pnpm' })
    expect(expandTildeAndEnv('~/.cache', { platform: 'win32', home: WINDOWS_HOME }))
      .toEqual({ ok: 'C:\\Users\\tester\\.cache' })
  })

  it('Windows 上环境变量展开后反斜杠照旧保留', () => {
    process.env.DSH_WP_TEST_CACHE = 'D:\\caches'
    try {
      expect(expandTildeAndEnv('$DSH_WP_TEST_CACHE\\bun', { platform: 'win32', home: WINDOWS_HOME }))
        .toEqual({ ok: 'D:\\caches\\bun' })
    } finally {
      delete process.env.DSH_WP_TEST_CACHE
    }
  })

  it('POSIX 上反斜杠仍转义下一字符', () => {
    expect(expandTildeAndEnv('\\$HOME\\x', { platform: 'linux', home: POSIX_HOME }))
      .toEqual({ ok: '$HOMEx' })
    expect(expandTildeAndEnv('C:\\Users\\tester', { platform: 'linux', home: POSIX_HOME }))
      .toEqual({ ok: 'C:Userstester' })
  })

  it('~user 在两种平台都拒绝, ~\\... 只在 POSIX 上拒绝', () => {
    const tildeError = { error: 'only ~ and ~/... expand to the current user home (~\\... is accepted on Windows)' }
    expect(expandTildeAndEnv('~otheruser/x', { platform: 'win32', home: WINDOWS_HOME })).toEqual(tildeError)
    expect(expandTildeAndEnv('~\\x', { platform: 'linux', home: POSIX_HOME })).toEqual(tildeError)
  })

  it('平台 API 与转义开关按平台选择', () => {
    expect(pathApiOf('win32').sep).toBe('\\')
    expect(pathApiOf('darwin').sep).toBe('/')
    expect(escapesWithBackslash('win32')).toBe(false)
    expect(escapesWithBackslash('linux')).toBe(true)
  })
})

describe('expandPatternLine 的模式形态', () => {
  const posix = { platform: 'linux' as const, home: POSIX_HOME }

  it('行首 ~ 展开成 // 形态的绝对条目', () => {
    expect(expandPatternLine('~/.ssh', posix)).toEqual({ ok: '//home/tester/.ssh' })
    expect(expandPatternLine('~', posix)).toEqual({ ok: '//home/tester' })
    // 尾部目录标记与取反前缀都保留.
    expect(expandPatternLine('~/.ssh/', posix)).toEqual({ ok: '//home/tester/.ssh/' })
    expect(expandPatternLine('!~/.ssh', posix)).toEqual({ ok: '!//home/tester/.ssh' })
  })

  it('环境变量展开, 只有出现在行首的绝对结果才加 //', () => {
    process.env.DSH_WP_TEST_HOME = POSIX_HOME
    process.env.DSH_WP_TEST_DIR = 'sub'
    try {
      expect(expandPatternLine('$DSH_WP_TEST_HOME/.ssh', posix)).toEqual({ ok: '//home/tester/.ssh' })
      expect(expandPatternLine('${DSH_WP_TEST_HOME}/.aws/**', posix)).toEqual({ ok: '//home/tester/.aws/**' })
      // 不在行首的替换结果按字面接在模式里, 不能凭空变成绝对条目.
      expect(expandPatternLine('vendor/$DSH_WP_TEST_DIR', posix)).toEqual({ ok: 'vendor/sub' })
    } finally {
      delete process.env.DSH_WP_TEST_HOME
      delete process.env.DSH_WP_TEST_DIR
    }
  })

  it('未设置或空值的变量报错, 家目录根与文件系统根也拒绝', () => {
    expect(expandPatternLine('$DSH_WP_TEST_UNSET', posix))
      .toEqual({ error: 'references unset or empty environment variable "DSH_WP_TEST_UNSET"' })
    process.env.DSH_WP_TEST_ROOT = '/'
    try {
      expect(expandPatternLine('$DSH_WP_TEST_ROOT', posix))
        .toEqual({ error: 'expands to the filesystem root, which this pattern syntax cannot express' })
    } finally {
      delete process.env.DSH_WP_TEST_ROOT
    }
    expect(expandPatternLine('~other/x', posix))
      .toEqual({ error: 'only ~ and ~/... expand to the current user home (~\\... is accepted on Windows)' })
  })

  it('用户自己的通配与转义原样保留', () => {
    expect(expandPatternLine('secret/*.log', posix)).toEqual({ ok: 'secret/*.log' })
    expect(expandPatternLine('\\$HOME', posix)).toEqual({ ok: '\\$HOME' })
    expect(expandPatternLine('!secrets/example.pem', posix)).toEqual({ ok: '!secrets/example.pem' })
  })

  it('替换进来的值按字面转义, 不会变成通配', () => {
    process.env.DSH_WP_TEST_ODD = '/tmp/we[i]rd*dir'
    try {
      expect(expandPatternLine('$DSH_WP_TEST_ODD', { platform: 'linux', home: POSIX_HOME }))
        .toEqual({ ok: '//tmp/we\\[i\\]rd\\*dir' })
    } finally {
      delete process.env.DSH_WP_TEST_ODD
    }
  })

  it('Windows 上 ~\\... 的分隔符换成模式里的 /', () => {
    expect(expandPatternLine('~\\.ssh', { platform: 'win32', home: WINDOWS_HOME }))
      .toEqual({ ok: '//C:/Users/tester/.ssh' })
    expect(expandPatternLine('~/.ssh', { platform: 'win32', home: WINDOWS_HOME }))
      .toEqual({ ok: '//C:/Users/tester/.ssh' })
  })
})

describe('expandPatternText 的整体行为', () => {
  it('注释与空行保留, 失败的行丢弃并给出告警', () => {
    const expanded = expandPatternText('# 注释\n~/.ssh\n\n$DSH_WP_TEST_UNSET\n.bashrc', { platform: 'linux', home: POSIX_HOME })
    expect(expanded.text).toBe('# 注释\n//home/tester/.ssh\n\n.bashrc')
    expect(expanded.warnings).toEqual([
      'pattern line "$DSH_WP_TEST_UNSET" references unset or empty environment variable "DSH_WP_TEST_UNSET"; the line is dropped',
    ])
  })

  it('展开后的文本能被匹配器直接用来判定家目录里的路径', () => {
    const expanded = expandPatternText('~/.ssh\n~/.aws/**', { platform: 'linux', home: POSIX_HOME })
    const set = compileGitignore(expanded.text)
    expect(set.match(`${POSIX_HOME}/.ssh/config`, '/home/tester/work', null)?.entry.source).toBe('home/tester/.ssh')
    // `/**` 条目直接命中后代本身, 围栏起点就是那条后代路径.
    expect(set.match(`${POSIX_HOME}/.aws/nested/credentials`, '/home/tester/work', null)?.entry.source)
      .toBe('home/tester/.aws/**')
    expect(set.match(`${POSIX_HOME}/.bashrc`, '/home/tester/work', null)).toBeUndefined()
  })
})

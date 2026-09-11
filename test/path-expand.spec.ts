// expandTildeAndEnv: `~` / `$NAME` 展开, 以及 `\` 在 Windows 上是分隔符而不是转义符.

import { describe, expect, it } from 'vitest'
import { escapesWithBackslash, expandTildeAndEnv, pathApiOf } from '../src/path-expand.ts'

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

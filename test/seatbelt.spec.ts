// seatbelt.ts: SBPL 形式的拼接与 broker 加固常量.

import { describe, expect, it } from 'vitest'
import { SEATBELT_BROKER_DENIALS, appendSeatbeltForms, sbplString, seatbeltRegexDenials } from '../src/seatbelt.ts'

describe('sbplString', () => {
  it('转义反斜杠与双引号', () => {
    expect(sbplString('/a"b\\c')).toBe('"/a\\"b\\\\c"')
  })
})

describe('appendSeatbeltForms', () => {
  it('追加到 -p 之后的 profile 文本末尾', () => {
    expect(appendSeatbeltForms(['sandbox-exec', '-p', '(version 1)', '--', 'true'], ['(deny x)']))
      .toEqual(['sandbox-exec', '-p', '(version 1) (deny x)', '--', 'true'])
  })

  it('空形式返回内容相同的副本', () => {
    const argv = ['sandbox-exec', '-p', '(version 1)']
    const next = appendSeatbeltForms(argv, [])
    expect(next).toEqual(argv)
    expect(next).not.toBe(argv)
  })

  it('缺少 -p 或没有 profile 值时返回 undefined', () => {
    expect(appendSeatbeltForms(['sandbox-exec', 'true'], ['(deny x)'])).toBeUndefined()
    expect(appendSeatbeltForms(['sandbox-exec', '-p'], ['(deny x)'])).toBeUndefined()
  })
})

describe('SEATBELT_BROKER_DENIALS', () => {
  it('每条都是完整的 deny 形式', () => {
    expect(SEATBELT_BROKER_DENIALS.length).toBeGreaterThan(0)
    for (const form of SEATBELT_BROKER_DENIALS) expect(form.startsWith('(deny ')).toBe(true)
  })
})

describe('seatbeltRegexDenials', () => {
  it('任意层级的字面条目翻译成覆盖后代的 regex deny', () => {
    expect(seatbeltRegexDenials('.git', '/ws'))
      .toEqual(['(deny file-write* (regex #"^/ws(/.*)?/\\.git(/.*)?$"))'])
  })

  it('锚定条目从工作区根起算, 绝对条目从文件系统根起算, 元字符按字面转义', () => {
    expect(seatbeltRegexDenials('/a/b', '/ws')).toEqual(['(deny file-write* (regex #"^/ws/a/b(/.*)?$"))'])
    expect(seatbeltRegexDenials('//etc/pki', '/ws')).toEqual(['(deny file-write* (regex #"^/etc/pki(/.*)?$"))'])
    expect(seatbeltRegexDenials('a.b', '/w.s')).toEqual(['(deny file-write* (regex #"^/w\\.s(/.*)?/a\\.b(/.*)?$"))'])
  })

  it('工作区根结尾的斜杠不影响匹配', () => {
    expect(seatbeltRegexDenials('.git', '/ws/'))
      .toEqual(['(deny file-write* (regex #"^/ws(/.*)?/\\.git(/.*)?$"))'])
  })

  it('重复条目只出一条, 空文本不出形式', () => {
    expect(seatbeltRegexDenials('.git\n.git', '/ws')).toHaveLength(1)
    expect(seatbeltRegexDenials('  \n# 注释', '/ws')).toEqual([])
  })

  it('含取反的文本整体放弃: 纯 deny 表达不了 last-match-wins', () => {
    expect(seatbeltRegexDenials('secrets/\n!secrets/public.pem', '/ws')).toEqual([])
  })

  it('含通配或转义的条目留给枚举清单', () => {
    expect(seatbeltRegexDenials('build/*.log', '/ws')).toEqual([])
    expect(seatbeltRegexDenials('build/**', '/ws')).toEqual([])
    expect(seatbeltRegexDenials('cache\\ dir', '/ws')).toEqual([])
  })
})

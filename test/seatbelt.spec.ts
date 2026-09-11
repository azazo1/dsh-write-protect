// seatbelt.ts: SBPL 形式的拼接与 broker 加固常量.

import { describe, expect, it } from 'vitest'
import { SEATBELT_BROKER_DENIALS, appendSeatbeltForms, sbplString } from '../src/seatbelt.ts'

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

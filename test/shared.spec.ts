// resolveReadOnlyPaths: 配置项到 canonical 保护路径的解析语义 (安全核心之一).

import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveReadOnlyPaths } from '../src/shared.ts'

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

describe('resolveReadOnlyPaths', () => {
  it('相对配置项锚定到工作区根解析', () => {
    const ws = tempDir('dsh-wp-ws-')
    expect(resolveReadOnlyPaths(['.git'], ws)).toEqual([join(ws, '.git')])
  })

  it('绝对配置项原样解析', () => {
    const ws = tempDir('dsh-wp-ws-')
    const abs = join(ws, 'vendor')
    expect(resolveReadOnlyPaths([abs], ws)).toEqual([abs])
  })

  it('路径经过 canonical 化, 与 writableRoots 的身份一致', () => {
    // macOS 上 /tmp 是 /private/tmp 的符号链接: 传入 /tmp 得到真实路径.
    const resolved = resolveReadOnlyPaths(['/tmp'], '/')
    expect(resolved).toEqual([realpathSync('/tmp')])
  })

  it('同一目标的不同拼写去重为一条', () => {
    const ws = tempDir('dsh-wp-ws-')
    mkdirSync(join(ws, 'real'))
    symlinkSync(join(ws, 'real'), join(ws, 'link'))
    const resolved = resolveReadOnlyPaths(['real', 'link', './real'], ws)
    expect(resolved).toEqual([join(ws, 'real')])
  })

  it('空白配置项被跳过 (加载时的显式拒绝由 policy 负责)', () => {
    const ws = tempDir('dsh-wp-ws-')
    expect(resolveReadOnlyPaths(['.git', '  ', ''], ws)).toEqual([join(ws, '.git')])
  })

  it('配置顺序在去重后保持', () => {
    const ws = tempDir('dsh-wp-ws-')
    expect(resolveReadOnlyPaths(['node_modules', '.git'], ws)).toEqual([
      join(ws, 'node_modules'),
      join(ws, '.git'),
    ])
  })
})

// 只读规则文件的解析, 校验与缓存: 文件不存在/非普通文件/绝对条目/越界条目/
// 条目上限, 以及缓存与 refresh 的区别.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isValidReadonlyFileName } from '../src/constants.ts'
import { ReadOnlyFileCache, mergeReadOnlyText, readReadOnlyFile } from '../src/readonly-file.ts'
import { projectTmpDir } from './fixture-root.ts'

let base: string
let workspace: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-ro-')))
  workspace = join(base, 'ws')
  mkdirSync(workspace)
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** 把规则文件写进工作区根. */
function writeRules(text: string, name = '.readonly'): string {
  const path = join(workspace, name)
  writeFileSync(path, text)
  return path
}

describe('readReadOnlyFile', () => {
  it('文件不存在时按没有条目处理, 不报错', () => {
    const file = readReadOnlyFile(workspace, '.readonly', 200)
    expect(file.present).toBe(false)
    expect(file.text).toBe('')
    expect(file.warnings).toEqual([])
  })

  it('解析注释, 锚定条目, 目录标记与取反条目', () => {
    writeRules([
      '# 注释行',
      '',
      'secrets/',
      '/build',
      '!secrets/public.pem',
      'vendor',
    ].join('\n'))
    const file = readReadOnlyFile(workspace, '.readonly', 200)
    expect(file.present).toBe(true)
    // 含中间 `/` 的条目本身就是锚定条目, 还原成文本时统一写成前导 `/` 形态.
    expect(file.entries).toEqual(['secrets/', '/build', '!/secrets/public.pem', 'vendor'])
    expect(file.text).toBe('secrets/\n/build\n!/secrets/public.pem\nvendor')
    expect(file.warnings).toEqual([])
  })

  it('拒绝 // 绝对条目并告警', () => {
    writeRules('//etc/pki\nsecrets/')
    const file = readReadOnlyFile(workspace, '.readonly', 200)
    expect(file.entries).toEqual(['secrets/'])
    expect(file.warnings.some(warning => warning.includes('filesystem-absolute'))).toBe(true)
  })

  it('拒绝越出工作区的 .. 条目并告警', () => {
    writeRules('../sibling\nsecrets/')
    const file = readReadOnlyFile(workspace, '.readonly', 200)
    expect(file.entries).toEqual(['secrets/'])
    expect(file.warnings.some(warning => warning.includes('escapes the workspace'))).toBe(true)
  })

  it('通配条目不会被误判为越界', () => {
    writeRules('**/cache/\nsecrets/*.pem')
    const file = readReadOnlyFile(workspace, '.readonly', 200)
    expect(file.entries).toEqual(['/**/cache/', '/secrets/*.pem'])
    expect(file.warnings).toEqual([])
  })

  it('超过条目上限的部分丢弃并告警一次', () => {
    writeRules(['a', 'b', 'c'].join('\n'))
    const file = readReadOnlyFile(workspace, '.readonly', 2)
    expect(file.entries).toEqual(['a', 'b'])
    expect(file.warnings.some(warning => warning.includes('beyond the limit'))).toBe(true)
  })

  it('符号链接指向别处时拒绝读取', () => {
    const elsewhere = join(base, 'elsewhere')
    writeFileSync(elsewhere, 'secrets/')
    symlinkSync(elsewhere, join(workspace, '.readonly'))
    const file = readReadOnlyFile(workspace, '.readonly', 200)
    expect(file.present).toBe(false)
    expect(file.entries).toEqual([])
    expect(file.warnings.some(warning => warning.includes('not a regular file'))).toBe(true)
  })

  it('目录同名时按非普通文件拒绝', () => {
    mkdirSync(join(workspace, '.readonly'))
    const file = readReadOnlyFile(workspace, '.readonly', 200)
    expect(file.present).toBe(false)
  })
})

describe('ReadOnlyFileCache', () => {
  it('TTL 内复用缓存, refresh 立即重读', () => {
    writeRules('first/')
    const warnings: string[] = []
    const cache = new ReadOnlyFileCache(200, message => warnings.push(message))
    expect(cache.read(workspace, '.readonly').entries).toEqual(['first/'])
    // 文件换了内容, 但缓存还没过期: 仍然看到旧内容.
    writeRules('second/')
    expect(cache.read(workspace, '.readonly').entries).toEqual(['first/'])
    expect(cache.refresh(workspace, '.readonly').entries).toEqual(['second/'])
    expect(cache.read(workspace, '.readonly').entries).toEqual(['second/'])
  })

  it('换文件名后不再命中旧缓存, forget 也会作废', () => {
    writeRules('a/', 'rules-a')
    writeRules('b/', 'rules-b')
    const cache = new ReadOnlyFileCache(200)
    expect(cache.read(workspace, 'rules-a').entries).toEqual(['a/'])
    expect(cache.read(workspace, 'rules-b').entries).toEqual(['b/'])
    cache.forget(workspace)
    expect(cache.peek(workspace, 'rules-b')).toBeUndefined()
  })

  it('告警按内容去重, 多次读取只回调一次', () => {
    writeRules('//etc/pki\nsecrets/')
    const warnings: string[] = []
    const cache = new ReadOnlyFileCache(200, message => warnings.push(message))
    cache.read(workspace, '.readonly')
    cache.refresh(workspace, '.readonly')
    expect(warnings).toHaveLength(1)
  })
})

describe('mergeReadOnlyText', () => {
  it('空的一侧不影响另一侧, 两侧都有时规则文件在后', () => {
    expect(mergeReadOnlyText('.git', '')).toBe('.git')
    expect(mergeReadOnlyText('', 'secrets/')).toBe('secrets/')
    expect(mergeReadOnlyText('.git', 'secrets/')).toBe('.git\nsecrets/')
    expect(mergeReadOnlyText('  ', 'secrets/')).toBe('secrets/')
  })
})

describe('isValidReadonlyFileName', () => {
  it('接受普通文件名, 拒绝路径分隔符与元数据名', () => {
    expect(isValidReadonlyFileName('.readonly')).toBe(true)
    expect(isValidReadonlyFileName('readonly.txt')).toBe(true)
    expect(isValidReadonlyFileName('')).toBe(false)
    expect(isValidReadonlyFileName('  ')).toBe(false)
    expect(isValidReadonlyFileName('sub/.readonly')).toBe(false)
    expect(isValidReadonlyFileName('sub\\.readonly')).toBe(false)
    expect(isValidReadonlyFileName('.')).toBe(false)
    expect(isValidReadonlyFileName('..')).toBe(false)
    expect(isValidReadonlyFileName('.git')).toBe(false)
    expect(isValidReadonlyFileName('.gitignore')).toBe(false)
    expect(isValidReadonlyFileName('.gitattributes')).toBe(false)
  })
})

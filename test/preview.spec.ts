// previewPaths: 设置页预览与执法半区共用展开结果.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { previewPaths } from '../src/preview.ts'
import { projectTmpDir } from './fixture-root.ts'

let ws: string
let extra: string

beforeAll(() => {
  ws = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-preview-')))
  extra = realpathSync(mkdtempSync(join(ws, '..', 'preview-extra-')))
  mkdirSync(join(ws, 'gitdir'))
})

afterAll(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(extra, { recursive: true, force: true })
})

describe('previewPaths', () => {
  it('列出生效的保护路径, 并把工作区内的额外根标为未生效', () => {
    const preview = previewPaths('gitdir', 'src', ws)
    expect(preview.workspaceRoot).toBe(ws)
    expect(preview.readOnly).toEqual([join(ws, 'gitdir')])
    expect(preview.writable).toEqual([])
    expect(preview.warnings.some(item => item.includes('already inside the workspace'))).toBe(true)
  })

  it('额外可写根展开进 preview.writable', () => {
    const preview = previewPaths('', extra, ws)
    expect(preview.writable).toEqual([extra])
    expect(preview.warnings).toEqual([])
  })
})

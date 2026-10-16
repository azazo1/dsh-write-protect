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
  it('列出生效的保护路径, 并把工作区内的额外根标为未生效', async () => {
    const preview = await previewPaths('gitdir', 'src', ws)
    expect(preview.workspaceRoot).toBe(ws)
    expect(preview.readOnly).toEqual([join(ws, 'gitdir')])
    expect(preview.writable).toEqual([])
    expect(preview.warnings.some(item => item.includes('already inside the workspace'))).toBe(true)
  })

  it('额外可写根展开进 preview.writable', async () => {
    const preview = await previewPaths('', extra, ws)
    expect(preview.writable).toEqual([extra])
    expect(preview.warnings).toEqual([])
  })

  it('保护路径与读拒绝草稿都按配置语义展开, 丢弃的行记进告警', async () => {
    process.env.DSH_WP_TEST_PREVIEW = extra
    try {
      const preview = await previewPaths('$DSH_WP_TEST_PREVIEW', '', ws, undefined, [], '$DSH_WP_TEST_PREVIEW\n$DSH_WP_TEST_UNSET')
      // 环境变量展开出的绝对路径同样进枚举清单 (这里两个根同一个目录, 去重后一条).
      expect(preview.readOnly).toEqual([extra])
      expect(preview.readDeny).toEqual([extra])
      expect(preview.warnings).toEqual([
        'pattern line "$DSH_WP_TEST_UNSET" references unset or empty environment variable "DSH_WP_TEST_UNSET"; the line is dropped',
      ])
    } finally {
      delete process.env.DSH_WP_TEST_PREVIEW
    }
  })
})

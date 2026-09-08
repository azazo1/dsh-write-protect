// WriteProtectFileSystem: write/edit 入口的保护路径拒绝语义.
// 真实组合 WriteProtectPolicyService + WriteProtectFileSystem (cordis 依赖
// 追踪要求 service 从 registry 挂载), 工作区刻意避开系统临时区: workspace-write
// 会授权 /tmp 与 os.tmpdir(), 那下面的目录不属于 "外部", 故夹具统一放在项目
// .tmp 下 (gitignore 覆盖).

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { WriteProtectPolicyService } from '../src/policy.ts'
import { WriteProtectFileSystem } from '../src/fs.ts'
import { projectTmpDir } from './fixture-root.ts'

let base: string
let workspace: string
let ctx: Context
let fs: WriteProtectFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

async function boot(mode: SandboxMode, readOnlyPaths: string[]): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(WriteProtectPolicyService, { mode, workspaceRoot: workspace, readOnlyPaths })
  fiber = await ctx.plugin(WriteProtectFileSystem, { cwd: workspace })
  fs = ctx.fs as WriteProtectFileSystem
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-fs-')))
  workspace = join(base, 'ws')
  mkdirSync(workspace)
})
afterEach(() => {
  fiber?.dispose()
  rmSync(base, { recursive: true, force: true })
})

function target(displayPath: string): FsTarget {
  return { targetKey: FsTargetKey(displayPath), displayPath }
}

describe('WriteProtectFileSystem write/edit 保护', () => {
  it('workspace-write 下工作区普通文件可写', async () => {
    await boot('workspace-write', ['gitdir'])
    const file = join(workspace, 'normal.txt')
    await fs.writeText(target(file), 'hello')
    expect(await readFile(file, 'utf8')).toBe('hello')
  })

  it('workspace-write 下保护目录内的写入被拒绝', async () => {
    await boot('workspace-write', ['gitdir'])
    mkdirSync(join(workspace, 'gitdir'))
    const error = await fs.writeText(target(join(workspace, 'gitdir', 'config')), 'x').then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect((error as NodeJS.ErrnoException).code).toBe('FS_SANDBOX_DENIED')
    expect((error as Error).message).toContain('dsh-write-protect')
  })

  it('锚定条目指向的路径尚不存在时仍按词法通道拒绝', async () => {
    await boot('workspace-write', ['/gitdir'])
    await expect(fs.writeText(target(join(workspace, 'gitdir', 'config')), 'x')).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    })
  })

  it('指向保护目录内部的符号链接同样被拒绝', async () => {
    await boot('workspace-write', ['gitdir'])
    mkdirSync(join(workspace, 'gitdir'))
    symlinkSync(join(workspace, 'gitdir'), join(workspace, 'gitlink'))
    await expect(fs.writeText(target(join(workspace, 'gitlink', 'config')), 'x')).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    })
  })

  it('danger-full-access 下普通文件可写, 保护路径仍被拒绝', async () => {
    await boot('danger-full-access', ['gitdir'])
    mkdirSync(join(workspace, 'gitdir'))
    await fs.writeText(target(join(workspace, 'free.txt')), 'ok')
    await expect(fs.writeText(target(join(workspace, 'gitdir', 'config')), 'x')).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    })
    expect(await readFile(join(workspace, 'free.txt'), 'utf8')).toBe('ok')
  })

  it('read-only 模式由官方围栏全量拒绝, message 不来自本插件', async () => {
    await boot('read-only', ['gitdir'])
    const error = await fs.writeText(target(join(workspace, 'normal.txt')), 'x').then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect((error as NodeJS.ErrnoException).code).toBe('FS_SANDBOX_DENIED')
    expect((error as Error).message).toContain('read-only mode')
  })

  it('editText 到保护路径在读取内容之前就被拒绝', async () => {
    await boot('workspace-write', ['gitdir'])
    mkdirSync(join(workspace, 'gitdir'))
    const missing = join(workspace, 'gitdir', 'does-not-exist')
    const error = await fs.editText(target(missing), { oldString: 'a', newString: 'b', replaceAll: false }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect((error as NodeJS.ErrnoException).code).toBe('FS_SANDBOX_DENIED')
    expect((error as Error).message).toContain('dsh-write-protect')
  })

  it('空保护列表时不产生额外拒绝', async () => {
    await boot('workspace-write', [])
    mkdirSync(join(workspace, 'gitdir'))
    await fs.writeText(target(join(workspace, 'gitdir', 'config')), 'x')
    expect(await readFile(join(workspace, 'gitdir', 'config'), 'utf8')).toBe('x')
  })

  it('配置的工作区内子文件保护路径同样生效', async () => {
    writeFileSync(join(workspace, 'keystore.bin'), 'seed')
    await boot('workspace-write', ['keystore.bin'])
    await expect(fs.writeText(target(join(workspace, 'keystore.bin')), 'x')).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
    })
  })

  it('policy.resolve() 注入 canonical 化且去重的 readOnlyPaths', async () => {
    mkdirSync(join(workspace, 'gitdir'))
    await boot('workspace-write', ['gitdir', 'gitdir', `//${join(workspace, 'dist')}`])
    const policy = ctx.sandboxPolicy.resolve()
    expect(policy.readOnlyPaths).toEqual([join(workspace, 'gitdir'), join(workspace, 'dist')])
  })
})

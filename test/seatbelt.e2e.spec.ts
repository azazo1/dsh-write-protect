// darwin Seatbelt 真实组合验证: confine() 改写后的 argv 直接执行,
// 保护路径内的写入被内核拒绝, 其余可写, 官方模式语义不变.
// 仅在 macOS 上运行 (sandbox-exec 是 darwin 链的唯一 runner).
// 嵌套沙箱 (外层已有 Seatbelt 限制) 中运行时, 外层拒绝的操作内层无权放行, "允许写入" 用例可能失败且拒绝用例可能空泛通过 - 内核级断言只在普通终端或 CI 有意义, 属环境限制不再细究.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { WriteProtectSandboxProvider } from '../src/provider.ts'
import { projectTmpDir } from './fixture-root.ts'

describe.skipIf(process.platform !== 'darwin')('Seatbelt 真实执法 (darwin)', () => {
  const ws = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-e2e-')))
  mkdirSync(join(ws, 'gitdir'))
  const protectedDir = join(ws, 'gitdir')
  const extra = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-e2e-extra-')))
  // 外层已有 Seatbelt 时内层 sandbox-exec 无法再 apply profile (exit 71).
  const nestedSandbox = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '--', 'true']).status !== 0

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true })
    rmSync(extra, { recursive: true, force: true })
  })

  async function confine(policy: SandboxPolicy, argv: string[]): Promise<string[]> {
    const ctx = new Context()
    await ctx.plugin(WriteProtectSandboxProvider, {})
    const sandbox = ctx.sandbox as WriteProtectSandboxProvider
    sandbox.internals = { platform: 'darwin' }
    return sandbox.confine(argv, policy).argv
  }

  function run(argv: string[]): { status: number | null; stderr: string } {
    const spawned = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
    return { status: spawned.status, stderr: spawned.stderr ?? '' }
  }

  it('保护路径内的写入被 Seatbelt 拒绝', async () => {
    const argv = await confine(
      { mode: 'workspace-write', workspaceRoot: ws, readOnlyPaths: [protectedDir] },
      ['touch', join(protectedDir, 'denied.txt')],
    )
    const result = run(argv)
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('operation not permitted')
  })

  it.skipIf(nestedSandbox)('保护路径之外的工作区写入照常放行', async () => {
    const argv = await confine(
      { mode: 'workspace-write', workspaceRoot: ws, readOnlyPaths: [protectedDir] },
      ['touch', join(ws, 'allowed.txt')],
    )
    expect(run(argv).status).toBe(0)
  })

  it('read-only 模式下整个工作区仍被官方 profile 拒绝', async () => {
    const argv = await confine(
      { mode: 'read-only', workspaceRoot: ws },
      ['touch', join(ws, 'readonly-denied.txt')],
    )
    const result = run(argv)
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('operation not permitted')
  })

  it.skipIf(nestedSandbox)('额外可写根内的写入被 Seatbelt 放行', async () => {
    const argv = await confine(
      { mode: 'workspace-write', workspaceRoot: ws, writablePaths: [extra] },
      ['touch', join(extra, 'allowed.txt')],
    )
    expect(run(argv).status).toBe(0)
  })

  it('额外可写根内部的保护路径仍被拒绝', async () => {
    const nested = join(extra, 'gitdir')
    mkdirSync(nested)
    const argv = await confine(
      { mode: 'workspace-write', workspaceRoot: ws, readOnlyPaths: [nested], writablePaths: [extra] },
      ['touch', join(nested, 'denied.txt')],
    )
    const result = run(argv)
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('operation not permitted')
  })
})

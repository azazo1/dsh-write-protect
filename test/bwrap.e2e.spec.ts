// linux bwrap 真实组合验证: confine() 改写后的 argv 直接执行, 保护路径内的
// 写入被内核拒绝 (EROFS), 保护路径读取与额外可写根照常, 官方模式语义不变.
// 仅在 Linux 且本机 bwrap 真实可用时运行: 缺二进制、无 unprivileged user
// namespace、或外层沙箱禁止嵌套时整体跳过 (这类环境里"允许写入"用例会失败、
// 拒绝用例会空泛通过, 断言没有意义).
//
// 与 provider.spec.ts 的分工: 那边只断言 argv 形状 (任何平台可跑), 这里断言
// 内核真的按形状执法 —— 官方 confine() 的契约变化 (0.1.6 起改异步) 正是在
// "拿到 argv 并真的执行" 这条路上把沙箱整个弄挂的, 这里保留端到端证据.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WriteProtectSandboxProvider } from '../src/provider.ts'
import { projectTmpDir } from './fixture-root.ts'

/**
 * 本机 bwrap 能否真的建立一个只读 profile: 用官方 read-only 形状跑一次 `true`,
 * 退出码 0 才算可用. 探测本身不抛异常, 任何 spawn 失败都按不可用处理.
 * @returns bwrap 可用时为 true.
 */
function bwrapUsable(): boolean {
  try {
    const probe = spawnSync('bwrap', [
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--unshare-pid',
      '--proc', '/proc',
      '--die-with-parent',
      '--', 'true',
    ], { stdio: 'ignore' })
    return probe.status === 0
  } catch {
    return false
  }
}

const usable = process.platform === 'linux' && bwrapUsable()

describe.skipIf(!usable)('bwrap 真实执法 (linux)', () => {
  const ws = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-bwrap-e2e-')))
  const protectedDir = join(ws, '.git')
  const protectedFile = join(protectedDir, 'config')
  const extra = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-bwrap-e2e-extra-')))
  mkdirSync(protectedDir)
  writeFileSync(protectedFile, '[core]\n\trepositoryformatversion = 0\n')

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true })
    rmSync(extra, { recursive: true, force: true })
  })

  /** 真跑一次被沙箱包装的命令: 走真实平台链 (不注入 internals), 返回执行事实. */
  async function runConfined(script: string): Promise<{ runner: string, enforcement: string, status: number | null, stderr: string }> {
    const ctx = new Context()
    await ctx.plugin(WriteProtectSandboxProvider, {})
    const sandbox = ctx.sandbox as WriteProtectSandboxProvider
    const confined = await sandbox.confine(['bash', '-c', script], {
      mode: 'workspace-write',
      workspaceRoot: ws,
      readOnlyPaths: [protectedDir],
      writablePaths: [extra],
    })
    const spawned = spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: 'utf8' })
    return {
      runner: confined.argv[0]!,
      enforcement: confined.enforcement,
      status: spawned.status,
      stderr: spawned.stderr ?? '',
    }
  }

  it('真实 runner 是 bwrap, 工作区普通写入照常放行', async () => {
    const marker = join(ws, 'allowed.txt')
    const result = await runConfined(`echo allowed > ${JSON.stringify(marker)}`)
    expect(result.runner).toBe('bwrap')
    expect(result.enforcement).toBe('full')
    expect(result.status).toBe(0)
    expect(existsSync(marker)).toBe(true)
  })

  it('保护路径内的写入被内核拒绝, 内容不变', async () => {
    const result = await runConfined(`echo hacked > ${JSON.stringify(protectedFile)}`)
    expect(result.status).not.toBe(0)
    expect(result.stderr.toLowerCase()).toContain('read-only file system')
    expect(readFileSync(protectedFile, 'utf8')).toContain('repositoryformatversion')
  })

  it('保护路径仍可读', async () => {
    const result = await runConfined(`cat ${JSON.stringify(protectedFile)}`)
    expect(result.status).toBe(0)
  })

  it('额外可写根在 workspace-write 下真的可写', async () => {
    const marker = join(extra, 'shared.txt')
    const result = await runConfined(`echo shared > ${JSON.stringify(marker)}`)
    expect(result.status).toBe(0)
    expect(existsSync(marker)).toBe(true)
  })
})

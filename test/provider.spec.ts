// WriteProtectSandboxProvider: confine() 结果的 argv 叠加语义.
// 不要求测试宿主存在真实 runner: internals 注入平台与探测结果,
// 全部走真实 confine() 路径.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { WriteProtectSandboxProvider } from '../src/provider.ts'
import { projectTmpDir } from './fixture-root.ts'

type Internals = WriteProtectSandboxProvider['internals']

async function setup(config: Record<string, unknown> = {}, internals: Internals = {}) {
  const ctx = new Context()
  await ctx.plugin(WriteProtectSandboxProvider, config)
  const sandbox = ctx.sandbox as WriteProtectSandboxProvider
  sandbox.internals = internals
  return sandbox
}

function ww(workspaceRoot: string, readOnlyPaths: string[], writablePaths: string[] = []): SandboxPolicy {
  return { mode: 'workspace-write', workspaceRoot, readOnlyPaths, writablePaths }
}

const BWRAP_INTERNALS: Internals = { platform: 'linux', probeBwrap: () => true }
const SEATBELT_INTERNALS: Internals = { platform: 'darwin' }
const LANDLOCK_INTERNALS: Internals = {
  platform: 'linux',
  probeBwrap: () => false,
  probeLandlock: () => 'full',
  landlockLauncher: '/bin/true',
}

// bwrap 的 ro-bind 要求 bind 源在宿主上真实存在, 需要插入断言的用例
// 使用这个真实的临时工作区 (含 gitdir).
const realWs = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-bwrap-')))
mkdirSync(join(realWs, 'gitdir'))
const realExtra = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-bwrap-extra-')))
afterAll(() => {
  rmSync(realWs, { recursive: true, force: true })
  rmSync(realExtra, { recursive: true, force: true })
})

describe('WriteProtectSandboxProvider.confine', () => {
  it('bwrap: 在 -- 之前插入 ro-bind 对, 位于可写 bind 之后', async () => {
    const sandbox = await setup({}, BWRAP_INTERNALS)
    const result = sandbox.confine(['true'], ww(realWs, [join(realWs, 'gitdir')]))
    const separator = result.argv.indexOf('--')
    expect(separator).toBeGreaterThan(-1)
    // 插入点紧邻 -- 之前: 官方 profile 自带的 `--ro-bind / /` 在更早的位置,
    // 叠加的只读 bind 是最后一个 profile 参数.
    expect(result.argv.slice(separator - 3, separator)).toEqual(['--ro-bind', join(realWs, 'gitdir'), join(realWs, 'gitdir')])
    // 可写 bind 先出现, 只读 bind 叠加其后.
    const wsBind = result.argv.indexOf('--bind')
    expect(wsBind).toBeGreaterThan(-1)
    expect(wsBind).toBeLessThan(separator - 3)
    // 包装的命令保持原样.
    expect(result.argv.slice(separator + 1)).toEqual(['true'])
  })

  it('bwrap: 宿主上不存在的保护路径被跳过, argv 其余部分不变', async () => {
    const sandbox = await setup({}, BWRAP_INTERNALS)
    const baseline = sandbox.confine(['true'], ww('/ws', []))
    const result = sandbox.confine(['true'], ww('/ws', ['/definitely-missing-dsh-wp']))
    expect(result.argv).toEqual(baseline.argv)
  })

  it('Seatbelt: 在 -p profile 文本末尾追加 deny 形式, 官方形式保留', async () => {
    const sandbox = await setup({}, SEATBELT_INTERNALS)
    const result = sandbox.confine(['true'], ww('/ws', ['/ws/gitdir']))
    expect(result.argv[0]).toBe('sandbox-exec')
    const profileIndex = result.argv.indexOf('-p')
    const profile = result.argv[profileIndex + 1]!
    expect(profile.endsWith('(deny file-write* (subpath "/ws/gitdir"))')).toBe(true)
    expect(profile).toContain('(version 1)')
    expect(profile).toContain('(allow default)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('(subpath "/ws")')
  })

  it('Seatbelt: 多个保护路径合并进同一条 deny 形式', async () => {
    const sandbox = await setup({}, SEATBELT_INTERNALS)
    const result = sandbox.confine(['true'], ww('/ws', ['/ws/gitdir', '/ws/dist']))
    const profile = result.argv[result.argv.indexOf('-p') + 1]
    expect(profile).toContain('(subpath "/ws/gitdir") (subpath "/ws/dist")')
  })

  it('read-only 模式不叠加 (官方 profile 已全量拒绝)', async () => {
    const sandbox = await setup({}, SEATBELT_INTERNALS)
    const baseline = sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: '/ws' })
    const result = sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: '/ws', readOnlyPaths: ['/ws/gitdir'] })
    expect(result.argv).toEqual(baseline.argv)
  })

  it('空保护列表直接短路', async () => {
    const sandbox = await setup({}, BWRAP_INTERNALS)
    const baseline = sandbox.confine(['true'], ww('/ws', []))
    const result = sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: '/ws', readOnlyPaths: [] })
    expect(result.argv).toEqual(baseline.argv)
  })

  it('Landlock 无法表达子路径例外: argv 保持官方结果', async () => {
    const sandbox = await setup({}, LANDLOCK_INTERNALS)
    const baseline = sandbox.confine(['true'], ww('/ws', []))
    const result = sandbox.confine(['true'], ww('/ws', ['/ws/gitdir']))
    expect(result.argv).toEqual(baseline.argv)
  })

  it('runnerCommand 覆盖的 bwrap 兼容 runner 同样获得 ro-bind 叠加', async () => {
    const sandbox = await setup(
      { runnerCommand: ['my-bwrap-runner'], runnerFailureSignatures: ['my-bwrap-runner:'] },
      {},
    )
    const result = sandbox.confine(['true'], ww(realWs, [join(realWs, 'gitdir')]))
    expect(result.argv[0]).toBe('my-bwrap-runner')
    const separator = result.argv.indexOf('--')
    expect(separator).toBeGreaterThan(-1)
    expect(result.argv).toContain('--ro-bind')
    expect(result.argv.indexOf('--ro-bind')).toBeLessThan(separator)
  })

  it('无配置时与官方 provider 行为一致 (内部探测照常)', async () => {
    const sandbox = await setup({}, BWRAP_INTERNALS)
    expect(sandbox.confine(['true'], ww('/ws', [])).argv[0]).toBe('bwrap')
  })

  it('bwrap: 额外可写 bind 插在保护路径 ro-bind 之前', async () => {
    const sandbox = await setup({}, BWRAP_INTERNALS)
    const result = sandbox.confine(['true'], ww(realWs, [join(realWs, 'gitdir')], [realExtra]))
    const separator = result.argv.indexOf('--')
    expect(result.argv.slice(separator - 3, separator)).toEqual(['--ro-bind', join(realWs, 'gitdir'), join(realWs, 'gitdir')])
    const extraBind = result.argv.lastIndexOf('--bind')
    expect(result.argv.slice(extraBind, extraBind + 3)).toEqual(['--bind', realExtra, realExtra])
    expect(extraBind).toBeLessThan(separator - 3)
  })

  it('bwrap: 宿主上不存在的额外可写根被跳过', async () => {
    const sandbox = await setup({}, BWRAP_INTERNALS)
    const baseline = sandbox.confine(['true'], ww(realWs, []))
    const result = sandbox.confine(['true'], ww(realWs, [], ['/definitely-missing-dsh-wp-extra']))
    expect(result.argv).toEqual(baseline.argv)
  })

  it('Seatbelt: 额外可写 allow 出现在保护 deny 之前', async () => {
    const sandbox = await setup({}, SEATBELT_INTERNALS)
    const result = sandbox.confine(['true'], ww('/ws', ['/ws/gitdir'], ['/extra']))
    const profile = result.argv[result.argv.indexOf('-p') + 1]!
    expect(profile).toContain('(allow file-write* (subpath "/extra"))')
    expect(profile.endsWith('(deny file-write* (subpath "/ws/gitdir"))')).toBe(true)
    expect(profile.lastIndexOf('(allow file-write* (subpath "/extra"))')).toBeLessThan(profile.lastIndexOf('(deny file-write* (subpath "/ws/gitdir"))'))
  })

  it('Landlock: 额外可写根加 --rw, 保护路径仍不叠加', async () => {
    const sandbox = await setup({}, LANDLOCK_INTERNALS)
    const baseline = sandbox.confine(['true'], ww(realWs, []))
    const protectedOnly = sandbox.confine(['true'], ww(realWs, [join(realWs, 'gitdir')]))
    expect(protectedOnly.argv).toEqual(baseline.argv)
    const result = sandbox.confine(['true'], ww(realWs, [join(realWs, 'gitdir')], [realExtra]))
    const separator = result.argv.indexOf('--')
    const extraAt = result.argv.indexOf(realExtra)
    expect(extraAt).toBeGreaterThan(-1)
    expect(extraAt).toBeLessThan(separator)
    expect(result.argv[extraAt - 1]).toBe('--rw')
  })

  it('read-only 模式不叠加额外可写根', async () => {
    const sandbox = await setup({}, SEATBELT_INTERNALS)
    const baseline = sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: '/ws' })
    const result = sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: '/ws', writablePaths: ['/extra'] })
    expect(result.argv).toEqual(baseline.argv)
  })
})

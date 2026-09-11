// darwin Seatbelt 真实组合验证: confine() 改写后的 argv 直接执行,
// 保护路径内的写入被内核拒绝, 其余可写, 官方模式语义不变.
// 仅在 macOS 上运行 (sandbox-exec 是 darwin 链的唯一 runner).
// 嵌套沙箱 (外层已有 Seatbelt 限制) 中运行时, 外层拒绝的操作内层无权放行, "允许写入" 用例可能失败且拒绝用例可能空泛通过 - 内核级断言只在普通终端或 CI 有意义, 属环境限制不再细究.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { WriteProtectSandboxProvider } from '../src/provider.ts'
import { projectTmpDir } from './fixture-root.ts'

/**
 * 造一个经 `open` 启动就会写标记的 app bundle. 直接执行它内部的二进制会被
 * Seatbelt 拦住, 只有经 launchd 代理启动 (不继承 profile) 才能写出标记 ——
 * 标记出现即代表逃逸成功.
 * @param appPath - bundle 路径 (以 .app 结尾).
 * @param marker - bundle 内脚本要写的标记文件路径.
 * @returns 传入的 bundle 路径.
 */
function makeEscapeApp(appPath: string, marker: string): string {
  mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(appPath, 'Contents', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleExecutable</key><string>Escape</string>',
    '<key>CFBundleIdentifier</key><string>dev.dsh-write-protect.escape-e2e</string>',
    '<key>CFBundleName</key><string>Escape</string>',
    '<key>CFBundlePackageType</key><string>APPL</string>',
    '<key>LSBackgroundOnly</key><true/>',
    '</dict></plist>',
    '',
  ].join('\n'))
  const script = join(appPath, 'Contents', 'MacOS', 'Escape')
  writeFileSync(script, `#!/bin/sh\necho escaped > ${JSON.stringify(marker)}\n`)
  chmodSync(script, 0o755)
  return appPath
}

describe.skipIf(process.platform !== 'darwin')('Seatbelt 真实执法 (darwin)', () => {
  const ws = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-e2e-')))
  mkdirSync(join(ws, 'gitdir'))
  const protectedDir = join(ws, 'gitdir')
  const extra = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-e2e-extra-')))
  // allow-list 之外的落点: broker 逃逸成功与否由这里的标记文件判定.
  const outsider = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-e2e-outside-')))
  const escapeMarker = join(outsider, 'escaped.txt')
  const escapeApp = makeEscapeApp(join(ws, 'Escape.app'), escapeMarker)
  // 外层已有 Seatbelt 时内层 sandbox-exec 无法再 apply profile (exit 71).
  const nestedSandbox = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '--', 'true']).status !== 0

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true })
    rmSync(extra, { recursive: true, force: true })
    rmSync(outsider, { recursive: true, force: true })
  })

  /** 轮询等待标记文件出现 (launchd 启动 bundle 是异步的). */
  async function waitForMarker(marker: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return existsSync(marker)
  }

  /** 官方 provider 的原始 argv: 对照组用, 证明逃逸真实存在. */
  async function stockConfine(policy: SandboxPolicy, argv: string[]): Promise<string[]> {
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, {})
    const sandbox = ctx.sandbox as LocalSandboxProvider
    sandbox.internals = { platform: 'darwin' }
    return sandbox.confine(argv, policy).argv
  }

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

  it.skipIf(nestedSandbox)('对照: 官方 profile 下经 open 启动的 app bundle 能写到 allow-list 之外', async () => {
    rmSync(escapeMarker, { force: true })
    run(await stockConfine({ mode: 'workspace-write', workspaceRoot: ws }, ['open', escapeApp]))
    expect(await waitForMarker(escapeMarker, 8000)).toBe(true)
  })

  it.skipIf(nestedSandbox)('broker 加固后经 open 启动的 app bundle 写不出 allow-list', async () => {
    rmSync(escapeMarker, { force: true })
    const argv = await confine({ mode: 'workspace-write', workspaceRoot: ws }, ['open', escapeApp])
    const result = run(argv)
    expect(result.status).not.toBe(0)
    // profile 必须是被正常 apply 的: `sandbox-exec: ` 是官方 runner 的 fail-closed
    // 签名, 出现它说明 profile 本身没跑起来, 那样这条断言就失去意义.
    expect(result.stderr).not.toContain('sandbox-exec: ')
    expect(await waitForMarker(escapeMarker, 3000)).toBe(false)
  })

  it('开关关闭时 Seatbelt argv 与官方 provider 完全一致', async () => {
    const off = await confine({ mode: 'workspace-write', workspaceRoot: ws, hardenBroker: false }, ['true'])
    const stock = await stockConfine({ mode: 'workspace-write', workspaceRoot: ws }, ['true'])
    expect(off).toEqual(stock)
  })
})

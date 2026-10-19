// 模型可见文案的平台差异: Windows 上命令侧没有围栏, 提示词与工具描述都必须直说,
// 其他平台则不该白白多出这句话.

import { describe, expect, it } from 'vitest'
import { requestWritableDescription, writeProtectPromptLines, type PromptInput } from '../src/prompt.ts'

/** 一份"什么都配了"的输入. */
function input(platform: NodeJS.Platform, overrides: Partial<PromptInput> = {}): PromptInput {
  return {
    platform,
    patterns: '.git\n',
    readonlyFileName: '.readonly',
    readDeny: 'secret\n',
    writable: ['/cache'],
    overrides: ['/ws/src'],
    sessionGrants: ['/ws/src'],
    allowWritableRequests: true,
    hardenWsl: false,
    ...overrides,
  }
}

const text = (platform: NodeJS.Platform, overrides: Partial<PromptInput> = {}): string =>
  writeProtectPromptLines(input(platform, overrides)).join(' ')

describe('writeProtectPromptLines 的平台差异', () => {
  it('非 Windows 平台不提收窄, 命令侧照旧算在被围栏里', () => {
    const joined = text('darwin')
    expect(joined).not.toContain('bind only the write and edit tools')
    expect(joined).toContain('the read tools and every sandboxed command refuse to read these paths')
    expect(joined).toContain('sandboxed commands and write/edit tools may write here')
    expect(joined).toContain('bypass write protection for the write/edit tools and for sandboxed commands')
  })

  it('Windows 上明说命令侧既挡不住也拿不到额外根', () => {
    const joined = text('win32')
    expect(joined).toContain('bind only the write and edit tools')
    expect(joined).toContain('neither deny protected paths nor receive additional writable roots or session grants')
    expect(joined).toContain('A command that succeeded is not evidence that a path was checked')
    // 三处具体措辞都要跟着收窄, 否则模型仍会以为命令侧生效.
    expect(joined).not.toContain('sandboxed commands and write/edit tools may write here')
    expect(joined).toContain('the write and edit tools may write here')
    expect(joined).not.toContain('for the write/edit tools and for sandboxed commands')
    expect(joined).toContain('sandboxed commands can still read them on Windows')
    expect(joined).toContain('for the read tools')
  })

  it('Windows 上没有任何围栏条目时不解释围栏边界', () => {
    const joined = text('win32', { patterns: '', readDeny: '', writable: [], overrides: [], sessionGrants: [] })
    expect(joined).not.toContain('bind only the write and edit tools')
    expect(joined).toContain('request_writable_path')
  })

  it('没有任何围栏条目时只剩申请引导', () => {
    const lines = writeProtectPromptLines({
      platform: 'darwin',
      patterns: '',
      readonlyFileName: '',
      readDeny: '',
      writable: [],
      overrides: [],
      sessionGrants: [],
      allowWritableRequests: false,
      hardenWsl: false,
    })
    expect(lines).toEqual(['Extra write access is not granted by this deployment: do not ask for it.'])
  })

  it('WSL 加固只在开启时出现', () => {
    expect(text('linux')).not.toContain('WSL interop hardening is active')
    expect(text('linux', { hardenWsl: true })).toContain('WSL interop hardening is active')
  })
})

describe('requestWritableDescription 的平台差异', () => {
  it('Windows 上补一句授权只到 write / edit', () => {
    expect(requestWritableDescription('win32')).toContain('reaches only the write and edit tools')
  })

  it('其他平台保持原样', () => {
    expect(requestWritableDescription('darwin')).not.toContain('reaches only the write and edit tools')
    expect(requestWritableDescription('darwin')).toContain('stays writable and readable only until the session ends')
  })
})

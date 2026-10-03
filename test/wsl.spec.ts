// wslHardenArgs: 按存在性探测生成 bwrap 叠加参数, 不依赖真实 WSL.

import { describe, expect, it } from 'vitest'
import { isUnderMnt, wslHardenArgs } from '../src/wsl.ts'

const present = new Set([
  '/mnt',
  '/run/WSL',
  '/proc/sys/fs/binfmt_misc',
  '/init',
  '/dev/null',
  '/mnt/c/proj',
])
const exists = (path: string): boolean => present.has(path)

describe('wslHardenArgs', () => {
  it('存在的入口都盖上, 工作区不在 /mnt 下时不重 bind', () => {
    expect(wslHardenArgs({ workspaceRoot: '/home/me/proj', mode: 'workspace-write', exists })).toEqual([
      '--tmpfs', '/mnt',
      '--tmpfs', '/run/WSL',
      '--tmpfs', '/proc/sys/fs/binfmt_misc',
      '--bind', '/dev/null', '/init',
    ])
  })

  it('工作区在 /mnt 下时 tmpfs 之后重新 bind', () => {
    expect(wslHardenArgs({ workspaceRoot: '/mnt/c/proj', mode: 'workspace-write', exists })).toEqual([
      '--tmpfs', '/mnt',
      '--tmpfs', '/run/WSL',
      '--tmpfs', '/proc/sys/fs/binfmt_misc',
      '--bind', '/dev/null', '/init',
      '--bind', '/mnt/c/proj', '/mnt/c/proj',
    ])
  })

  it('read-only 下工作区重挂为 ro-bind', () => {
    const args = wslHardenArgs({ workspaceRoot: '/mnt/c/proj', mode: 'read-only', exists })
    expect(args.slice(-3)).toEqual(['--ro-bind', '/mnt/c/proj', '/mnt/c/proj'])
  })

  it('入口不存在时跳过, 避免 bwrap 因 DEST 缺失拒绝整条命令', () => {
    expect(wslHardenArgs({
      workspaceRoot: '/ws',
      mode: 'workspace-write',
      exists: () => false,
    })).toEqual([])
  })
})

describe('isUnderMnt', () => {
  it('识别 /mnt 与其下路径, 不误伤 /home', () => {
    expect(isUnderMnt('/mnt')).toBe(true)
    expect(isUnderMnt('/mnt/c')).toBe(true)
    expect(isUnderMnt('/home/me')).toBe(false)
    expect(isUnderMnt('/mntable')).toBe(false)
  })
})

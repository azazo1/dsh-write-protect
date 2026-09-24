// ExpansionRefresher: watcher 触发后台重扫, 自适应 TTL 兜底, 用户计数决定 watcher 装卸.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, watch } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExpansionRefresher, type ExpansionInputs } from '../src/refresh.ts'
import { projectTmpDir } from './fixture-root.ts'

/** 本机能否递归监听目录: 不支持时只跑不依赖 watcher 的用例. */
function recursiveWatchUsable(root: string): boolean {
  try {
    watch(root, { recursive: true }, () => {}).close()
    return true
  } catch {
    return false
  }
}

const inputs: ExpansionInputs = { key: 'git', readOnlyText: '.git', writableText: '' }

let workspace: string

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-refresh-')))
})
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

/** 造一个只记录调用次数的展开实现, 行为由 `protectedNow` 决定. */
function recorder(options: { watchingEnabled?: boolean, floorMs?: number, ceilingMs?: number, delayMs?: number, warn?: (message: string) => void } = {}) {
  const state = { calls: 0, protectedNow: false, lastInputs: inputs }
  const refresher = new ExpansionRefresher({
    watchingEnabled: () => options.watchingEnabled ?? true,
    ttlFloorMs: () => options.floorMs ?? 0,
    ttlCeilingMs: () => options.ceilingMs ?? 0,
    inputsOf: () => state.lastInputs,
    expand: async (_root, received) => {
      state.calls += 1
      state.lastInputs = received
      if (options.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, options.delayMs))
      return {
        readOnly: state.protectedNow ? [join(workspace, '.git')] : [],
        writable: [],
        patterns: received.readOnlyText,
      }
    },
    onWarning: options.warn ?? (() => {}),
  })
  return { refresher, state }
}

describe('ExpansionRefresher 的缓存与 TTL', () => {
  it('TTL 内复用缓存, 不重复展开', async () => {
    const { refresher, state } = recorder({ floorMs: 10_000, ceilingMs: 10_000 })
    await refresher.materialize(workspace, inputs)
    await refresher.materialize(workspace, inputs)
    expect(state.calls).toBe(1)
    expect(refresher.peek(workspace, inputs.key)).toBeDefined()
    refresher.dispose()
  })

  it('TTL 过期后重新展开', async () => {
    const { refresher, state } = recorder()
    await refresher.materialize(workspace, inputs)
    expect(refresher.peek(workspace, inputs.key)).toBeUndefined()
    await refresher.materialize(workspace, inputs)
    expect(state.calls).toBe(2)
    refresher.dispose()
  })

  it('文本变化 (key 不符) 时不复用旧结果', async () => {
    const { refresher, state } = recorder({ floorMs: 10_000, ceilingMs: 10_000 })
    await refresher.materialize(workspace, inputs)
    expect(refresher.peek(workspace, 'other-key')).toBeUndefined()
    await refresher.materialize(workspace, { ...inputs, key: 'other-key' })
    expect(state.calls).toBe(2)
    refresher.dispose()
  })

  it('并发请求合并到同一次展开', async () => {
    const { refresher, state } = recorder({ delayMs: 30 })
    await Promise.all([
      refresher.materialize(workspace, inputs),
      refresher.materialize(workspace, inputs),
      refresher.materialize(workspace, inputs),
    ])
    expect(state.calls).toBe(1)
    refresher.dispose()
  })

  it('自适应 TTL 夹在下界与上界之间', async () => {
    const fast = recorder({ delayMs: 1, floorMs: 5_000, ceilingMs: 30_000 })
    await fast.refresher.materialize(workspace, inputs)
    // 展开很快, 倍率算出来的值低于下界: 下界内仍然命中缓存.
    expect(fast.refresher.peek(workspace, inputs.key)).toBeDefined()
    expect(fast.state.calls).toBe(1)
    await fast.refresher.materialize(workspace, inputs)
    expect(fast.state.calls).toBe(1)
    fast.refresher.dispose()

    // 下界被设成 0 时, 倍率算出来的值就是生效值 (这里仍是"立刻过期").
    const aggressive = recorder({ delayMs: 1, floorMs: 0, ceilingMs: 0 })
    await aggressive.refresher.materialize(workspace, inputs)
    expect(aggressive.refresher.peek(workspace, inputs.key)).toBeUndefined()
    aggressive.refresher.dispose()
  })
})

describe('ExpansionRefresher 的 watcher', () => {
  const usable = recursiveWatchUsable(workspace)

  it('有会话运行时装 watcher: 变化后立即后台重扫', async () => {
    if (!usable) return
    const { refresher, state } = recorder({ floorMs: 10_000, ceilingMs: 10_000 })
    refresher.addUser(workspace)
    await refresher.materialize(workspace, inputs)
    expect(state.calls).toBe(1)

    state.protectedNow = true
    mkdirSync(join(workspace, '.git'))
    await vi.waitFor(() => { expect(state.calls).toBe(2) })
    // 重扫之后缓存已经带上新路径, 命令不必再等.
    expect(refresher.peek(workspace, inputs.key)?.readOnly).toEqual([join(workspace, '.git')])
    refresher.dispose()
  })

  it('会话跑完后摘掉 watcher: 之后的改动不再触发重扫', async () => {
    if (!usable) return
    const { refresher, state } = recorder({ floorMs: 10_000, ceilingMs: 10_000 })
    refresher.addUser(workspace)
    await refresher.materialize(workspace, inputs)
    refresher.removeUser(workspace)

    mkdirSync(join(workspace, '.git'))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(state.calls).toBe(1)
    refresher.dispose()
  })

  it('多个会话共用一个根: 最后一个跑完才摘 watcher', async () => {
    if (!usable) return
    const { refresher, state } = recorder({ floorMs: 10_000, ceilingMs: 10_000 })
    refresher.addUser(workspace)
    refresher.addUser(workspace)
    await refresher.materialize(workspace, inputs)
    refresher.removeUser(workspace)

    state.protectedNow = true
    mkdirSync(join(workspace, '.git'))
    await vi.waitFor(() => { expect(state.calls).toBe(2) })
    refresher.dispose()
  })

  it('关掉监听时只靠 TTL, 不装 watcher', async () => {
    const { refresher, state } = recorder({ watchingEnabled: false, floorMs: 10_000, ceilingMs: 10_000 })
    refresher.addUser(workspace)
    await refresher.materialize(workspace, inputs)
    mkdirSync(join(workspace, '.git'))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(state.calls).toBe(1)
    refresher.dispose()
  })

  it('dispose 之后不再重扫', async () => {
    if (!usable) return
    const { refresher, state } = recorder({ floorMs: 10_000, ceilingMs: 10_000 })
    refresher.addUser(workspace)
    await refresher.materialize(workspace, inputs)
    refresher.dispose()
    mkdirSync(join(workspace, '.git'))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(state.calls).toBe(1)
  })
})

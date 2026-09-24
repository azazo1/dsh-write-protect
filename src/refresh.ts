/**
 * 保护路径展开结果的保鲜: 给正在运行的会话的工作区根装递归 watcher, watcher 一报
 * 变化就立刻在后台重扫; 没有事件时用自适应 TTL 兜底.
 *
 * 为什么需要它: 命令侧 (bwrap 的只读挂载) 只能消费真实路径, 所以展开清单是命令侧
 * 保护的唯一来源; 会话中途才出现的受保护路径 (例如 `git init` 出来的 `.git`) 若不
 * 在清单里, 那条命令就写得进去. watcher 负责"变化之后尽快重算", TTL 负责"watcher
 * 漏事件时也不会一直陈旧".
 *
 * 生命周期跟着 agent 运行状态走: 运行时装 watcher, 运行结束或会话销毁时摘掉, 空闲
 * 不占资源. 工作区根只接受本地路径 —— 调用方取不到本地可监听路径时直接不装 watcher,
 * 退化成纯 TTL.
 * @module dsh-write-protect/refresh
 */

import { existsSync, watch, type FSWatcher } from 'node:fs'

/** 一次展开的结果. */
export interface ExpansionSnapshot {
  readonly readOnly: readonly string[]
  readonly writable: readonly string[]
  readonly patterns: string
}

/** 一次展开的输入: 缓存键与两份文本. */
export interface ExpansionInputs {
  /** 缓存键: 两份文本的合并结果, 任一变化都要重新展开. */
  readonly key: string
  /** 生效的保护路径原文. */
  readonly readOnlyText: string
  /** 额外可写根文本. */
  readonly writableText: string
}

export interface RefresherOptions {
  /** 是否装 watcher (设置项 `watchProtectedPaths`); 关掉后只剩 TTL 兜底. */
  readonly watchingEnabled: () => boolean
  /** 自适应 TTL 下界 (毫秒). */
  readonly ttlFloorMs: () => number
  /** 自适应 TTL 上界 (毫秒). */
  readonly ttlCeilingMs: () => number
  /** 后台重扫前重新取一次当前输入 (设置页可能刚改过文本). */
  readonly inputsOf: (workspaceRoot: string) => ExpansionInputs
  /** 真正执行一次展开. */
  readonly expand: (workspaceRoot: string, inputs: ExpansionInputs) => Promise<ExpansionSnapshot>
  /** 降级 / 失败告警 (去重由调用方负责). */
  readonly onWarning: (message: string) => void
}

/** watcher 事件的合并窗口: 一次改动通常连着好几个事件. */
const WATCH_DEBOUNCE_MS = 50

/** 自适应 TTL 的倍率: 上次展开耗时的若干倍内认为结果还算新鲜. */
const TTL_FACTOR = 10

interface Entry {
  key: string
  snapshot: ExpansionSnapshot
  at: number
  ttlMs: number
  dirty: boolean
  /** 正在运行的会话数 (按会话去重后计数); 归零即摘 watcher. */
  users: number
  watcher?: FSWatcher
  debounce?: ReturnType<typeof setTimeout>
  inflight?: Promise<ExpansionSnapshot>
}

/** 空快照: 还没有展开过时的占位. */
function emptyEntry(): Entry {
  return {
    key: '',
    snapshot: { readOnly: [], writable: [], patterns: '' },
    at: 0,
    ttlMs: 0,
    dirty: true,
    users: 0,
  }
}

export class ExpansionRefresher {
  private readonly entries = new Map<string, Entry>()
  private warnedWatcherFailure = false

  constructor(private readonly options: RefresherOptions) {}

  /**
   * 缓存里仍然可用的快照. 文本换过 (key 不符)、被 watcher 标脏、或超过 TTL 时返回
   * undefined, 交给 {@link materialize} 重新展开.
   */
  peek(workspaceRoot: string, key: string): ExpansionSnapshot | undefined {
    const entry = this.entries.get(workspaceRoot)
    if (entry === undefined) return undefined
    if (entry.key !== key || entry.dirty) return undefined
    const ttl = this.ttlOf(entry)
    if (Date.now() - entry.at >= ttl) return undefined
    return entry.snapshot
  }

  /**
   * 取展开快照: 命中缓存直接返回, 否则等一次展开. 同根的并发请求会合并到同一次展开上,
   * 所以命令侧不会因为彼此抢缓存而重复扫盘.
   */
  async materialize(workspaceRoot: string, inputs: ExpansionInputs): Promise<ExpansionSnapshot> {
    const cached = this.peek(workspaceRoot, inputs.key)
    if (cached !== undefined) return cached
    return await this.expand(workspaceRoot, inputs)
  }

  /** 有会话开始跑: 计数 +1, 第一个用户进来时装 watcher. */
  addUser(workspaceRoot: string): void {
    const entry = this.entryOf(workspaceRoot)
    entry.users += 1
    if (entry.users === 1) this.installWatcher(workspaceRoot, entry)
  }

  /** 有会话跑完或销毁: 计数 -1, 归零时摘 watcher (缓存留着, 下次仍可用). */
  removeUser(workspaceRoot: string): void {
    const entry = this.entries.get(workspaceRoot)
    if (entry === undefined || entry.users === 0) return
    entry.users -= 1
    if (entry.users === 0) this.closeWatcher(entry)
  }

  /** 释放全部 watcher 与等待中的定时器. */
  dispose(): void {
    for (const entry of this.entries.values()) {
      this.closeWatcher(entry)
      if (entry.debounce !== undefined) clearTimeout(entry.debounce)
      entry.debounce = undefined
    }
    this.entries.clear()
  }

  private entryOf(workspaceRoot: string): Entry {
    const existing = this.entries.get(workspaceRoot)
    if (existing !== undefined) return existing
    const created = emptyEntry()
    this.entries.set(workspaceRoot, created)
    return created
  }

  /** 自适应 TTL: 上次展开耗时乘倍数, 夹在设置的下界与上界之间. */
  private ttlOf(entry: Entry): number {
    const floor = Math.max(0, this.options.ttlFloorMs())
    const ceiling = Math.max(floor, this.options.ttlCeilingMs())
    if (entry.ttlMs <= 0) return ceiling
    return Math.min(Math.max(entry.ttlMs, floor), ceiling)
  }

  /** 执行一次展开, 并把耗时换算成这棵根下一轮的自适应 TTL. */
  private async expand(workspaceRoot: string, inputs: ExpansionInputs): Promise<ExpansionSnapshot> {
    const entry = this.entryOf(workspaceRoot)
    if (entry.inflight !== undefined) return await entry.inflight
    const started = Date.now()
    const promise = this.options.expand(workspaceRoot, inputs)
    entry.inflight = promise
    try {
      const snapshot = await promise
      entry.key = inputs.key
      entry.snapshot = snapshot
      entry.at = Date.now()
      entry.ttlMs = (Date.now() - started) * TTL_FACTOR
      entry.dirty = false
      return snapshot
    } finally {
      if (entry.inflight === promise) entry.inflight = undefined
    }
  }

  /** watcher 报告变化: 标脏并在合并窗口后后台重扫, 让下一条命令直接吃到新清单. */
  private markDirty(workspaceRoot: string): void {
    const entry = this.entryOf(workspaceRoot)
    entry.dirty = true
    if (entry.debounce !== undefined) clearTimeout(entry.debounce)
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined
      void this.refreshInBackground(workspaceRoot)
    }, WATCH_DEBOUNCE_MS)
  }

  /** 后台重扫: 失败只告警, 不抛给调用方 (缓存仍然是旧值, 下一条命令会再试). */
  private async refreshInBackground(workspaceRoot: string): Promise<void> {
    try {
      await this.expand(workspaceRoot, this.options.inputsOf(workspaceRoot))
    } catch (error: unknown) {
      this.options.onWarning(`background rescan of "${workspaceRoot}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 装递归 watcher. 目录不存在时静默跳过 (TTL 仍兜底); 装不上则告警一次后退回纯 TTL. */
  private installWatcher(workspaceRoot: string, entry: Entry): void {
    if (!this.options.watchingEnabled() || entry.watcher !== undefined) return
    if (!existsSync(workspaceRoot)) return
    try {
      const watcher = watch(workspaceRoot, { recursive: true }, () => this.markDirty(workspaceRoot))
      watcher.on('error', (error: unknown) => {
        this.warnWatcherFailure(workspaceRoot, error)
        this.closeWatcher(entry)
      })
      entry.watcher = watcher
    } catch (error: unknown) {
      this.warnWatcherFailure(workspaceRoot, error)
    }
  }

  /** 摘掉 watcher 并放弃这一轮攒下的重扫计划. */
  private closeWatcher(entry: Entry): void {
    entry.watcher?.close()
    entry.watcher = undefined
    if (entry.debounce !== undefined) {
      clearTimeout(entry.debounce)
      entry.debounce = undefined
    }
  }

  /** 装不上 watcher 只告警一次: 之后靠 TTL 兜底, 不再反复尝试刷屏. */
  private warnWatcherFailure(workspaceRoot: string, error: unknown): void {
    if (this.warnedWatcherFailure) return
    this.warnedWatcherFailure = true
    this.options.onWarning(`cannot watch "${workspaceRoot}" for write-protect changes (${error instanceof Error ? error.message : String(error)}); falling back to a time-based refresh only`)
  }
}

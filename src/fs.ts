/**
 * 替换 base 的 `fs-sandbox` 行: 官方 `SandboxedFileSystem` 的模式围栏原样
 * 保留, 只在两个变更入口 (writeText/editText) 之前追加保护路径检查. 读取
 * 永远放行; `read-only` 模式官方已全量拒绝, 检查只会在 `workspace-write` 与
 * `danger-full-access` 下生效 — 后者正是本插件的立足点: 进程沙箱整体放开时,
 * 用户声明的保护路径对 write/edit 工具仍然拒绝写入.
 * @module dsh-write-protect/fs
 */

import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isPathUnder } from './containment.ts'

export const name = 'dsh-write-protect-fs'

export class WriteProtectFileSystem extends SandboxedFileSystem {
  /**
   * 先做保护路径检查, 再委托继承的围栏写入. 拒绝发生在官方 checkedTarget
   * 之前, 保护语义与模式围栏彼此独立.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    await this.assertNotProtected(target, sandboxPolicy)
    return super.writeText(target, content, expected, signal, sandboxPolicy)
  }

  /** 先做保护路径检查, 再委托继承的围栏编辑. */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    await this.assertNotProtected(target, sandboxPolicy)
    return super.editText(target, edit, expected, signal, sandboxPolicy)
  }

  /**
   * 目标落在保护路径之下时拒绝. 拒绝沿用官方围栏的 `FS_SANDBOX_DENIED` 码,
   * 工具层的拒绝标记与升级引导保持一致, message 中说明是本插件实施的拒绝.
   * 检查作用于重新 canonical 化的路径 (与官方围栏同一防御面): 指向保护目录
   * 内部的符号链接同样被拒, 指向外部的不受影响.
   */
  private async assertNotProtected(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<void> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    if (policy.mode === 'read-only') return
    const paths = policy.readOnlyPaths ?? []
    if (paths.length === 0) return
    const fresh = await this.resolve(target.displayPath)
    for (const root of paths) {
      if (await isPathUnder(fresh.targetKey, root)) {
        throw new FsError(
          `cannot write "${target.displayPath}": the path is write-protected by dsh-write-protect (beneath ${root})`,
          'FS_SANDBOX_DENIED',
        )
      }
    }
  }
}

export default WriteProtectFileSystem

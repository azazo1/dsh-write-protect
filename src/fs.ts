/**
 * 替换 base 的 `fs-sandbox` 行: 官方模式围栏由本类接管 allow-list, 再叠加
 * 保护路径拒绝. 读取永远放行; `read-only` 仍全量拒绝 (额外可写根不打穿);
 * `workspace-write` 在官方 `writableRoots` 之外并入 `policy.writablePaths`;
 * `danger-full-access` 进程沙箱整体放开时, 用户声明的保护路径对 write/edit
 * 工具仍然拒绝写入.
 * @module dsh-write-protect/fs
 */

import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isPathUnder } from './containment.ts'

export const name = 'dsh-write-protect-fs'
export class WriteProtectFileSystem extends SandboxedFileSystem {
  /**
   * 先做本插件的 allow-list 与保护路径检查, 再委托 LocalFileSystem 的原子
   * 写入. 不调用 SandboxedFileSystem.writeText: 官方 checkedTarget 看不见
   * `writablePaths`, 额外可写根会被误拒.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const gated = await this.gateMutation(target, sandboxPolicy)
    return LocalFileSystem.prototype.writeText.call(this, gated, content, expected, signal)
  }

  /** 先做本插件的 allow-list 与保护路径检查, 再委托 LocalFileSystem 的原子编辑. */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const gated = await this.gateMutation(target, sandboxPolicy)
    return LocalFileSystem.prototype.editText.call(this, gated, edit, expected, signal)
  }

  /**
   * 按官方模式语义围栏, 再拒绝保护路径. `read-only` 全拒; `workspace-write`
   * 要求目标落在 `writableRoots ∪ writablePaths` 之下; `danger-full-access`
   * 跳过 allow-list, 仍检查保护路径. 返回给底层写入的目标在 workspace-write
   * 下是重新 canonical 化的 fresh target, 与官方 checkedTarget 一致.
   */
  private async gateMutation(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    if (policy.mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    if (policy.mode === 'danger-full-access') {
      await this.denyIfProtected(target.displayPath, (await this.resolve(target.displayPath)).targetKey, policy)
      return target
    }
    const fresh = await this.resolve(target.displayPath)
    const roots = [...writableRoots(policy), ...(policy.writablePaths ?? [])]
    let contained = false
    for (const root of roots) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    await this.denyIfProtected(target.displayPath, fresh.targetKey, policy)
    return fresh
  }

  /**
   * 目标落在保护路径之下时拒绝. 拒绝沿用官方围栏的 `FS_SANDBOX_DENIED` 码,
   * 工具层的拒绝标记与升级引导保持一致, message 中说明是本插件实施的拒绝.
   */
  private async denyIfProtected(displayPath: string, targetKey: string, policy: SandboxExecutionPolicy): Promise<void> {
    const paths = policy.readOnlyPaths ?? []
    if (paths.length === 0) return
    for (const root of paths) {
      if (await isPathUnder(targetKey, root)) {
        throw new FsError(
          `cannot write "${displayPath}": the path is write-protected by dsh-write-protect (beneath ${root})`,
          'FS_SANDBOX_DENIED',
        )
      }
    }
  }
}

export default WriteProtectFileSystem

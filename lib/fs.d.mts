import { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from "@deepseek-ai/dsh-fs";
//#region src/fs.d.ts
export declare const name = "dsh-write-protect-fs";
export declare class WriteProtectFileSystem extends SandboxedFileSystem {
  /**
   * 先做本插件的 allow-list 与保护路径检查, 再委托 LocalFileSystem 的原子
   * 写入. 不调用 SandboxedFileSystem.writeText: 官方 checkedTarget 看不见
   * `writablePaths`, 额外可写根会被误拒.
   */
  writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>;
  /** 先做本插件的 allow-list 与保护路径检查, 再委托 LocalFileSystem 的原子编辑. */
  editText(target: FsTarget, edit: FsEditRequest, expected?: {
    version: FsVersion;
  }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome>;
  /**
   * 按官方模式语义围栏, 再拒绝保护路径. `read-only` 全拒; `workspace-write`
   * 要求目标落在 `writableRoots ∪ writablePaths` 之下; `danger-full-access`
   * 跳过 allow-list, 仍检查保护路径. 返回给底层写入的目标在 workspace-write
   * 下是重新 canonical 化的 fresh target, 与官方 checkedTarget 一致.
   */
  private gateMutation;
  /**
   * 目标落在保护路径之下时拒绝. 拒绝沿用官方围栏的 `FS_SANDBOX_DENIED` 码,
   * 工具层的拒绝标记与升级引导保持一致, message 中说明是本插件实施的拒绝.
   */
  private denyIfProtected;
}
//#endregion
export { WriteProtectFileSystem as default };
//# sourceMappingURL=fs.d.mts.map
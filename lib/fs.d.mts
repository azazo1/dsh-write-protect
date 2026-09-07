import { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from "@deepseek-ai/dsh-fs";
//#region src/fs.d.ts
export declare const name = "dsh-write-protect-fs";
export declare class WriteProtectFileSystem extends SandboxedFileSystem {
  /**
   * 先做保护路径检查, 再委托继承的围栏写入. 拒绝发生在官方 checkedTarget
   * 之前, 保护语义与模式围栏彼此独立.
   */
  writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>;
  /** 先做保护路径检查, 再委托继承的围栏编辑. */
  editText(target: FsTarget, edit: FsEditRequest, expected?: {
    version: FsVersion;
  }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome>;
  /**
   * 目标落在保护路径之下时拒绝. 拒绝沿用官方围栏的 `FS_SANDBOX_DENIED` 码,
   * 工具层的拒绝标记与升级引导保持一致, message 中说明是本插件实施的拒绝.
   * 检查作用于重新 canonical 化的路径 (与官方围栏同一防御面): 指向保护目录
   * 内部的符号链接同样被拒, 指向外部的不受影响.
   */
  private assertNotProtected;
}
//#endregion
export { WriteProtectFileSystem as default };
//# sourceMappingURL=fs.d.mts.map
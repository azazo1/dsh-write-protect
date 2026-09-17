import { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from "@deepseek-ai/dsh-fs";
//#region src/fs.d.ts
export declare const name = "dsh-write-protect-fs";
export declare class WriteProtectFileSystem extends SandboxedFileSystem {
  /** 按配置文本缓存的匹配器: 文本是唯一输入, 设置改动换文本即自动失效. */
  private compiledPatterns;
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
   * 目标落在保护路径之下时拒绝. 保护文本随执行 policy 一起传入
   * (`readOnlyPatterns`), 按它逐条匹配目标路径: 命中的可以是目标自身, 也可以是
   * 它的某个祖先目录 —— 这正是"被保护的目录连同其后代一起挡"的前缀围栏语义.
   *
   * 目标是 write / edit 要写的文件 (`isDir` 恒为 false), 所以带尾部 `/` 的条目
   * 只会在祖先目录上命中, 与 gitignore 一致. 拒绝沿用官方围栏的
   * `FS_SANDBOX_DENIED` 码, 工具层的拒绝标记与升级引导保持一致, message 中说明
   * 是本插件实施的拒绝以及命中的是哪条模式.
   */
  private denyIfProtected;
  /** 按文本取编译结果, 同一文本只编译一次. */
  private patternSetFor;
}
//#endregion
export { WriteProtectFileSystem as default };
//# sourceMappingURL=fs.d.mts.map
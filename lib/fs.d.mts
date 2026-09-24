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
   * 要求目标落在 `writableRoots ∪ writablePaths` 之下, 并检查保护路径;
   * `danger-full-access` 完全放行 (既跳过 allow-list, 也不应用保护路径与规则
   * 文件判定) —— 该模式是用户显式选择的"不设限", 沙箱本来就不介入. 返回给底层
   * 写入的目标在 workspace-write 下是重新 canonical 化的 fresh target, 与官方
   * checkedTarget 一致.
   */
  private gateMutation;
  /**
   * 目标落在保护路径之下时拒绝. 规则文件本身先挡 (硬保护), 再看本会话的保护
   * 旁路, 最后按生效的保护路径**原文**逐路径匹配目标: 命中的可以是目标自身, 也
   * 可以是它的某个祖先目录 —— 这正是"被保护的目录连同其后代一起挡"的前缀围栏
   * 语义, 而且不依赖任何扫盘结果.
   *
   * 执行 policy 没有带模式原文时 (不是本插件的 policy service 生成的) 退回按
   * 枚举出来的路径做前缀比较. 拒绝沿用官方围栏的 `FS_SANDBOX_DENIED` 码, 工具层
   * 的拒绝标记与升级引导保持一致, message 中说明是本插件实施的拒绝, 指出命中的
   * 是哪条模式, 并告诉模型可以申请本会话授权.
   */
  private denyIfProtected;
  /** 按文本取编译结果, 同一文本只编译一次. */
  private patternSetFor;
}
//#endregion
export { WriteProtectFileSystem as default };
//# sourceMappingURL=fs.d.mts.map
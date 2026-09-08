import { ConfinedArgv, SandboxPolicy } from "@deepseek-ai/dsh-sandbox";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
//#region src/provider.d.ts
export declare const name = "dsh-write-protect-provider";
export declare class WriteProtectSandboxProvider extends LocalSandboxProvider {
  private warnedUnsupported;
  /**
   * 按官方结果包装 argv 后叠加额外可写根与保护路径. 只在 `workspace-write`
   * 下生效: `read-only` 的官方 profile 已全量拒绝, 额外可写不打穿.
   */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv;
  /** 在 `--` 之前插入一组 profile 参数. */
  private insertBeforeSeparator;
  /**
   * bwrap: 在 `--` 分隔符之前插入可写 bind 对. 后挂载覆盖早挂载, 必须出现在
   * 保护路径的 ro-bind 之前. 宿主上不存在或解析为文件系统根的路径跳过.
   */
  private withBwrapBinds;
  /**
   * bwrap: 在 `--` 分隔符之前插入 ro-bind 对. bwrap 要求 bind 源存在, 宿主上
   * 尚不存在的路径跳过并告警 (fs 工具半区仍会拒绝这些路径下的写入).
   */
  private withBwrapReadonly;
  /**
   * Landlock: 在 `--` 之前插入 `--rw` 授权. 不存在或文件系统根跳过;
   * 保护路径仍无法表达, 由调用方告警.
   */
  private withLandlockWritable;
  /**
   * Seatbelt: 在 `-p` 的 profile 文本末尾追加一条合并的 allow 形式. 随后
   * 的 deny 仍由 withSeatbeltDenials 追加, 保护路径优先.
   */
  private withSeatbeltAllows;
  /**
   * Seatbelt: 在 `-p` 的 profile 文本末尾追加一条合并的 deny 形式. 每条
   * `(subpath "...")` 都经过 SBPL 字符串转义; profile 形状缺失时按不支持
   * 告警并保持官方结果.
   */
  private withSeatbeltDenials;
  /** 把一条 SBPL 形式追加到 `-p` profile 文本末尾. */
  private appendSeatbeltForm;
  /** 无法表达子路径保护的 runner: 只告警一次, 命令按官方 profile 运行. */
  private warnUnsupported;
  /** bwrap 无法 ro-bind 的缺失路径: 告警并说明 write/edit 工具侧仍然受保护. */
  private warnMissing;
  /** bwrap / Landlock 无法授权的缺失额外可写根: 告警, fs 围栏仍会按词法放行. */
  private warnMissingWritable;
}
//#endregion
export { WriteProtectSandboxProvider as default };
//# sourceMappingURL=provider.d.mts.map
import { ConfinedArgv, SandboxPolicy } from "@deepseek-ai/dsh-sandbox";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
//#region src/provider.d.ts
export declare const name = "dsh-write-protect-provider";
export declare class WriteProtectSandboxProvider extends LocalSandboxProvider {
  private warnedUnsupported;
  /**
   * 按官方结果包装 argv 后叠加保护路径. 只在 `workspace-write` 下生效:
   * `read-only` 的官方 profile 已全量拒绝; 保护路径来自 policy 注入的
   * canonical 列表 (空列表直接短路).
   */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv;
  /**
   * bwrap: 在 `--` 分隔符之前插入 ro-bind 对. bwrap 要求 bind 源存在, 宿主上
   * 尚不存在的路径跳过并告警 (fs 工具半区仍会拒绝这些路径下的写入).
   */
  private withBwrapReadonly;
  /**
   * Seatbelt: 在 `-p` 的 profile 文本末尾追加一条合并的 deny 形式. 每条
   * `(subpath "...")` 都经过 SBPL 字符串转义; profile 形状缺失时按不支持
   * 告警并保持官方结果.
   */
  private withSeatbeltDenials;
  /** 无法表达子路径保护的 runner: 只告警一次, 命令按官方 profile 运行. */
  private warnUnsupported;
  /** bwrap 无法 ro-bind 的缺失路径: 告警并说明 write/edit 工具侧仍然受保护. */
  private warnMissing;
}
//#endregion
export { WriteProtectSandboxProvider as default };
//# sourceMappingURL=provider.d.mts.map
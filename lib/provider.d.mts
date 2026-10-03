import { ConfinedArgv, SandboxPolicy } from "@deepseek-ai/dsh-sandbox";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
//#region src/provider.d.ts
export declare const name = "dsh-write-protect-provider";
export declare class WriteProtectSandboxProvider extends LocalSandboxProvider {
  internals: LocalSandboxProvider['internals'] & {
    /** 测试注入: 覆盖 WSL 探测. 生产路径不设 internals.platform, 走 isWslHost(). */
    probeWsl?: () => boolean;
  };
  private warnedUnsupported;
  private warnedLandlockOverride;
  private warnedLandlockWsl;
  /**
   * 按官方结果包装 argv 后叠加额外可写根, 保护路径, 本会话授权, broker 逃逸
   * 加固与 WSL 互操作加固. Seatbelt 在两种模式下都要加固: `read-only` 的官方
   * profile 同样是 `(allow default)`, 同样能被 `open` 打穿, 只是额外可写根仍
   * 不打穿它. WSL 加固同理: Windows 进程写的是真实磁盘, `read-only` 的
   * `--ro-bind / /` 一样挡不住, 所以不区分模式.
   *
   * 叠加顺序是有意的 (两条链路都按"后匹配 / 后挂载生效"):
   *   0. WSL 互操作加固 (tmpfs `/mnt` 等, 必须早于额外可写 bind, 这样
   *      `/mnt` 下的额外根才能在 tmpfs 之后重新露出来);
   *   1. 额外可写根 (设置页声明的与经审批的工作区外路径);
   *   2. 保护路径 (ro-bind / deny);
   *   3. 本会话的保护旁路 (`writableOverrides`) —— 它要在保护路径之后才能把被
   *      授权的子树从只读里翻回来, 否则命令侧就永远看不到本会话的授权.
   */
  confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv>;
  /**
   * 进程沙箱需要枚举路径. 生产路径上 policy 由本插件的 policy service 生成, 走
   * `materialize()` 等完整异步展开; 本会话授权是审批阶段就定好的绝对路径, 与
   * 缓存里已有的清单一起从 policy 并进来. 单测直接塞 `readOnlyPaths` /
   * `writablePaths` 时沿用那份清单.
   *
   * 取 policy service 走 `ctx.get()` 而不是 `ctx.sandboxPolicy`: 官方
   * `LocalSandboxProvider` 没有声明这个 inject, 直接读会在真实实例里抛
   * "cannot get property ... without inject"; `get()` 不需要声明, 服务缺失时给
   * undefined, 正好落到下面那份按 policy 清单的退路.
   */
  private overlayPaths;
  /**
   * Seatbelt: 追加额外可写 allow, 保护路径 deny (枚举清单与按原文生成的正则),
   * 本会话旁路的 allow, 最后是 broker 逃逸拒绝形式. 结尾的 deny 必须留在 profile
   * 末尾才能盖过 `(allow default)`; 旁路的 allow 又必须排在保护 deny 之后, 否则
   * 那条 deny 会盖掉它.
   * `hardenBroker` 被显式关掉时只跳过 broker 拒绝形式, 命令按官方 profile 运行.
   */
  private hardenSeatbelt;
  /**
   * 当前这次 confine 要不要叠加 WSL 加固. `hardenWsl === false` 显式关掉;
   * 未声明按开启. 测试注入 `internals.platform` 时必须再给 `probeWsl`, 否则
   * 默认否, 避免 WSL 宿主上的 argv 单测被真实探测打乱.
   */
  private shouldHardenWsl;
  /** 在 `--` 之前插入 WSL 互操作加固参数 (tmpfs `/mnt` 等). */
  private withWslHarden;
  /** 在 `--` 之前插入一组 profile 参数. */
  private insertBeforeSeparator;
  /**
   * bwrap: 在 `--` 分隔符之前插入可写 bind 对. 后挂载覆盖早挂载, 必须出现在
   * 保护路径的 ro-bind 之前. 宿主上不存在或解析为文件系统根的路径跳过.
   */
  private withBwrapBinds;
  /**
   * bwrap: 在 `--` 分隔符之前插入本会话保护旁路的可写 bind 对. 它必须排在保护
   * 路径的 ro-bind **之后**, 否则那些 ro-bind 会把授权子树又压回只读. 宿主上
   * 尚不存在的路径 bwrap 无法挂载, 跳过并告警 (目录建出来后下一次命令即生效).
   */
  private withBwrapOverrideBinds;
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
  /** 把一组 SBPL 形式追加到 `-p` profile 文本末尾, 形状缺失时告警并保持官方结果. */
  private appendSeatbelt;
  /** 无法表达子路径保护的 runner: 只告警一次, 命令按官方 profile 运行. */
  private warnUnsupported;
  /** bwrap 无法 ro-bind 的缺失路径: 告警并说明 write/edit 工具侧仍然受保护. */
  private warnMissing;
  /** bwrap / Landlock 无法授权的缺失额外可写根: 告警, fs 围栏仍会按词法放行. */
  private warnMissingWritable;
  /**
   * Landlock 是纯 allow-list, 无法表达"父目录只读, 其中一棵子树可写": 把保护
   * 旁路通过 `--rw` 加进去会连同上方被保护的父目录一起放开, 反而扩大权限, 因此
   * 命令侧不叠加它, 只告警一次.
   */
  private warnLandlockOverride;
  /**
   * Landlock 不能藏挂载点, 也就挡不住 WSL 的 PE 互操作: 只告警一次, 命令按
   * 官方 profile 跑.
   */
  private warnLandlockWsl;
  /** bwrap 无法挂载的缺失保护旁路: 告警, write/edit 侧仍然按授权放行. */
  private warnMissingOverride;
}
//#endregion
export { WriteProtectSandboxProvider as default };
//# sourceMappingURL=provider.d.mts.map
import z from "@deepseek-ai/schemastery";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { SandboxExecutionPolicy, SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { Context } from "@deepseek-ai/cordis";
//#region src/policy.d.ts
export declare const name = "dsh-write-protect-policy";
/** 插件配置: 官方 policy 的部署字段原样保留, 外加保护路径与额外可写根部署 base. */
export interface Config {
  /** 会话启动时的文件沙箱模式 (缺省 `read-only`, 与官方一致). */
  mode?: SandboxMode;
  /** 无会话调用与会话没有 cwd 时的回退工作区根 (缺省 `process.cwd()`). */
  workspaceRoot?: string;
  /**
   * 受保护路径部署 base: 每项一行 gitignore 语义模式, 数组逐行合并为生效文本.
   * 不含 `/` 的条目任意层级匹配, 含开头或中间 `/` 的条目锚定工作区根,
   * `//` 开头为文件系统绝对路径; `!` 按 last-match-wins 取反.
   * 用户在 Web 设置页保存过 patterns 文本后该数组不再生效.
   */
  readOnlyPaths?: string[];
  /**
   * 额外可写根部署 base: 每项一行字面路径, 数组逐行合并为生效文本.
   * 行首 `~` / `~/...` 为当前用户家目录, `$NAME` / `${NAME}` 为环境变量;
   * `//` 或宿主绝对路径按文件系统解析, 其余相对当前工作区 (含 `..`).
   * 只在 `workspace-write` 下并进 allow-list, 不打穿 `read-only`;
   * 保护路径优先. 用户保存过 writablePatterns 文本后该数组不再生效.
   */
  writablePaths?: string[];
  /**
   * macOS Seatbelt broker 逃逸加固的部署 base, 缺省开启 (见
   * `DEFAULT_HARDEN_BROKER`). 用户在设置页拨动开关后该值不再生效.
   */
  hardenBroker?: boolean;
}
export declare class WriteProtectPolicyService extends SandboxPolicyService {
  static Config: z<Schemastery.ObjectS<{
    mode: z<"read-only" | "workspace-write" | "danger-full-access", "read-only" | "workspace-write" | "danger-full-access">;
    workspaceRoot: z<string, string>;
    readOnlyPaths: z<string[], string[]>;
    writablePaths: z<string[], string[]>;
    hardenBroker: z<boolean, boolean>;
  }>, Schemastery.ObjectT<{
    mode: z<"read-only" | "workspace-write" | "danger-full-access", "read-only" | "workspace-write" | "danger-full-access">;
    workspaceRoot: z<string, string>;
    readOnlyPaths: z<string[], string[]>;
    writablePaths: z<string[], string[]>;
    hardenBroker: z<boolean, boolean>;
  }>>;
  private readonly baseEntries;
  private readonly writableBaseEntries;
  private readonly hardenBrokerBase;
  private settingsOwner;
  /**
   * 每个 (两份文本, 工作区根) 的展开结果. 结果只增不减: 同步展开是被预算
   * 截断的浅层子集, 后台补全的完整结果按并集合并进来. 合并是安全的 ——
   * 去留由同一条 last-match-wins 谓词决定, 两次展开的差异只在"访问到哪些
   * 候选", 所以并集不会重新放行被取反剔除的路径; 反过来, 也不能用更差的
   * 同步部分结果覆盖已经拿到的完整结果, 否则保护范围会在两个值之间反复跳.
   *
   * `status` 决定重算节奏: `partial` 走短 TTL (同步遍历有界, 重算便宜, 能尽快
   * 纳入新建路径); `complete` 与 `exhausted` 走长 TTL —— 后者表示后台补全
   * 也到顶了, 对同一个根不再做无望的全量扫描.
   */
  private readonly expanded;
  /** 上一次后台补全结束的时间, 用于限制后台全量补全的启动频率. */
  private fullExpandedAt;
  /** 后台补全的在飞标记; 配置 / 工作区根变化时靠 generation 丢弃过期结果. */
  private fullRefresh;
  /** 已判定"超出异步补全预算"的工作区根: 不再反复做无望的全量扫描. */
  private readonly exhaustedRoots;
  private generation;
  private disposed;
  private readonly warned;
  constructor(ctx: Context, config: Config);
  /** 部署 base 的保护路径文本形态 (patch 数组逐行合并). */
  private baseText;
  /** 部署 base 的额外可写根文本形态 (patch 数组逐行合并). */
  private writableBaseText;
  /** 当前生效的保护路径文本: 用户在设置页保存过的 patterns 覆盖部署 base. */
  private currentText;
  /** 当前生效的额外可写文本: 用户保存过的 writablePatterns 覆盖部署 base. */
  private currentWritableText;
  /** 当前生效的 broker 加固开关: 用户拨动过设置页开关则以其为准, 否则走部署 base. */
  private currentHardenBroker;
  /** 逐条告警, 同一文本只出现一次. */
  private warnAll;
  /**
   * 展开当前生效文本为 canonical 保护路径与额外可写根, 按
   * (两份文本, 工作区根) 缓存; 同时给出生效的保护路径**原文** (fs 围栏按它逐条
   * 匹配, 不依赖枚举) 与枚举是否被截断.
   *
   * 同步展开有队列项与墙钟双重上限 (`resolve()` 是同步契约, 不能阻塞 Host
   * 事件循环): 结果被截断时先返回已找到的浅层匹配并告警, 同时把该根交给
   * {@link expandInBackground} 在后台按分片补齐, 补齐结果与已有结果取并集.
   * 完整结果只覆盖不丢失: 更差的同步部分结果不会把已拿到的深层匹配置换掉.
   */
  private snapshot;
  /**
   * 后台把被同步预算截断的根补齐: 同一时刻只跑一个 (全量遍历很贵), 且启动
   * 间隔不小于 {@link EXPAND_FULL_TTL_MS}. 补全结果与既有结果取并集后写回;
   * 到顶仍不完整 (家目录级工作区) 则记为该根已放弃, 只保留告警给出的"改用
   * 锚定条目"建议. 结果经 generation 校验, 服务释放或配置变化时直接丢弃.
   */
  private expandInBackground;
  /**
   * 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
   * 追加注入保护路径 (枚举形态给进程沙箱, 原文给 write/edit 围栏), 额外可写根
   * 与 broker 加固开关.
   * @param request - 可选的会话与已批准的模式覆盖.
   * @returns 带有 `readOnlyPatterns` / `readOnlyPaths` / `writablePaths` /
   * `hardenBroker` 的完整逐次调用 policy.
   */
  resolve(request?: Parameters<SandboxPolicyService['resolve']>[0]): SandboxExecutionPolicy;
}
//#endregion
export { WriteProtectPolicyService as default };
//# sourceMappingURL=policy.d.mts.map
import z from "@deepseek-ai/schemastery";
import { SandboxExecutionPolicy, SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import "@deepseek-ai/dsh-tools";
import { Context, Volatile } from "@deepseek-ai/cordis";
//#region src/readonly-file.d.ts
/**
 * 工作区只读规则文件: 在工作区根读一份 gitignore 语义的规则文件 (默认名
 * `.readonly`, 名字由配置决定), 校验后合并进生效的保护路径文本.
 *
 * 与设置页文本的区别只有来源: 内容是同一套语义 (`gitignore.ts` 解析), 逐行
 * 追加在设置页文本之后, 因此规则文件既可以用 `!` 放行设置页里的条目, 也可以
 * 自己新增条目. 规则文件只在工作区根一份, 不做逐目录嵌套.
 *
 * 安全约束:
 *   - 只接受普通文件: 符号链接一律拒绝, 否则规则来源可以被链到工作区外由他人
 *     改写; 打开后按文件描述符再确认一次类型, 消掉 open 与判定之间的替换窗口.
 *   - `//` 绝对路径条目拒绝: 规则文件是工作区里的内容, 不允许它去声明工作区外
 *     的宿主路径 (那是设置页与部署配置的职责).
 *   - 解析结果越出工作区的条目拒绝.
 *   - 条目数上限截断, 避免一份异常大的文件拖慢每次写入判定.
 *
 * 读取是同步的 (与 protections 的既有展开同一形态: `policy.resolve()` 是同步
 * 契约, 设置页预览与 write/edit 围栏都在同步路径上). 按 (工作区根, 文件名) 缓存,
 * 缓存不在 TTL 内时由下一次读取刷新, 因此规则文件改完的下一步判定就按新内容走.
 * @module dsh-write-protect/readonly-file
 */
/** 规则文件的解析结果: 可直接拼接的原文, 逐条模式, 以及未生效原因. */
interface ReadOnlyFile {
  /** 规则文件是否存在 (不存在不是错误). */
  readonly present: boolean;
  /** canonical 文件路径; 文件不存在时为预期的路径, 仅供提示. */
  readonly path: string;
  /** 通过校验的条目原文, 逐行 (可直接拼接进生效文本). */
  readonly text: string;
  /** 解析出来的条目 (原文形态, 用于预览与日志). */
  readonly entries: readonly string[];
  /** 被拒绝或截断的条目说明. */
  readonly warnings: readonly string[];
}
/**
 * 按 (工作区根, 文件名) 缓存的规则文件读取器. 判定路径上是同步读取, 因此结果
 * 带一个短 TTL: TTL 内复用缓存, 过期后由下一次读取刷新, 并发请求天然合并.
 */
declare class ReadOnlyFileCache {
  private readonly maxEntries;
  private readonly onWarning;
  private readonly entries;
  private readonly warned;
  /**
   * @param maxEntries - 条目数上限; 取回调而不是数值, 因为上限本身也是可在设置页
   *   改动的配置, 每次读取都要按当时的生效值截断.
   * @param onWarning - 告警回调 (每条告警只回调一次, 跨刷新去重).
   */
  constructor(maxEntries: () => number, onWarning?: (message: string) => void);
  /** 缓存里仍然新鲜的规则文件; 没读过、换了文件名或已过期时返回 undefined. */
  peek(workspaceRoot: string, fileName: string): ReadOnlyFile | undefined;
  /**
   * 取规则文件: 缓存新鲜就用缓存, 否则同步重读一次.
   * @param workspaceRoot - 工作区根.
   * @param fileName - 规则文件名.
   */
  read(workspaceRoot: string, fileName: string): ReadOnlyFile;
  /** 无条件重读一次 (设置页预览要看到刚写入磁盘的内容). */
  refresh(workspaceRoot: string, fileName: string): ReadOnlyFile;
  /** 工作区根上的缓存作废. */
  forget(workspaceRoot: string): void;
  /** 告警按内容去重后转交回调, 避免每次刷新都重复刷屏. */
  private report;
}
//#endregion
//#region src/refresh.d.ts
/**
 * 保护路径展开结果的保鲜: 给正在运行的会话的工作区根装递归 watcher, watcher 一报
 * 变化就立刻在后台重扫; 没有事件时用自适应 TTL 兜底.
 *
 * 为什么需要它: 命令侧 (bwrap 的只读挂载) 只能消费真实路径, 所以展开清单是命令侧
 * 保护的唯一来源; 会话中途才出现的受保护路径 (例如 `git init` 出来的 `.git`) 若不
 * 在清单里, 那条命令就写得进去. watcher 负责"变化之后尽快重算", TTL 负责"watcher
 * 漏事件时也不会一直陈旧".
 *
 * 生命周期跟着 agent 运行状态走: 运行时装 watcher, 运行结束或会话销毁时摘掉, 空闲
 * 不占资源. 工作区根只接受本地路径 —— 调用方取不到本地可监听路径时直接不装 watcher,
 * 退化成纯 TTL.
 * @module dsh-write-protect/refresh
 */
/** 一次展开的结果. */
interface ExpansionSnapshot {
  readonly readOnly: readonly string[];
  readonly writable: readonly string[];
  readonly patterns: string;
}
//#endregion
//#region src/constants.d.ts
/** 一次可写授权的性质. */
type GrantKind = 'extra-root' | 'override';
/**
 * 为逐次调用的沙箱 policy 追加保护路径 (原文与缓存清单), 额外可写根与 broker
 * 加固开关. 官方 policy 类型不做改动, 这个接口合并让每个消费方都能直接读
 * `policy.readOnlyPatterns` / `policy.readOnlyPaths` / `policy.writablePaths`,
 * 无需再引入插件私有的 service.
 */
declare module '@deepseek-ai/dsh-sandbox' {
  interface SandboxExecutionPolicy {
    /**
     * 展开缓存里已有的保护路径. 进程沙箱 (bwrap `--ro-bind` / Seatbelt
     * `subpath`) 需要的是具体路径, 但它走 policy service 的 `materialize()`
     * 异步取完整清单; 这一份只在没有那条通道时 (单测直接塞 policy) 作退回.
     */
    readOnlyPaths?: readonly string[];
    /**
     * 生效的保护路径配置**原文** (gitignore 语义, 设置页文本与工作区规则文件
     * 合并之后). write / edit 围栏直接按它逐路径匹配, 不依赖任何扫盘结果:
     * 深层嵌套与尚未存在的匹配一样挡得住. 缺省表示这份 policy 不是本插件的
     * policy service 生成的, 消费方应退回按 `readOnlyPaths` 做前缀比较.
     */
    readOnlyPatterns?: string;
    writablePaths?: readonly string[];
    /**
     * 本会话经审批得到的保护旁路路径: 落在这些根之下的目标跳过保护路径判定.
     * 只由 write / edit 围栏消费; 命令侧的沙箱挂载 / profile 在命令执行前
     * 就已经定好, 运行期撤不掉, 因此不因它收窄.
     */
    writableOverrides?: readonly string[];
    /**
     * 当前工作区根上那份只读规则文件的 canonical 路径 (文件名关闭时为
     * undefined). 这是唯一不接受放行的路径: 它自己就是规则来源, 任何写入
     * (包括本会话已批准的保护旁路) 都不能改它.
     */
    rulesFilePath?: string;
    /**
     * macOS Seatbelt 是否追加 broker 逃逸拒绝形式. 缺省视为开启; 只有设置页
     * 或部署配置显式关掉时才为 false, 此时命令按官方 profile 运行.
     */
    hardenBroker?: boolean;
  }
}
//#endregion
//#region src/request-writable-path.d.ts
/** 一条已批准的可写授权. */
interface Grant {
  readonly path: string;
  readonly kind: GrantKind;
}
/** 一个会话的授权记录. */
interface GrantRecord {
  readonly extraRoots: readonly string[];
  readonly overrides: readonly string[];
  readonly grants: readonly Grant[];
}
/** `GrantsService.grant()` 的结果. */
type GrantOutcome = {
  readonly ok: true;
  readonly record: GrantRecord;
  readonly kind: GrantKind;
} | {
  readonly ok: false;
  readonly reason: string;
};
/** `GrantsService.revoke()` 的结果. */
type RevokeOutcome = {
  readonly ok: true;
  readonly record: GrantRecord;
  readonly removed: Grant;
} | {
  readonly ok: false;
  readonly reason: string;
};
/**
 * 会话级可写授权表. 键为会话 id; 会话结束后记录随 map 一起失效 (进程内存态).
 */
declare class GrantsService {
  private readonly maxGrants;
  private readonly onChange;
  private readonly records;
  constructor(maxGrants: () => number, onChange: () => void);
  /** 某个会话的授权记录 (没有记录时返回空记录). */
  recordOf(sessionId: string): GrantRecord;
  /**
   * 记录一条授权. 已存在同一路径时视为成功且不重复计数.
   * @param sessionId - 授权所属会话.
   * @param path - canonical 绝对路径.
   * @param kind - 工作区外的额外根 (`extra-root`) 或保护旁路 (`override`).
   */
  grant(sessionId: string, path: string, kind: GrantKind): GrantOutcome;
  /** 某个会话当前持有的授权清单 (按批准顺序). */
  listOf(sessionId: string): readonly Grant[];
  /**
   * 撤回一条授权: 目标重新落回当前的保护判定. 这是"手动撤回"那条通道的服务端
   * 动作, 与 `grant()` 对称 —— 只删记录, 不碰设置页配置, 也不碰展开缓存 (授权
   * 本来就不进缓存, 每次 `resolve()` 现读).
   *
   * 只按路径精确匹配: 面板列出的就是这些原样路径, 作用于某一棵子树的授权要撤
   * 就撤那条授权本身, 不支持"撤掉父授权的一部分".
   * @param sessionId - 授权所属会话.
   * @param path - canonical 绝对路径.
   * @returns 成功时给出被删掉的授权与删后记录, 路径不在表里时给出原因.
   */
  revoke(sessionId: string, path: string): RevokeOutcome;
  /** 按工作区根查找已授权的会话记录 (设置页预览用: 请求体只带 cwd). */
  recordsForWorkspace(workspaceRoot: string, cwdOf: (sessionId: string) => string | undefined): readonly Grant[];
}
//#endregion
//#region src/policy.d.ts
export declare const name = "dsh-write-protect-policy";
/** 插件配置: 官方 policy 的部署字段原样保留, 外加保护路径与额外可写根部署 base. */
export interface Config {
  /** 会话启动时的文件沙箱模式 (缺省 `read-only`, 与官方一致). */
  mode?: SandboxMode;
  /**
   * 部署工作区根: 官方 resolve 在无会话 (或会话没有 cwd) 时拿它当边界. 本插件不在
   * 它上面展开保护路径 (见 workspaceRootOfSession), 缺省 `process.cwd()`.
   */
  workspaceRoot?: string;
  /**
   * 受保护路径部署 base: 每项一行 gitignore 语义模式, 数组逐行合并为生效文本.
   * 不含 `/` 的条目任意层级匹配, 含开头或中间 `/` 的条目锚定工作区根,
   * `//` 开头为文件系统绝对路径; `!` 按 last-match-wins 取反.
   * 用户在 Web 设置页保存过 patterns 文本后该数组不再生效.
   */
  readOnlyPaths?: string[] | Volatile<string[]>;
  /**
   * 额外可写根部署 base: 每项一行字面路径, 数组逐行合并为生效文本.
   * 行首 `~` / `~/...` 为当前用户家目录, `$NAME` / `${NAME}` 为环境变量;
   * `//` 或宿主绝对路径按文件系统解析, 其余相对当前工作区 (含 `..`).
   * 只在 `workspace-write` 下并进 allow-list, 不打穿 `read-only`;
   * 保护路径优先. 用户保存过 writablePatterns 文本后该数组不再生效.
   */
  writablePaths?: string[] | Volatile<string[]>;
  /**
   * macOS Seatbelt broker 逃逸加固的部署 base, 缺省开启 (见
   * `DEFAULT_HARDEN_BROKER`). 用户在设置页拨动开关后该值不再生效.
   */
  hardenBroker?: boolean | Volatile<boolean>;
  /**
   * 工作区只读规则文件名部署 base, 缺省 `.readonly` (见
   * `DEFAULT_READONLY_FILE_NAME`): 工作区根下的这份文件按 gitignore 语义解析,
   * 逐行追加在设置页文本之后; 空串表示关闭该识别. 用户保存过
   * `readonlyFileName` 后该值不再生效.
   */
  readonlyFileName?: string | Volatile<string>;
  /**
   * 规则文件条目数上限部署 base, 缺省 200: 超出的条目丢弃并告警.
   * 用户保存过 `maxReadOnlyEntries` 后该值不再生效.
   */
  maxReadOnlyEntries?: number | Volatile<number>;
  /**
   * 单会话可写授权条数上限部署 base, 缺省 8 (见 `DEFAULT_MAX_GRANTS`).
   * 用户保存过 `maxGrants` 后该值不再生效.
   */
  maxGrants?: number | Volatile<number>;
  /**
   * 是否允许模型申请可写路径的部署 base, 缺省开启 (见
   * `DEFAULT_ALLOW_REQUESTS`). 关掉后 `request_writable_path` 的任何调用都被
   * 拒绝, 提示词也不再引导模型去申请; 用户保存过该字段后此值不再生效.
   */
  allowWritableRequests?: boolean | Volatile<boolean>;
  /**
   * 是否监听工作区变化 (命令侧展开清单的保鲜), 缺省开启 (见
   * `DEFAULT_WATCH_PROTECTED_PATHS`). 开启时只给正在运行 agent 的会话的工作区根
   * 装递归 watcher, 变化后立即后台重扫; 关掉后不装 watcher, 只剩自适应 TTL.
   */
  watchProtectedPaths?: boolean | Volatile<boolean>;
  /**
   * 自适应刷新时长的下界 (毫秒), 缺省 2000 (见 `DEFAULT_WATCH_TTL_MIN_MS`).
   * 上次展开耗时乘 10 后不低于它.
   */
  watchTtlMinMs?: number | Volatile<number>;
  /**
   * 自适应刷新时长的上界 (毫秒), 缺省 30000 (见 `DEFAULT_WATCH_TTL_MAX_MS`).
   * 上次展开耗时乘 10 后不高于它, 也是 watcher 失效时的兜底刷新间隔.
   */
  watchTtlMaxMs?: number | Volatile<number>;
  /** 用户保存的保护路径多行文本; 缺省回退 readOnlyPaths. */
  patterns?: string | Volatile<string>;
  /** 用户保存的额外可写根多行文本; 缺省回退 writablePaths. */
  writablePatterns?: string | Volatile<string>;
}
/** 一次同步解析得到的生效文本, 本会话授权与缓存里已有的枚举清单. */
export interface PolicySnapshot {
  readonly readOnlyPatterns: string;
  readonly readOnly: readonly string[];
  readonly writable: readonly string[];
  readonly overrides: readonly string[];
}
/** 设置页三项新配置的取值来源 (用户覆盖优先, 否则部署 base). */
export interface ResolvedConfigValues {
  readonly readonlyFileName: string;
  readonly maxReadOnlyEntries: number;
  readonly maxGrants: number;
  readonly allowWritableRequests: boolean;
  readonly watchProtectedPaths: boolean;
  readonly watchTtlMinMs: number;
  readonly watchTtlMaxMs: number;
}
export declare class WriteProtectPolicyService extends SandboxPolicyService {
  private readonly config;
  static Config: z<Schemastery.ObjectS<NoInfer<{
    mode: z<"read-only" | "workspace-write" | "danger-full-access", "read-only" | "workspace-write" | "danger-full-access", "defined">;
    workspaceRoot: z<string, string, "plain">;
    readOnlyPaths: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    writablePaths: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    patterns: z<string, string, "volatile">;
    writablePatterns: z<string, string, "volatile">;
    hardenBroker: z<boolean, boolean, "volatile-defined">;
    readonlyFileName: z<string, string, "volatile-defined">;
    maxReadOnlyEntries: z<number, number, "volatile-defined">;
    maxGrants: z<number, number, "volatile-defined">;
    allowWritableRequests: z<boolean, boolean, "volatile-defined">;
    watchProtectedPaths: z<boolean, boolean, "volatile-defined">;
    watchTtlMinMs: z<number, number, "volatile-defined">;
    watchTtlMaxMs: z<number, number, "volatile-defined">;
  }>>, Schemastery.ObjectT<NoInfer<{
    mode: z<"read-only" | "workspace-write" | "danger-full-access", "read-only" | "workspace-write" | "danger-full-access", "defined">;
    workspaceRoot: z<string, string, "plain">;
    readOnlyPaths: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    writablePaths: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    patterns: z<string, string, "volatile">;
    writablePatterns: z<string, string, "volatile">;
    hardenBroker: z<boolean, boolean, "volatile-defined">;
    readonlyFileName: z<string, string, "volatile-defined">;
    maxReadOnlyEntries: z<number, number, "volatile-defined">;
    maxGrants: z<number, number, "volatile-defined">;
    allowWritableRequests: z<boolean, boolean, "volatile-defined">;
    watchProtectedPaths: z<boolean, boolean, "volatile-defined">;
    watchTtlMinMs: z<number, number, "volatile-defined">;
    watchTtlMaxMs: z<number, number, "volatile-defined">;
  }>>, "plain">;
  private readonly readOnlyFiles;
  private readonly grants;
  /**
   * 会话 id 到工作区根的记忆: 审批工具只拿得到 agent.session.id (agent 类型不
   * 暴露给本模块), 因此这里把每次解析过的会话工作区根记下来, 让它能按 id 解析
   * 同一份 policy; 设置页预览也用它把授权记录对上是哪个工作区. 进程内存态.
   */
  private readonly sessionRoots;
  /**
   * 正在运行 agent 的会话: 会话 id -> 工作区根. watcher 只服务这批会话, 因此这里
   * 按会话 id 记账 (而不是按根计数), 这样 "status 转 idle" 与 "会话销毁" 两条路径
   * 重复触发也不会把计数弄错.
   */
  private readonly runningSessions;
  /** 展开结果的保鲜: watcher + 自适应 TTL, 见 refresh.ts. */
  private readonly refresher;
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
  /** 当前生效的规则文件名 (空串即关闭识别). */
  currentReadonlyFileName(): string;
  /**
   * 异步展开当前生效文本: 保护路径文本是设置页文本与规则文件文本的合并, 额外
   * 可写根走字面路径展开. 同一 (两份文本, 工作区根) 的进行中请求会合到一次遍历
   * 上; 结果按 TTL 缓存. 本会话授权不在这里展开: 审批阶段就已经拿到 canonical
   * 绝对路径, 由 `resolve()` 直接并进 policy.
   * @param workspaceRoot - 会话工作区根.
   * @returns 展开后的保护路径, 额外可写根与当时的保护路径原文.
   */
  materialize(workspaceRoot: string): Promise<ExpansionSnapshot>;
  /**
   * 一次展开的输入: 生效保护文本 (设置页文本与规则文件合并) 与额外可写文本, 以及
   * 由这两份文本组成的缓存键. 文本变过就一定要重新展开.
   */
  private expansionInputs;
  /** 真正执行一次展开, 并把各条告警去重后写日志. */
  private expandNow;
  /**
   * 记录 / 撤销一个"正在运行 agent 的会话". watcher 只装给这批会话的工作区根:
   * 开始运行时装上, 运行结束 (或会话销毁) 时摘掉. 同一个根被多个会话共用时按会话
   * 计数, 最后一个会话结束后才摘.
   * @param session - 事件里的会话 (只需要 id 与 header.cwd).
   * @param running - 是否正在运行.
   */
  private setSessionRunning;
  /**
   * 会话的本地工作区根 (canonical), 取不到可监听的本地路径时返回 undefined.
   *
   * 今天 dsh 的会话只有本地 cwd 一种形态; 将来出现远端会话时, 这里会拿不到本地
   * 路径 (或拿到远端路径), 于是自然退化成"不装 watcher, 只用 TTL".
   */
  private localWorkspaceRootOf;
  /** 展开额外可写根文本 (纯字面路径, 不扫盘) 并把告警去重后写日志. */
  private expandWritable;
  /**
   * 当前工作区根的规则文件路径 (canonical), 文件名关闭时为 undefined.
   *
   * 这份文件是唯一"硬保护": 它自己改写规则, 因此既不能被任何写入旁路放行, 也不
   * 在可写申请的受理范围内. 要改它只能改设置页的文件名或由用户在编辑器里改.
   * @param workspaceRoot - 会话工作区根.
   */
  rulesFilePath(workspaceRoot: string): string | undefined;
  /** 某个工作区根的规则文件: 缓存新鲜就用缓存, 否则同步读一次. */
  private readOnlyFileAt;
  /** 某个工作区根的生效保护路径文本: 设置页文本与规则文件原文合并. */
  private readOnlyTextAt;
  /**
   * 会话 id 到工作区根的记忆 (只为设置页预览把授权记录对上是哪个工作区).
   * 每次 resolve() 顺手记录; 进程内存态, 不持久化.
   */
  private rememberSession;
  /**
   * 会话的工作区根: 最近一次 resolve() 记下的那一份, 或调用方从会话日志带来的
   * cwd (`resolve` 成绝对路径, 同时记下). 两者都没有时返回 undefined.
   *
   * 这里刻意**不回退部署根**: 部署根是进程 cwd, 可能就是一棵极大的树 (从 home
   * 启动时的整个 home), 而保护路径展开是一次扫盘 —— 在那里枚举会把 Host 事件循环
   * 堵住几十秒, 表现成整个 dsh 无响应. 没有根就不展开, 由调用方决定怎么办.
   * @param sessionId - 目标会话 id.
   * @param cwd - 会话日志里的 cwd; 缺省表示调用方拿不到.
   * @returns 绝对工作区根, 或 undefined.
   */
  workspaceRootOfSession(sessionId: string, cwd?: string): string | undefined;
  /** 当前生效的规则文件条目上限, 会话授权上限与可写申请开关 (供设置页预览复用). */
  limits(): ResolvedConfigValues;
  /** 规则文件读取器 (设置页预览直接读一次磁盘, 不依赖缓存). */
  readOnlyFileReader(): ReadOnlyFileCache;
  /** 会话授权记录 (设置页预览列出当前生效的授权). */
  grantsView(): GrantsService;
  /**
   * 目标是否被当前生效的保护文本命中, 命中时返回那条模式原文.
   *
   * 判定与 write / edit 围栏同源: 都拿模式原文直接匹配目标路径, 因此不受展开
   * 缓存冷热影响, 也不依赖任何扫盘结果.
   * @param sessionId - 调用所属会话, 缺省表示无会话调用.
   * @param cwd - 会话日志里的 cwd, 供会话尚未被 resolve 过时定位工作区根.
   * @param target - 目标绝对路径.
   * @returns 命中的模式原文, 未命中为 undefined.
   */
  protectedPatternFor(sessionId: string | undefined, cwd: string | undefined, target: string): string | undefined;
  /**
   * agents 端口 (撤回通知专用). 取用形状见 `grant-notice.ts`: 本插件只需要"按会话
   * id 给 live agent 投一条消息", 因此用 `ctx.get()` 拿它并收窄类型 —— 组合里没有
   * agents 服务时投递自然退化成 no-session, 撤回本身照常生效.
   */
  private agentsPort;
  /** 当前生效的规则文件条目上限, 会话授权上限, 可写申请开关与保鲜配置. */
  private currentLimits;
  /** 校验并回退规则文件名, 非法值告警一次. */
  private warnAboutFileName;
  /** 取正数上限, 非法值回退默认并告警一次. */
  private positiveLimit;
  /** 告警去重后写到日志. */
  private warn;
  /**
   * 同步解析一次调用的生效文本: 设置页文本与规则文件文本的合并结果, 本会话授权,
   * 以及展开缓存里已有的路径清单 (冷缓存时为空).
   *
   * 这里刻意不做展开: `resolve()` 是同步契约, 扫盘只能放到 `materialize()` 那条
   * async 路径上. `workspaceRoot` 为 undefined 表示没有已知的会话工作区根: 此时
   * 不读规则文件也不展开, 只保留设置页原文与会话授权 (后者已是绝对路径).
   * @param workspaceRoot - 会话工作区根, 未知时为 undefined.
   * @param sessionId - 调用所属会话, 缺省表示无会话调用.
   */
  private snapshot;
  /**
   * 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
   * 追加注入合并后的保护路径原文 (给 write / edit 围栏逐路径判定), 展开缓存里
   * 已有的清单 (冷缓存时为空, `confine()` 会 await {@link materialize}), 额外
   * 可写根, 本会话授权, 保护旁路, 规则文件路径与 broker 加固开关.
   * @param request - 可选的会话与已批准的模式覆盖.
   * @returns 带有 `readOnlyPatterns` / `readOnlyPaths` / `writablePaths` /
   * `writableOverrides` / `rulesFilePath` 的完整逐次调用 policy.
   */
  resolve(request?: Parameters<SandboxPolicyService['resolve']>[0]): SandboxExecutionPolicy;
  /**
   * 按会话 id 解析一次 policy: 给只拿得到会话 id 的消费方 (审批工具) 用. 工作区
   * 根取该会话最近一次解析出来的那一份, 没有就用调用方给的 cwd, 两者都没有时
   * 保护路径不展开也不回退部署根, 只带设置页原文.
   *
   * 这里刻意不走本类覆写过的 `resolve()`: 那一支会先按"无会话"解析一次, 从而把
   * 保护路径的展开基准落到部署根 (进程 cwd) 上. 本方法只借 super 的 mode 与部署
   * 默认值, 保护范围随后全部按会话自己那份重算.
   * @param sessionId - 目标会话 id.
   * @param cwd - 会话日志里的 cwd, 供会话尚未被 resolve 过时定位工作区根.
   */
  resolveForSession(sessionId: string, cwd?: string): SandboxExecutionPolicy;
}
//#endregion
export { WriteProtectPolicyService as default };
//# sourceMappingURL=policy.d.mts.map
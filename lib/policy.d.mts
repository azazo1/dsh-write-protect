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
   * `//` 或宿主绝对路径按文件系统解析, 其余相对当前工作区 (含 `..`).
   * 只在 `workspace-write` 下并进 allow-list, 不打穿 `read-only`;
   * 保护路径优先. 用户保存过 writablePatterns 文本后该数组不再生效.
   */
  writablePaths?: string[];
}
export declare class WriteProtectPolicyService extends SandboxPolicyService {
  static Config: z<Schemastery.ObjectS<{
    mode: z<"read-only" | "workspace-write" | "danger-full-access", "read-only" | "workspace-write" | "danger-full-access">;
    workspaceRoot: z<string, string>;
    readOnlyPaths: z<string[], string[]>;
    writablePaths: z<string[], string[]>;
  }>, Schemastery.ObjectT<{
    mode: z<"read-only" | "workspace-write" | "danger-full-access", "read-only" | "workspace-write" | "danger-full-access">;
    workspaceRoot: z<string, string>;
    readOnlyPaths: z<string[], string[]>;
    writablePaths: z<string[], string[]>;
  }>>;
  private readonly baseEntries;
  private readonly writableBaseEntries;
  private settingsOwner;
  private cache;
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
  /**
   * 展开当前生效文本为 canonical 保护路径与额外可写根, 按
   * (两份文本, 工作区根) 做 TTL 缓存. 展开告警对每条只告警一次.
   */
  private snapshot;
  /**
   * 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
   * 追加注入解析后的保护路径与额外可写根.
   * @param request - 可选的会话与已批准的模式覆盖.
   * @returns 带有 `readOnlyPaths` 与 `writablePaths` 的完整逐次调用 policy.
   */
  resolve(request?: Parameters<SandboxPolicyService['resolve']>[0]): SandboxExecutionPolicy;
}
//#endregion
export { WriteProtectPolicyService as default };
//# sourceMappingURL=policy.d.mts.map
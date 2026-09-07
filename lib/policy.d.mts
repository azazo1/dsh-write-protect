import z from "@deepseek-ai/schemastery";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { SandboxExecutionPolicy, SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { Context } from "@deepseek-ai/cordis";
//#region src/policy.d.ts
export declare const name = "dsh-write-protect-policy";
/** 插件配置: 官方 policy 的部署字段原样保留, 外加保护路径配置项. */
export interface Config {
  /** 会话启动时的文件沙箱模式 (缺省 `read-only`, 与官方一致). */
  mode?: SandboxMode;
  /** 无会话调用与会话没有 cwd 时的回退工作区根 (缺省 `process.cwd()`). */
  workspaceRoot?: string;
  /**
   * 受保护路径配置项: 相对路径相对会话工作区根解析, 绝对路径原样使用;
   * 空白项在加载时报错.
   */
  readOnlyPaths?: string[];
}
export declare class WriteProtectPolicyService extends SandboxPolicyService {
  static Config: z<Schemastery.ObjectS<{
    mode: z<"read-only" | "workspace-write" | "danger-full-access", "read-only" | "workspace-write" | "danger-full-access">;
    workspaceRoot: z<string, string>;
    readOnlyPaths: z<string[], string[]>;
  }>, Schemastery.ObjectT<{
    mode: z<"read-only" | "workspace-write" | "danger-full-access", "read-only" | "workspace-write" | "danger-full-access">;
    workspaceRoot: z<string, string>;
    readOnlyPaths: z<string[], string[]>;
  }>>;
  private readonly entries;
  constructor(ctx: Context, config: Config);
  /**
   * 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
   * 追加注入解析后的保护路径.
   * @param request - 可选的会话与已批准的模式覆盖.
   * @returns 带有 `readOnlyPaths` 的完整逐次调用 policy.
   */
  resolve(request?: Parameters<SandboxPolicyService['resolve']>[0]): SandboxExecutionPolicy;
}
//#endregion
export { WriteProtectPolicyService as default };
//# sourceMappingURL=policy.d.mts.map
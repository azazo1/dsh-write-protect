import z from "@deepseek-ai/schemastery";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { resolve } from "node:path";
import { canonicalPath } from "@deepseek-ai/dsh-sandbox";
//#region src/shared.ts
/**
* 写保护的共享契约: 配置字段, 默认值, 以及把 `readOnlyPaths` 配置项解析为
* canonical 绝对路径的推导. 三个执法半区 (policy, fs 围栏, 进程沙箱 provider)
* 都从逐次调用的 policy 上读取同一份解析结果, 因此 CLI 沙箱与 write/edit
* 工具的保护范围不会漂移.
* @module dsh-write-protect/shared
*/
/** 默认保护项: 仓库的 `.git` 目录. */
const DEFAULT_READ_ONLY_PATHS = [".git"];
/**
* 针对一次 policy 调用解析配置项. 相对路径锚定到本次调用的工作区根
* (每个会话的工作区各自解析, `.git` 即该会话工作区下的 `.git`), 绝对路径
* 原样使用; 所有结果都经过 `canonicalPath`, 与 writableRoots 推导交给
* Seatbelt 过滤器和 fs 围栏比较的路径身份保持一致.
* @param entries - 配置项, 相对或绝对; 空白项在此跳过 (policy 在加载时已拒绝).
* @param workspaceRoot - 本次调用的工作区根.
* @returns 去重后的 canonical 保护路径, 保持配置顺序.
*/
function resolveReadOnlyPaths(entries, workspaceRoot) {
	const resolved = [];
	for (const entry of entries) {
		if (entry.trim().length === 0) continue;
		resolved.push(canonicalPath(resolve(workspaceRoot, entry)));
	}
	return [...new Set(resolved)];
}
//#endregion
//#region src/policy.ts
const name = "dsh-write-protect-policy";
var WriteProtectPolicyService = class extends SandboxPolicyService {
	static Config = z.object({
		mode: z.union([
			"read-only",
			"workspace-write",
			"danger-full-access"
		]).default("read-only"),
		workspaceRoot: z.string(),
		readOnlyPaths: z.array(z.string()).default([...DEFAULT_READ_ONLY_PATHS])
	});
	entries;
	constructor(ctx, config) {
		super(ctx, config);
		const entries = config.readOnlyPaths ?? [];
		for (const entry of entries) if (entry.trim().length === 0) throw new Error("dsh-write-protect: readOnlyPaths entries must be non-empty strings");
		this.entries = entries;
		ctx.inject(["systemPrompt"], (scope) => {
			scope.systemPrompt.context({
				name: "sandbox:write-protect",
				order: 112,
				text: (context) => {
					const session = context.agent?.session;
					if (session === void 0) return "";
					const paths = resolveReadOnlyPaths(this.entries, this.resolve({ session }).workspaceRoot);
					if (paths.length === 0) return "";
					return `Write-protected paths (all DSH-enforced operations deny writes beneath them; reads stay allowed): ${JSON.stringify(paths)}.`;
				}
			});
		});
	}
	/**
	* 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
	* 追加注入解析后的保护路径.
	* @param request - 可选的会话与已批准的模式覆盖.
	* @returns 带有 `readOnlyPaths` 的完整逐次调用 policy.
	*/
	resolve(request = {}) {
		const policy = super.resolve(request);
		policy.readOnlyPaths = resolveReadOnlyPaths(this.entries, policy.workspaceRoot);
		return policy;
	}
};
//#endregion
export { WriteProtectPolicyService, WriteProtectPolicyService as default, name };

//# sourceMappingURL=policy.mjs.map
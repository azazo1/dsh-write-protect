import { existsSync } from "node:fs";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
//#region src/provider.ts
/**
* 替换 base 的 `sandbox` 行 (Linux/macOS): 官方 `LocalSandboxProvider` 的
* runner 链, 功能探测与执法报告全部原样保留, 只在 confine() 返回之后把
* 保护路径叠加为对 profile 的额外约束 —
*   - bwrap: 在 `--` 分隔符之前插入 `--ro-bind <p> <p>`; 后挂载覆盖早挂载,
*     只读 bind 叠在可写 bind 之上 (bwrap 与自定义 bwrap 兼容 runner 均适用);
*   - Seatbelt (sandbox-exec): 在 `-p` 的 profile 文本末尾追加
*     `(deny file-write* (subpath "..."))`, 显式 deny 收窄更早的 allow,
*     不影响其余可写区域;
*   - Landlock 是纯 allow-list 并集, 无法表达子路径例外; 其余无法识别的
*     runner 同理 — 两者都只告警一次, 命令仍按官方 profile 运行.
* Windows 不挂载本行 (保留官方 ACL provider), fs 围栏半区覆盖 write/edit 工具.
* @module dsh-write-protect/provider
*/
const name = "dsh-write-protect-provider";
/** 把一个路径引用为 SBPL 字符串字面量 (与官方 profiles 的转义规则一致). */
function sbplString(path) {
	return `"${path.replaceAll("\\", String.raw`\\`).replaceAll("\"", String.raw`\"`)}"`;
}
var WriteProtectSandboxProvider = class extends LocalSandboxProvider {
	warnedUnsupported = false;
	/**
	* 按官方结果包装 argv 后叠加保护路径. 只在 `workspace-write` 下生效:
	* `read-only` 的官方 profile 已全量拒绝; 保护路径来自 policy 注入的
	* canonical 列表 (空列表直接短路).
	*/
	confine(argv, policy) {
		const result = super.confine(argv, policy);
		if (policy.mode !== "workspace-write") return result;
		const paths = policy.readOnlyPaths ?? [];
		if (paths.length === 0) return result;
		const runner = result.argv[0];
		const separator = result.argv.indexOf("--");
		const profileArgs = separator === -1 ? result.argv.slice(1) : result.argv.slice(1, separator);
		if (runner === "bwrap" || profileArgs.includes("--ro-bind")) return this.withBwrapReadonly(result, paths);
		if (runner === "sandbox-exec") return this.withSeatbeltDenials(result, paths);
		this.warnUnsupported(runner);
		return result;
	}
	/**
	* bwrap: 在 `--` 分隔符之前插入 ro-bind 对. bwrap 要求 bind 源存在, 宿主上
	* 尚不存在的路径跳过并告警 (fs 工具半区仍会拒绝这些路径下的写入).
	*/
	withBwrapReadonly(result, paths) {
		const separator = result.argv.indexOf("--");
		const insertAt = separator === -1 ? result.argv.length : separator;
		const binds = [];
		const missing = [];
		for (const path of paths) if (existsSync(path)) binds.push("--ro-bind", path, path);
		else missing.push(path);
		if (missing.length > 0) this.warnMissing(missing);
		if (binds.length === 0) return result;
		return {
			...result,
			argv: [
				...result.argv.slice(0, insertAt),
				...binds,
				...result.argv.slice(insertAt)
			]
		};
	}
	/**
	* Seatbelt: 在 `-p` 的 profile 文本末尾追加一条合并的 deny 形式. 每条
	* `(subpath "...")` 都经过 SBPL 字符串转义; profile 形状缺失时按不支持
	* 告警并保持官方结果.
	*/
	withSeatbeltDenials(result, paths) {
		const profileIndex = result.argv.indexOf("-p");
		if (profileIndex === -1 || profileIndex + 1 >= result.argv.length) {
			this.warnUnsupported("sandbox-exec (no -p profile argument)");
			return result;
		}
		const denies = paths.map((path) => `(subpath ${sbplString(path)})`).join(" ");
		const next = [...result.argv];
		next[profileIndex + 1] = `${next[profileIndex + 1]} (deny file-write* ${denies})`;
		return {
			...result,
			argv: next
		};
	}
	/** 无法表达子路径保护的 runner: 只告警一次, 命令按官方 profile 运行. */
	warnUnsupported(runner) {
		if (this.warnedUnsupported) return;
		this.warnedUnsupported = true;
		this.ctx.logger?.warn?.(`dsh-write-protect: the "${runner}" sandbox rung cannot express protected subpaths; commands still run under the stock profile (prefer bwrap on Linux; macOS Seatbelt is supported)`);
	}
	/** bwrap 无法 ro-bind 的缺失路径: 告警并说明 write/edit 工具侧仍然受保护. */
	warnMissing(paths) {
		this.ctx.logger?.warn?.(`dsh-write-protect: bwrap cannot ro-bind missing paths, skipped (write/edit tools still deny them): ${JSON.stringify(paths)}`);
	}
};
//#endregion
export { WriteProtectSandboxProvider, WriteProtectSandboxProvider as default, name };

//# sourceMappingURL=provider.mjs.map
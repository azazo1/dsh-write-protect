import { existsSync } from "node:fs";
import { parse } from "node:path";
import { canonicalPath } from "@deepseek-ai/dsh-sandbox";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
//#region src/seatbelt.ts
/**
* macOS Seatbelt (sandbox-exec) profile 的拼接工具与 broker 逃逸加固形式.
*
* 官方 profile 的形状是
* `(version 1) (allow default) (deny file-write*) (allow file-write* ...)`,
* 即 `mach-lookup` 与 `process-exec` 全开. 而被 launchd 代理启动的进程不继承
* Seatbelt profile, 于是一条 `open x.app` 就能让沙箱内的命令在沙箱外执行,
* 任意写文件 —— `deny file-write*` 因此可被完全绕开. 本模块追加一组拒绝形式
* 堵住已知的 broker 通道; 规则是 last-match-wins, 必须追加在 profile 末尾才能
* 盖过 `(allow default)`.
*
* 这是纵深加固而非完备隔离: 它关掉的是 launchd / LaunchServices 这条代理通道,
* 沙箱内的进程仍可通过其他本地守护进程 (Docker socket, ssh-agent 一类) 让沙箱外
* 的服务代劳. 根本修复是上游把 profile 反转成 deny-by-default.
* @module dsh-write-protect/seatbelt
*/
/** 把一个路径引用为 SBPL 字符串字面量 (与官方 profiles 的转义规则一致). */
function sbplString(path) {
	return `"${path.replaceAll("\\", String.raw`\\`).replaceAll("\"", String.raw`\"`)}"`;
}
/**
* 追加到 Seatbelt profile 末尾的 broker 逃逸拒绝形式. 每条都是完整的 SBPL 形式,
* 顺序无关, 但整体必须出现在官方 `(allow default)` 之后.
*/
const SEATBELT_BROKER_DENIALS = [
	"(deny mach-lookup (global-name-prefix \"com.apple.coreservices\"))",
	"(deny appleevent-send)",
	"(deny mach-priv-task-port)"
];
/**
* 把一组 SBPL 形式追加到 `-p` 之后的 profile 文本末尾.
* @param argv - 官方 provider 返回的沙箱 argv (profile 位于 `-p` 的下一个位置).
* @param forms - 要追加的 SBPL 形式, 空数组时原样返回.
* @returns 追加后的 argv; 形状不符合预期 (`-p` 缺失) 时返回 undefined.
*/
function appendSeatbeltForms(argv, forms) {
	if (forms.length === 0) return [...argv];
	const profileIndex = argv.indexOf("-p");
	if (profileIndex === -1 || profileIndex + 1 >= argv.length) return void 0;
	const next = [...argv];
	next[profileIndex + 1] = `${next[profileIndex + 1]} ${forms.join(" ")}`;
	return next;
}
//#endregion
//#region src/provider.ts
/**
* 替换 base 的 `sandbox` 行 (Linux/macOS): 官方 `LocalSandboxProvider` 的
* runner 链, 功能探测与执法报告全部原样保留, 只在 confine() 返回之后把
* 额外可写根与保护路径叠加为对 profile 的额外约束 —
*   - bwrap: 在 `--` 分隔符之前先插入 `--bind <p> <p>`, 再插入
*     `--ro-bind <p> <p>`; 后挂载覆盖早挂载, 只读 bind 叠在可写 bind 之上;
*   - Seatbelt (sandbox-exec): 先追加 `(allow file-write* (subpath "..."))`,
*     再追加 `(deny file-write* (subpath "..."))`, 显式 deny 收窄更早的 allow;
*     不区分模式地追加 broker 逃逸拒绝形式 (见 seatbelt.ts), 否则官方 profile 的
*     `(allow default)` 会让沙箱内一条 `open x.app` 把命令交给 launchd 在沙箱外跑 —
*     该加固由 policy 的 `hardenBroker` 控制, 设置页可关;
*   - Landlock 是纯 allow-list 并集, 无法表达子路径例外, 但可以加 `--rw`
*     放宽额外可写根; 保护路径仍告警一次, 命令按官方 profile 运行.
* Windows 不挂载本行 (保留官方 ACL provider), fs 围栏半区覆盖 write/edit 工具.
* @module dsh-write-protect/provider
*/
const name = "dsh-write-protect-provider";
/** 文件系统根不能作为额外可写根叠加, 否则会把只读宿主根整棵翻成可写. */
function isFilesystemRoot(path) {
	const canonical = canonicalPath(path);
	return canonical === parse(canonical).root;
}
var WriteProtectSandboxProvider = class extends LocalSandboxProvider {
	warnedUnsupported = false;
	/**
	* 按官方结果包装 argv 后叠加额外可写根, 保护路径与 broker 逃逸加固.
	* Seatbelt 在两种模式下都要加固: `read-only` 的官方 profile 同样是
	* `(allow default)`, 同样能被 `open` 打穿, 只是额外可写根仍不打穿它.
	*/
	confine(argv, policy) {
		const result = super.confine(argv, policy);
		const runner = result.argv[0];
		const separator = result.argv.indexOf("--");
		const profileArgs = separator === -1 ? result.argv.slice(1) : result.argv.slice(1, separator);
		if (runner === "sandbox-exec") return this.hardenSeatbelt(result, policy);
		if (policy.mode !== "workspace-write") return result;
		const extra = policy.writablePaths ?? [];
		const protectedPaths = policy.readOnlyPaths ?? [];
		if (extra.length === 0 && protectedPaths.length === 0) return result;
		if (runner === "bwrap" || profileArgs.includes("--ro-bind")) {
			let next = result;
			if (extra.length > 0) next = this.withBwrapBinds(next, extra);
			if (protectedPaths.length > 0) next = this.withBwrapReadonly(next, protectedPaths);
			return next;
		}
		if (profileArgs.includes("--rw")) {
			let next = result;
			if (extra.length > 0) next = this.withLandlockWritable(next, extra);
			if (protectedPaths.length > 0) this.warnUnsupported(runner);
			return next;
		}
		this.warnUnsupported(runner);
		return result;
	}
	/**
	* Seatbelt: 追加额外可写 allow (仅 `workspace-write`), 保护路径 deny, 最后是
	* broker 逃逸拒绝形式. 结尾的 deny 必须留在 profile 末尾才能盖过 `(allow default)`.
	* `hardenBroker` 被显式关掉时只跳过 broker 拒绝形式, 命令按官方 profile 运行.
	*/
	hardenSeatbelt(result, policy) {
		let next = result;
		if (policy.mode === "workspace-write") {
			const extra = policy.writablePaths ?? [];
			const protectedPaths = policy.readOnlyPaths ?? [];
			if (extra.length > 0) next = this.withSeatbeltAllows(next, extra);
			if (protectedPaths.length > 0) next = this.withSeatbeltDenials(next, protectedPaths);
		}
		if (policy.hardenBroker === false) return next;
		return this.appendSeatbelt(next, SEATBELT_BROKER_DENIALS);
	}
	/** 在 `--` 之前插入一组 profile 参数. */
	insertBeforeSeparator(result, args) {
		if (args.length === 0) return result;
		const separator = result.argv.indexOf("--");
		const insertAt = separator === -1 ? result.argv.length : separator;
		return {
			...result,
			argv: [
				...result.argv.slice(0, insertAt),
				...args,
				...result.argv.slice(insertAt)
			]
		};
	}
	/**
	* bwrap: 在 `--` 分隔符之前插入可写 bind 对. 后挂载覆盖早挂载, 必须出现在
	* 保护路径的 ro-bind 之前. 宿主上不存在或解析为文件系统根的路径跳过.
	*/
	withBwrapBinds(result, paths) {
		const binds = [];
		const missing = [];
		for (const path of paths) {
			if (isFilesystemRoot(path)) continue;
			if (existsSync(path)) binds.push("--bind", path, path);
			else missing.push(path);
		}
		if (missing.length > 0) this.warnMissingWritable(missing);
		return this.insertBeforeSeparator(result, binds);
	}
	/**
	* bwrap: 在 `--` 分隔符之前插入 ro-bind 对. bwrap 要求 bind 源存在, 宿主上
	* 尚不存在的路径跳过并告警 (fs 工具半区仍会拒绝这些路径下的写入).
	*/
	withBwrapReadonly(result, paths) {
		const binds = [];
		const missing = [];
		for (const path of paths) if (existsSync(path)) binds.push("--ro-bind", path, path);
		else missing.push(path);
		if (missing.length > 0) this.warnMissing(missing);
		return this.insertBeforeSeparator(result, binds);
	}
	/**
	* Landlock: 在 `--` 之前插入 `--rw` 授权. 不存在或文件系统根跳过;
	* 保护路径仍无法表达, 由调用方告警.
	*/
	withLandlockWritable(result, paths) {
		const grants = [];
		const missing = [];
		for (const path of paths) {
			if (isFilesystemRoot(path)) continue;
			if (existsSync(path)) grants.push("--rw", path);
			else missing.push(path);
		}
		if (missing.length > 0) this.warnMissingWritable(missing);
		return this.insertBeforeSeparator(result, grants);
	}
	/**
	* Seatbelt: 在 `-p` 的 profile 文本末尾追加一条合并的 allow 形式. 随后
	* 的 deny 仍由 withSeatbeltDenials 追加, 保护路径优先.
	*/
	withSeatbeltAllows(result, paths) {
		const roots = paths.filter((path) => !isFilesystemRoot(path));
		if (roots.length === 0) return result;
		return this.appendSeatbelt(result, [`(allow file-write* ${roots.map((path) => `(subpath ${sbplString(path)})`).join(" ")})`]);
	}
	/**
	* Seatbelt: 在 `-p` 的 profile 文本末尾追加一条合并的 deny 形式. 每条
	* `(subpath "...")` 都经过 SBPL 字符串转义; profile 形状缺失时按不支持
	* 告警并保持官方结果.
	*/
	withSeatbeltDenials(result, paths) {
		const denies = paths.map((path) => `(subpath ${sbplString(path)})`).join(" ");
		return this.appendSeatbelt(result, [`(deny file-write* ${denies})`]);
	}
	/** 把一组 SBPL 形式追加到 `-p` profile 文本末尾, 形状缺失时告警并保持官方结果. */
	appendSeatbelt(result, forms) {
		const argv = appendSeatbeltForms(result.argv, forms);
		if (!argv) {
			this.warnUnsupported("sandbox-exec (no -p profile argument)");
			return result;
		}
		return {
			...result,
			argv
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
	/** bwrap / Landlock 无法授权的缺失额外可写根: 告警, fs 围栏仍会按词法放行. */
	warnMissingWritable(paths) {
		this.ctx.logger?.warn?.(`dsh-write-protect: sandbox runner cannot grant missing extra writable roots, skipped (write/edit tools still allow them): ${JSON.stringify(paths)}`);
	}
};
//#endregion
export { WriteProtectSandboxProvider, WriteProtectSandboxProvider as default, name };

//# sourceMappingURL=provider.mjs.map
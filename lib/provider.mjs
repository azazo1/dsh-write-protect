import { n as wslHardenArgs, t as isWslHost } from "./wsl-Do9evsHp.mjs";
import { a as parsePatternLines } from "./gitignore-BAIQt9eU.mjs";
import { canonicalPath } from "@deepseek-ai/dsh-sandbox";
import { existsSync, lstatSync } from "node:fs";
import { parse } from "node:path";
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
/** 正则元字符转义: 字面条目里的 `.` 一类字符必须按字面匹配. */
function escapeRegex(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** 条目能否直接翻译成正则: 含通配或转义的段留给枚举清单. */
function isPlainLiteral(entry) {
	return entry.segments.length > 0 && entry.segments.every((segment) => !/[\\*?[\]]/.test(segment));
}
/**
* 一条字面条目对应的路径正则: 条目本体与它下面的全部后代都覆盖
* (Seatbelt 的 regex 过滤器不自动包含后代, 必须写进正则).
* 绝对条目 (`//` 前缀) 从文件系统根起算, 锚定条目从工作区根起算,
* 其余条目允许出现在工作区根之下的任意层级.
*/
function regexForEntry(entry, workspaceRoot) {
	const literal = entry.segments.map(escapeRegex).join("/");
	if (entry.fsAbsolute) return `^/${literal}(/.*)?$`;
	const root = escapeRegex(workspaceRoot.replace(/\/+$/, ""));
	if (entry.anchored) return `^${root}/${literal}(/.*)?$`;
	return `^${root}(/.*)?/${literal}(/.*)?$`;
}
/**
* 按保护路径**原文**生成 Seatbelt 正则拒绝形式.
*
* 枚举清单只能覆盖展开当时已经存在的路径, 因此像 `.git` 这种"会话中途才出现"
* 的受保护路径会漏掉 (展开结果还带缓存窗口). 字面条目不必扫盘就能翻译成正则,
* 于是它们在 macOS 上持续生效, 与该路径当前是否存在、展开缓存新旧都无关.
*
* 只处理字面条目: 含通配或转义的条目仍交给枚举清单. 只要文本里出现 `!` 取反就
* 整体放弃 —— 纯 deny 表达不了 gitignore 的 last-match-wins, 交给枚举兜底.
* 目录标记 (`build/`) 在这里不额外区分: 同名文件也会一并挡住, 属于收紧.
* @param text - 生效的配置原文 (写保护文本; 读拒绝走同一套语义).
* @param workspaceRoot - 工作区根, 锚定条目与任意层级条目都以它为界.
* @param operation - 拒绝哪一类操作, 缺省 `file-write*`.
* @returns SBPL `(deny <operation> (regex ...))` 形式; 无法表达时为空数组.
*/
function seatbeltRegexDenials(text, workspaceRoot, operation = "file-write*") {
	if (text.trim().length === 0) return [];
	const entries = parsePatternLines(text);
	if (entries.some((entry) => entry.negated)) return [];
	const forms = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		if (!isPlainLiteral(entry)) continue;
		const pattern = regexForEntry(entry, workspaceRoot);
		if (seen.has(pattern)) continue;
		seen.add(pattern);
		forms.push(`(deny ${operation} (regex #"${pattern.replaceAll("\"", String.raw`\"`)}"))`);
	}
	return forms;
}
/**
* 把一组路径引用成 SBPL `(allow <operation> (subpath ...))` 形式 (一条形式覆盖
* 全部路径, 与官方 profiles 的写法一致).
* @param paths - 要放行的路径.
* @param operation - 放行哪一类操作.
* @returns 单条 SBPL 形式.
*/
function seatbeltSubpathAllow(paths, operation) {
	return `(allow ${operation} ${paths.map((path) => `(subpath ${sbplString(path)})`).join(" ")})`;
}
/**
* 把一组路径引用成 SBPL `(deny <operation> (subpath ...))` 形式.
* @param paths - 要拒绝的路径.
* @param operation - 拒绝哪一类操作.
* @returns 单条 SBPL 形式.
*/
function seatbeltSubpathDeny(paths, operation) {
	return `(deny ${operation} ${paths.map((path) => `(subpath ${sbplString(path)})`).join(" ")})`;
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
* 额外可写根, 保护路径与本会话授权叠加为对 profile 的额外约束 —
*   - bwrap: 在 `--` 分隔符之前先插入 WSL 互操作加固 (tmpfs `/mnt` 与
*     `/run/WSL` 等, 见 wsl.ts), 再插入额外可写根的 `--bind <p> <p>`, 再插入
*     保护路径的 `--ro-bind <p> <p>`, 最后插入本会话授权的 `--bind`; 后挂载
*     覆盖早挂载, 因此授权能把被保护的子树重新翻回可写, 额外根若在 `/mnt`
*     下也能在 tmpfs 之后重新露出来;
*   - Seatbelt (sandbox-exec): 先追加额外可写 allow, 再追加保护路径 deny, 最后
*     追加授权 allow —— SBPL 按最后匹配生效, 授权 allow 必须排在 deny 之后才不
*     会被它盖掉; 不区分模式地追加 broker 逃逸拒绝形式 (见 seatbelt.ts), 否则
*     官方 profile 的 `(allow default)` 会让沙箱内一条 `open x.app` 把命令交给
*     launchd 在沙箱外跑 —— 该加固由 policy 的 `hardenBroker` 控制, 设置页可关;
*     WSL 上 PE 互操作是同一类代理通道, 由 `hardenWsl` 控制, 设置页可关;
*   - Landlock 是纯 allow-list 并集, 无法表达"父目录只读, 其中一棵子树可写":
*     额外可写根可以加 `--rw`, 保护路径与本会话授权都告警一次; WSL 互操作
*     也表达不了, 只告警一次.
* Windows 不挂载本行 (保留官方 ACL provider), fs 围栏半区覆盖 write/edit 工具.
*
* 官方 Seam 的 `confine()` 自 0.1.6 起是异步的 (`Promise<ConfinedArgv>` 加一个
* `signal`): 本覆写必须是 async 并 await 官方结果, 否则 `result` 是 Promise,
* 读 `result.argv` 直接抛 TypeError, 走沙箱的每条命令都会失败 (沙箱看起来整个挂掉).
* 保护路径的真实清单也在这条 async 路径上取 (`materialize()`), 不占用同步的
* `policy.resolve()`.
* @module dsh-write-protect/provider
*/
const name = "dsh-write-protect-provider";
/** 文件系统根不能作为额外可写根叠加, 否则会把只读宿主根整棵翻成可写. */
function isFilesystemRoot(path) {
	const canonical = canonicalPath(path);
	return canonical === parse(canonical).root;
}
/** 去重并保持顺序: 叠加的清单来自缓存与授权两处, 同一路径只该出现一次. */
function unique(paths) {
	return [...new Set(paths)];
}
var WriteProtectSandboxProvider = class extends LocalSandboxProvider {
	warnedUnsupported = false;
	warnedLandlockOverride = false;
	warnedLandlockWsl = false;
	warnedLandlockReadDeny = false;
	/**
	* 按官方结果包装 argv 后叠加额外可写根, 保护路径, 读拒绝路径, 本会话授权,
	* broker 逃逸加固与 WSL 互操作加固. Seatbelt 在两种模式下都要加固: `read-only`
	* 的官方 profile 同样是 `(allow default)`, 同样能被 `open` 打穿, 只是额外可写根
	* 仍不打穿它. WSL 加固同理: Windows 进程写的是真实磁盘, `read-only` 的
	* `--ro-bind / /` 一样挡不住, 所以不区分模式.
	*
	* 读拒绝在 `read-only` 下同样叠加: 那个模式限制的是写, 读本来是全开的, 因此
	* 读拒绝不会被官方 profile 覆盖; 对应地, 该模式下只叠加读侧的授权 (Seatbelt 的
	* `allow file-read*` / bwrap 的 `--ro-bind`), 绝不叠加任何写侧放行.
	*
	* 叠加顺序是有意的 (两条链路都按"后匹配 / 后挂载生效"):
	*   0. WSL 互操作加固 (tmpfs `/mnt` 等, 必须早于额外可写 bind, 这样
	*      `/mnt` 下的额外根才能在 tmpfs 之后重新露出来);
	*   1. 额外可写根 (设置页声明的与经审批的工作区外路径);
	*   2. 保护路径 (ro-bind / deny);
	*   3. 读拒绝路径 (tmpfs / `/dev/null` bind / `deny file-read*`);
	*   4. 本会话授权 (`writableOverrides` 与经审批的额外根) —— 它要在保护路径与
	*      读拒绝之后才能把被授权的子树从只读或不可读里翻回来, 否则命令侧就永远
	*      看不到本会话的授权.
	*/
	async confine(argv, policy, signal) {
		const result = await super.confine(argv, policy, signal);
		const runner = result.argv[0];
		const separator = result.argv.indexOf("--");
		const profileArgs = separator === -1 ? result.argv.slice(1) : result.argv.slice(1, separator);
		const isBwrap = runner === "bwrap" || profileArgs.includes("--ro-bind");
		const isLandlock = profileArgs.includes("--rw");
		const hardenWsl = this.shouldHardenWsl(policy);
		const workspaceWrite = policy.mode === "workspace-write";
		const overlaid = await this.overlayPolicy(policy);
		const extra = workspaceWrite ? overlaid.writablePaths ?? [] : [];
		const protectedPaths = workspaceWrite ? overlaid.readOnlyPaths ?? [] : [];
		const readDeny = overlaid.readDenyPaths ?? [];
		const grants = policy.sessionGrantPaths ?? policy.writableOverrides ?? [];
		const hasReadDeny = readDeny.length > 0 || (policy.readDenyPatterns ?? "").trim().length > 0;
		if (runner === "sandbox-exec") return this.hardenSeatbelt(result, overlaid);
		if (isBwrap) {
			let next = result;
			if (hardenWsl) next = this.withWslHarden(next, policy);
			if (extra.length > 0) next = this.withBwrapBinds(next, extra);
			if (protectedPaths.length > 0) next = this.withBwrapReadonly(next, protectedPaths);
			if (readDeny.length > 0) next = this.withBwrapReadDeny(next, readDeny);
			if (workspaceWrite && grants.length > 0) next = this.withBwrapGrantBinds(next, grants, true);
			else if (hasReadDeny && grants.length > 0) next = this.withBwrapGrantBinds(next, grants, false);
			return next;
		}
		if (isLandlock) {
			if (hardenWsl) this.warnLandlockWsl();
			let next = result;
			if (extra.length > 0) next = this.withLandlockWritable(next, extra);
			if (protectedPaths.length > 0) this.warnUnsupported(runner);
			if (readDeny.length > 0) this.warnLandlockReadDeny();
			if (grants.length > 0 && workspaceWrite) this.warnLandlockOverride();
			return next;
		}
		this.warnUnsupported(runner);
		return result;
	}
	/**
	* 取本次 confine 要用的完整路径清单: 生产路径上 policy 由本插件的 policy
	* service 生成, 保护路径与读拒绝路径的真实清单在这条 async 路径上从
	* `materialize()` 取 (同步的 `policy.resolve()` 只带模式原文与缓存快照).
	*
	* `read-only` 下只有确实配了读拒绝时才展开 (写侧在这个模式下没有意义, 白扫盘).
	* 取 policy service 走 `ctx.get()` 而不是 `ctx.sandboxPolicy`: 官方
	* `LocalSandboxProvider` 没有声明这个 inject, 直接读会在真实实例里抛
	* "cannot get property ... without inject"; `get()` 不需要声明, 服务缺失时给
	* undefined, 正好落到下面那份按 policy 清单的退路.
	*/
	async overlayPolicy(policy) {
		const materialize = this.materializeOf();
		const granted = unique(policy.writablePaths ?? []);
		const protectedPaths = unique(policy.readOnlyPaths ?? []);
		const declaredReadDeny = unique(policy.readDenyPaths ?? []);
		const readDenyText = (policy.readDenyPatterns ?? "").trim();
		if (!((policy.mode === "workspace-write" || readDenyText.length > 0 || declaredReadDeny.length > 0) && typeof policy.readOnlyPatterns === "string" && materialize !== void 0)) return {
			...policy,
			writablePaths: granted,
			readOnlyPaths: protectedPaths,
			readDenyPaths: declaredReadDeny
		};
		const snap = await materialize(policy.workspaceRoot);
		return {
			...policy,
			writablePaths: unique([...granted, ...snap.writable]),
			readOnlyPaths: unique([...protectedPaths, ...snap.readOnly]),
			readDenyPaths: unique([...declaredReadDeny, ...snap.readDeny ?? []])
		};
	}
	/** policy service 的异步展开入口, 服务缺失或形状不符时为 undefined. */
	materializeOf() {
		const service = this.ctx.get("sandboxPolicy");
		const materialize = service?.materialize;
		return typeof materialize === "function" ? materialize.bind(service) : void 0;
	}
	/**
	* Seatbelt: 按顺序追加额外可写 allow, 保护路径 deny, 读拒绝 deny (枚举清单与
	* 按原文生成的正则), 本会话授权的 allow, 最后是 broker 逃逸拒绝形式. 结尾的
	* deny 必须留在 profile 末尾才能盖过 `(allow default)`; 授权的 allow 又必须
	* 排在保护与读拒绝的 deny 之后, 否则那些 deny 会盖掉它.
	* `hardenBroker` 被显式关掉时只跳过 broker 拒绝形式, 命令按官方 profile 运行.
	*/
	hardenSeatbelt(result, policy) {
		return this.appendSeatbelt(result, this.seatbeltForms(policy));
	}
	/** 按"后匹配生效"的顺序拼出这次 confine 要追加的全部 SBPL 形式. */
	seatbeltForms(policy) {
		const workspaceWrite = policy.mode === "workspace-write";
		const grants = policy.sessionGrantPaths ?? policy.writableOverrides ?? [];
		const forms = [];
		const extra = (workspaceWrite ? policy.writablePaths ?? [] : []).filter((path) => !isFilesystemRoot(path));
		if (extra.length > 0) forms.push(seatbeltSubpathAllow(extra, "file-write*"));
		const protectedPaths = workspaceWrite ? policy.readOnlyPaths ?? [] : [];
		if (protectedPaths.length > 0) forms.push(seatbeltSubpathDeny(protectedPaths, "file-write*"));
		if (workspaceWrite) forms.push(...seatbeltRegexDenials(policy.readOnlyPatterns ?? "", policy.workspaceRoot, "file-write*"));
		const readDeny = policy.readDenyPaths ?? [];
		if (readDeny.length > 0) forms.push(seatbeltSubpathDeny(readDeny, "file-read*"));
		forms.push(...seatbeltRegexDenials(policy.readDenyPatterns ?? "", policy.workspaceRoot, "file-read*"));
		const readable = grants.filter((path) => !isFilesystemRoot(path));
		const hasReadDeny = readDeny.length > 0 || (policy.readDenyPatterns ?? "").trim().length > 0;
		if (readable.length > 0 && (workspaceWrite || hasReadDeny)) {
			if (workspaceWrite) forms.push(seatbeltSubpathAllow(readable, "file-write*"));
			if (hasReadDeny) forms.push(seatbeltSubpathAllow(readable, "file-read*"));
		}
		if (policy.hardenBroker !== false) forms.push(...SEATBELT_BROKER_DENIALS);
		return forms;
	}
	/**
	* 当前这次 confine 要不要叠加 WSL 加固. `hardenWsl === false` 显式关掉;
	* 未声明按开启. 测试注入 `internals.platform` 时必须再给 `probeWsl`, 否则
	* 默认否, 避免 WSL 宿主上的 argv 单测被真实探测打乱.
	*/
	shouldHardenWsl(policy) {
		if (policy.hardenWsl === false) return false;
		if (typeof this.internals.probeWsl === "function") return this.internals.probeWsl();
		if (this.internals.platform !== void 0) return false;
		return isWslHost();
	}
	/** 在 `--` 之前插入 WSL 互操作加固参数 (tmpfs `/mnt` 等). */
	withWslHarden(result, policy) {
		return this.insertBeforeSeparator(result, wslHardenArgs({
			workspaceRoot: policy.workspaceRoot,
			mode: policy.mode
		}));
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
	* bwrap: 在 `--` 分隔符之前插入读拒绝挂载. 目录用 `--tmpfs` 盖成空目录,
	* 文件用 `--ro-bind /dev/null` 盖成空文件 —— 两者都让沙箱内的读取拿不到内容,
	* 且必须排在保护路径的 ro-bind 之后 (后挂载覆盖早挂载). 宿主上不存在的路径
	* 跳过并告警 (它还不存在, 也就没什么可读).
	*/
	withBwrapReadDeny(result, paths) {
		const args = [];
		const missing = [];
		for (const path of paths) {
			let isDirectory = false;
			try {
				isDirectory = lstatSync(path).isDirectory();
			} catch {
				missing.push(path);
				continue;
			}
			if (isDirectory) args.push("--tmpfs", path);
			else args.push("--ro-bind", "/dev/null", path);
		}
		if (missing.length > 0) this.warnMissingReadDeny(missing);
		return this.insertBeforeSeparator(result, args);
	}
	/**
	* bwrap: 在 `--` 分隔符之前插入本会话授权的挂载对. 它必须排在保护路径的
	* ro-bind 与读拒绝挂载 **之后**, 否则那些挂载会把授权子树又压回只读或不可读.
	* `workspace-write` 下挂成可写 bind (`--bind`), `read-only` 下只挂成只读
	* (`--ro-bind`) —— 那个模式下授权只用来恢复可读, 不能打穿只读.
	*/
	withBwrapGrantBinds(result, paths, writable) {
		const binds = [];
		const missing = [];
		for (const path of paths) {
			if (writable && isFilesystemRoot(path)) continue;
			if (existsSync(path)) binds.push(writable ? "--bind" : "--ro-bind", path, path);
			else missing.push(path);
		}
		if (missing.length > 0) this.warnMissingOverride(missing);
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
	/**
	* bwrap 无法挂载的缺失读拒绝路径: 告警. 它还不存在, 命令侧也就读不到什么;
	* 等它被创建出来之后, 下一次展开就会把它算进清单.
	*/
	warnMissingReadDeny(paths) {
		this.ctx.logger?.warn?.(`dsh-write-protect: bwrap cannot hide missing read-denied paths, skipped (the read tools already fence them by pattern): ${JSON.stringify(paths)}`);
	}
	/** bwrap / Landlock 无法授权的缺失额外可写根: 告警, fs 围栏仍会按词法放行. */
	warnMissingWritable(paths) {
		this.ctx.logger?.warn?.(`dsh-write-protect: sandbox runner cannot grant missing extra writable roots, skipped (write/edit tools still allow them): ${JSON.stringify(paths)}`);
	}
	/**
	* Landlock 是纯 allow-list, 无法表达"父目录只读, 其中一棵子树可写": 把保护
	* 旁路通过 `--rw` 加进去会连同上方被保护的父目录一起放开, 反而扩大权限, 因此
	* 命令侧不叠加它, 只告警一次.
	*/
	warnLandlockOverride() {
		if (this.warnedLandlockOverride) return;
		this.warnedLandlockOverride = true;
		this.ctx.logger?.warn?.("dsh-write-protect: Landlock cannot express a writable subtree inside a protected directory, so session grants apply to the write/edit tools only on this runner (bwrap and macOS Seatbelt honor them for commands too)");
	}
	/**
	* Landlock 不能藏挂载点, 也就挡不住 WSL 的 PE 互操作: 只告警一次, 命令按
	* 官方 profile 跑.
	*/
	warnLandlockWsl() {
		if (this.warnedLandlockWsl) return;
		this.warnedLandlockWsl = true;
		this.ctx.logger?.warn?.("dsh-write-protect: Landlock cannot hide WSL interop paths, so Windows PE execution is not blocked on this runner (bwrap honors hardenWsl)");
	}
	/** bwrap 无法挂载的缺失保护旁路: 告警, write/edit 侧仍然按授权放行. */
	warnMissingOverride(paths) {
		this.ctx.logger?.warn?.(`dsh-write-protect: bwrap cannot bind missing session grant paths, skipped (write/edit tools still allow them; the command side picks them up once they exist): ${JSON.stringify(paths)}`);
	}
	/**
	* Landlock 是纯 allow-list, 父目录一旦放行读, 其中的子树就挖不掉: 读拒绝在
	* 这个 runner 上无法表达, 只告警一次 (工具侧围栏照常生效).
	*/
	warnLandlockReadDeny() {
		if (this.warnedLandlockReadDeny) return;
		this.warnedLandlockReadDeny = true;
		this.ctx.logger?.warn?.("dsh-write-protect: Landlock cannot express a read denial inside an allowed root, so sandboxed commands can still read read-denied paths on this runner (the read tools are fenced; prefer bwrap on Linux)");
	}
};
//#endregion
export { WriteProtectSandboxProvider, WriteProtectSandboxProvider as default, name };

//# sourceMappingURL=provider.mjs.map
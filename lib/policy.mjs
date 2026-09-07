import z from "@deepseek-ai/schemastery";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalPath } from "@deepseek-ai/dsh-sandbox";
//#region src/constants.ts
/**
* 共享契约: 纯常量与类型合并, Host 与 Client 两端共用. 不允许引入任何
* 运行时依赖 (Client bundle 的纯度要求双端共享的值必须是浏览器安全的字面量).
* @module dsh-write-protect/constants
*/
/** 插件标识: settings namespace, client 注册 id 与 package name 三者一致. */
const PLUGIN_ID = "dsh-write-protect";
/** settings namespace 的 patterns 字段名 (gitignore 风格的多行文本). */
const PATTERNS_FIELD = "patterns";
/**
* 保护路径的唯一默认来源: patch 配置 `readOnlyPaths` 的 schema 默认值与
* 设置页展示的部署 base 都由它推导. 修改默认保护范围只需改这一处.
*/
const DEFAULT_READ_ONLY_PATHS = [".git"];
/** 单次 glob 展开的遍历节点预算, 防止 `**` 模式在超大目录树上失控. */
const EXPAND_NODE_BUDGET = 5e3;
//#endregion
//#region src/patterns.ts
/**
* gitignore 风格的保护路径配置解析: 多行文本, 每行一条, `#` 注释, 空行忽略,
* `!` 取反, 每条支持词法 glob (`*`, `?`, `**`). 相对条目锚定到工作区根
* (每个会话的工作区各自解析), 绝对条目原样使用.
*
* 展开语义: 字面条目直接保留 (路径尚不存在时保留词法形态, fs 围栏与
* Seatbelt 对不存在路径同样有效); glob 条目枚举匹配的现有路径 (受限节点
* 预算, 超限停止并告警). 取反条目从展开结果中剔除匹配项 — 语义是
* "剔除一条展开结果", 不能在仍受保护的目录内部重新放行后代.
* @module dsh-write-protect/patterns
*/
/**
* 解析配置文本为条目列表: 跳过空行与 `#` 注释, 处理 `!` 前缀与尾部 `/`.
* 前导 `/` 原样保留 — 以 `/` 开头的条目按绝对路径解释 (相对条目本就锚定
* 工作区根, 无需前导斜杠锚定).
*/
function parsePatternLines(text) {
	const entries = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const negated = line.startsWith("!");
		let pattern = negated ? line.slice(1).trim() : line;
		if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
		if (pattern.length === 0) continue;
		entries.push({
			negated,
			pattern
		});
	}
	return entries;
}
/** 是否为字面条目 (不含 glob 元字符), 无需文件系统枚举. */
function isLiteralPattern(pattern) {
	return !/[*?]/.test(pattern);
}
/** 把一个 glob 段序列编译为 POSIX 形态路径的全匹配正则 (空段滤除). */
function globToRegExp(pattern, caseSensitive) {
	const source = pattern.split("/").filter((segment) => segment.length > 0).map((segment) => {
		if (segment === "**") return ".+";
		let out = "";
		for (const ch of segment) if (ch === "*") out += "[^/]*";
		else if (ch === "?") out += "[^/]";
		else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return out;
	}).join("/");
	return new RegExp(`^${source}$`, caseSensitive ? "" : "i");
}
const GLOB_MATCH_CASE_SENSITIVE = process.platform !== "win32";
/** 预算耗尽信号: 展开中途停止, 已收集的路径仍然有效. */
var BudgetExceeded = class extends Error {};
/** 共享的遍历预算: readdir 与存在性检查都消耗. */
var NodeBudget = class {
	remaining;
	constructor(limit) {
		this.remaining = limit;
	}
	spend() {
		this.remaining -= 1;
		if (this.remaining < 0) throw new BudgetExceeded("node budget exhausted");
	}
};
/**
* 枚举一个 glob 条目在 `basePosix` 下匹配的现有路径 (POSIX 形态词法路径).
* `**` 递归枚举后代目录, 含 glob 的段用 readdir 过滤, 字面段直接拼接并
* 以存在性剪枝.
*/
function collectGlobMatches(segments, basePosix, budget) {
	const caseSensitive = GLOB_MATCH_CASE_SENSITIVE;
	const matches = [];
	let exhausted = false;
	const walk = (current, index) => {
		if (index >= segments.length) {
			matches.push(current);
			return;
		}
		const segment = segments[index];
		if (segment === "**") {
			walk(current, index + 1);
			budget.spend();
			let names;
			try {
				names = readdirSync(current);
			} catch {
				return;
			}
			for (const name of names) {
				const child = `${current}/${name}`;
				budget.spend();
				let isDir = false;
				try {
					isDir = statSync(child).isDirectory();
				} catch {
					continue;
				}
				if (isDir) walk(child, index);
			}
			return;
		}
		const last = index === segments.length - 1;
		if (isLiteralPattern(segment)) {
			const next = `${current}/${segment}`;
			budget.spend();
			if (!existsSync(next)) return;
			if (last) matches.push(next);
			else walk(next, index + 1);
			return;
		}
		const regex = globToRegExp(segment, caseSensitive);
		budget.spend();
		let names;
		try {
			names = readdirSync(current);
		} catch {
			return;
		}
		for (const name of names) {
			if (!regex.test(name)) continue;
			const next = `${current}/${name}`;
			if (last) {
				matches.push(next);
				continue;
			}
			budget.spend();
			let isDir = false;
			try {
				isDir = statSync(next).isDirectory();
			} catch {
				continue;
			}
			if (isDir) walk(next, index + 1);
		}
	};
	try {
		walk(basePosix, 0);
	} catch (error) {
		if (!(error instanceof BudgetExceeded)) throw error;
		exhausted = true;
	}
	return {
		paths: matches,
		exhausted
	};
}
function toPosix(path) {
	return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}
/**
* 把配置文本针对一次调用的工作区根展开为 canonical 保护路径. glob 条目只
* 收集展开时刻已存在的路径 (之后新建的路径不受保护); 预算耗尽时保留已收集
* 的部分并附带告警.
* @param text - gitignore 风格的配置文本.
* @param workspaceRoot - 本次调用的工作区根.
* @returns canonical 保护路径 (去重) 与告警列表.
*/
function expandReadOnlyPaths(text, workspaceRoot) {
	const warnings = [];
	const entries = parsePatternLines(text);
	const positive = [];
	const negativeRegexps = [];
	const budget = new NodeBudget(EXPAND_NODE_BUDGET);
	for (const { negated, pattern } of entries) {
		if (negated) {
			negativeRegexps.push(globToRegExp(pattern, GLOB_MATCH_CASE_SENSITIVE));
			continue;
		}
		if (isLiteralPattern(pattern)) {
			positive.push({
				pattern,
				paths: [resolve(workspaceRoot, pattern)]
			});
			continue;
		}
		const collected = collectGlobMatches(pattern.split("/").filter((segment) => segment.length > 0), isAbsolute(pattern) ? "/" : toPosix(workspaceRoot), budget);
		if (collected.exhausted) warnings.push(`glob "${pattern}" reached the traversal budget (${EXPAND_NODE_BUDGET} nodes), the expansion may be incomplete`);
		positive.push({
			pattern,
			paths: collected.paths.map((path) => resolve(path))
		});
	}
	const paths = [];
	const seen = /* @__PURE__ */ new Set();
	for (const { paths: collected } of positive) for (const path of collected) {
		if (isNegated(path, workspaceRoot, negativeRegexps)) continue;
		const canonical = canonicalPath(path);
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		paths.push(canonical);
	}
	return {
		paths,
		warnings
	};
}
/** 是否命中任一取反条目 (按工作区相对路径或绝对路径匹配). */
function isNegated(path, workspaceRoot, negatives) {
	if (negatives.length === 0) return false;
	const rel = relative(workspaceRoot, path);
	const candidates = rel === "" || rel.startsWith("..") ? [toPosix(path)] : [toPosix(rel), toPosix(path)];
	return negatives.some((regex) => candidates.some((candidate) => regex.test(candidate)));
}
//#endregion
//#region src/policy.ts
const name = "dsh-write-protect-policy";
/** 展开结果的缓存有效时长: resolve 每个 tool call 都会调用, glob 枚举有 IO 成本. */
const EXPAND_TTL_MS = 5e3;
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
	baseEntries;
	settingsOwner;
	cache = {
		at: 0,
		key: "",
		paths: []
	};
	warned = /* @__PURE__ */ new Set();
	constructor(ctx, config) {
		super(ctx, config);
		const entries = config.readOnlyPaths ?? [];
		for (const entry of entries) if (entry.trim().length === 0) throw new Error("dsh-write-protect: readOnlyPaths entries must be non-empty strings");
		this.baseEntries = entries;
		ctx.inject(["settings"], (scope) => {
			const owner = scope.settings.register(PLUGIN_ID, WriteProtectSettingsSchema, { base: { [PATTERNS_FIELD]: this.baseText() } });
			this.settingsOwner = owner;
			owner.watch(() => {
				this.cache = {
					at: 0,
					key: "",
					paths: []
				};
			});
		});
		ctx.inject(["systemPrompt"], (scope) => {
			scope.systemPrompt.context({
				name: "sandbox:write-protect",
				order: 112,
				text: (context) => {
					const session = context.agent?.session;
					if (session === void 0) return "";
					const paths = this.expanded(this.resolve({ session }).workspaceRoot);
					if (paths.length === 0) return "";
					return `Write-protected paths (all DSH-enforced operations deny writes beneath them; reads stay allowed): ${JSON.stringify(paths)}.`;
				}
			});
		});
	}
	/** 部署 base 的文本形态 (patch 数组逐行合并). */
	baseText() {
		return this.baseEntries.join("\n");
	}
	/** 当前生效文本: 用户在设置页保存过的 patterns 覆盖部署 base. */
	currentText() {
		const value = this.settingsOwner?.get()?.[PATTERNS_FIELD];
		return typeof value === "string" ? value : this.baseText();
	}
	/**
	* 展开当前生效文本为 canonical 保护路径, 按 (文本, 工作区根) 做 TTL 缓存.
	* 展开告警 (如 glob 遍历预算耗尽) 对每条只告警一次.
	*/
	expanded(workspaceRoot) {
		const text = this.currentText();
		const key = `${text}\u0000${workspaceRoot}`;
		const now = Date.now();
		if (now - this.cache.at < EXPAND_TTL_MS && this.cache.key === key) return this.cache.paths;
		const { paths, warnings } = expandReadOnlyPaths(text, workspaceRoot);
		for (const warning of warnings) if (!this.warned.has(warning)) {
			this.warned.add(warning);
			this.ctx.logger?.warn?.(`dsh-write-protect: ${warning}`);
		}
		this.cache = {
			at: now,
			key,
			paths
		};
		return paths;
	}
	/**
	* 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
	* 追加注入解析后的保护路径.
	* @param request - 可选的会话与已批准的模式覆盖.
	* @returns 带有 `readOnlyPaths` 的完整逐次调用 policy.
	*/
	resolve(request = {}) {
		const policy = super.resolve(request);
		policy.readOnlyPaths = this.expanded(policy.workspaceRoot);
		return policy;
	}
};
/** settings namespace 的 schema: patterns 是多行文本, 未编辑时为 undefined (走 base). */
const WriteProtectSettingsSchema = z.object({ [PATTERNS_FIELD]: z.string() });
//#endregion
export { WriteProtectPolicyService, WriteProtectPolicyService as default, name };

//# sourceMappingURL=policy.mjs.map
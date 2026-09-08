import z from "@deepseek-ai/schemastery";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { canonicalPath } from "@deepseek-ai/dsh-sandbox";
import { homedir } from "node:os";
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
/** settings namespace 的额外可写根字段名 (字面路径的多行文本). */
const WRITABLE_FIELD = "writablePatterns";
/**
* 保护路径的唯一默认来源: patch 配置 `readOnlyPaths` 的 schema 默认值与
* 设置页展示的部署 base 都由它推导. 修改默认保护范围只需改这一处.
* gitignore 语义下 `.git` 在任意层级匹配, 覆盖工作区根与嵌套仓库; 通配
* 只收集展开时刻已存在的路径, 需要无条件保护时用锚定条目 (如 `/.git`).
*/
const DEFAULT_READ_ONLY_PATHS = [".git"];
/**
* 额外可写根的默认来源: 空列表. 只在 `workspace-write` 下把工作区外的
* 字面路径并进 allow-list, 默认不放宽任何位置.
*/
const DEFAULT_WRITABLE_PATHS = [];
/** 单次 glob 展开的遍历节点预算, 防止 `**` 模式在超大目录树上失控. */
const EXPAND_NODE_BUDGET = 5e3;
/** 设置页预览的 Host 路由. 相对当前 Web origin, POST JSON. */
const PREVIEW_PATH = "/dsh-write-protect/preview";
//#endregion
//#region src/path-expand.ts
/**
* 额外可写根的 `~` 与环境变量展开. 保护路径保持 gitignore 语义, 不走这里.
* 顺序对齐常见 shell: 先展开行首 `~` / `~/...` 为当前用户家目录, 再展开
* `$NAME` / `${NAME}`. `~user` 不支持. 未设置或空值的变量整行失败, 由调用
* 方告警跳过, 避免空串把路径拼成文件系统根.
* @module dsh-write-protect/path-expand
*/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
/**
* 展开一行额外可写配置: 行首 `~`, 然后 `$NAME` / `${NAME}`.
* `\` 转义下一字符 (`\$` 保留字面 `$`, `\~` 保留字面 `~`).
*/
function expandTildeAndEnv(line) {
	const withTilde = expandLeadingTilde(line);
	if ("error" in withTilde) return withTilde;
	return expandEnvVars(withTilde.ok);
}
/** 只认当前用户: 裸 `~` 与 `~/...`; `~user` 拒绝. */
function expandLeadingTilde(line) {
	if (!line.startsWith("~")) return { ok: line };
	const home = homedir();
	if (home.length === 0) return { error: "current user home directory is empty" };
	if (line === "~") return { ok: home };
	if (line.startsWith("~/")) return { ok: join(home, line.slice(2)) };
	return { error: "only ~ and ~/... expand to the current user home" };
}
/** 展开 `$NAME` 与 `${NAME}`; 名字必须是 POSIX 标识符. */
function expandEnvVars(input) {
	let out = "";
	let index = 0;
	while (index < input.length) {
		const ch = input[index];
		if (ch === "\\" && index + 1 < input.length) {
			out += input[index + 1];
			index += 2;
			continue;
		}
		if (ch === "$") {
			const ref = readEnvName(input, index + 1);
			if (ref === void 0) return { error: "has an invalid environment variable reference" };
			const value = process.env[ref.name];
			if (value === void 0 || value.length === 0) return { error: `references unset or empty environment variable "${ref.name}"` };
			out += value;
			index = ref.next;
			continue;
		}
		out += ch;
		index += 1;
	}
	return { ok: out };
}
function readEnvName(input, start) {
	if (input[start] === "{") {
		const end = input.indexOf("}", start + 1);
		if (end === -1) return void 0;
		const name = input.slice(start + 1, end);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return void 0;
		return {
			name,
			next: end + 1
		};
	}
	const slice = input.slice(start);
	const match = ENV_NAME.exec(slice);
	if (match === null) return void 0;
	return {
		name: match[0],
		next: start + match[0].length
	};
}
//#endregion
//#region src/patterns.ts
/**
* 保护路径配置解析, 完全对齐 gitignore(5) 的模式语义: 多行文本, 每行一条,
* `#` 注释, 空行忽略, `\` 转义 (`\#`, `\!`, 尾部空格用 `\ ` 保留), 尾部 `/`
* 只匹配目录, 含开头或中间分隔符的条目锚定到工作区根 (每个会话各自解析),
* 其余条目在任意层级匹配. 通配: `*` 与 `?` 不跨 `/`, `[...]` 字符类 (含
* `[:alpha:]` 等 POSIX 类), `**` 仅在独立成段时递归 (开头 = 任意层级, 中间 =
* 零或多层目录); 段内连续星号按普通 `*` 处理. `!` 取反按 gitignore 的
* last-match-wins 顺序解释, 但前缀围栏模型与 gitignore 的目录剪枝一致:
* 无法在仍受保护的目录内部重新放行后代.
*
* 展开语义: 锚定字面条目是单一显式路径, 不存在也保留 (fs 围栏与 Seatbelt
* 对不存在路径同样有效); 其余条目枚举展开时刻已存在的路径 (受限节点预算,
* 超限停止并告警, 新建路径要等下次重新展开才纳入). 执法扩展: `//` 前缀
* 表示文件系统绝对路径 (gitignore 没有这个形态, 部署配置需要); 以 `/**`
* 结尾的条目按前缀围栏等价性保护其命名目录本身, 而不是枚举全部后代.
* @module dsh-write-protect/patterns
*/
/** 解析前的行预处理: 移除未转义的尾部空格 (gitignore 只忽略尾部空格). */
function stripTrailingSpaces(line) {
	let end = line.length;
	while (end > 0 && line[end - 1] === " " && !isEscapedAt(line, end - 1)) end -= 1;
	return line.slice(0, end);
}
/** 位置 index 的字符是否被奇数个连续 `\` 转义. */
function isEscapedAt(line, index) {
	let slashes = 0;
	for (let i = index - 1; i >= 0 && line[i] === "\\"; i -= 1) slashes += 1;
	return slashes % 2 === 1;
}
/** 按未转义的 `/` 分段, 转义序列原样保留在段内. */
function splitUnescaped(line) {
	const segments = [];
	let current = "";
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "\\" && i + 1 < line.length) {
			current += ch + line[i + 1];
			i += 2;
			continue;
		}
		if (ch === "/") {
			segments.push(current);
			current = "";
			i += 1;
			continue;
		}
		current += ch;
		i += 1;
	}
	segments.push(current);
	return segments;
}
/**
* 解析配置文本为条目列表: 跳过空行与 `#` 注释, 处理 `!` 前缀, 尾部 `/` 与
* `//` 绝对扩展; 前导与中间的 `/` 使条目锚定到工作区根.
*/
function parsePatternLines(text) {
	const entries = [];
	for (const rawLine of text.split(/\r?\n/)) {
		let line = stripTrailingSpaces(rawLine);
		if (line.length === 0 || line.startsWith("#")) continue;
		const negated = line.startsWith("!");
		if (negated) line = line.slice(1);
		let dirOnly = false;
		while (line.length > 0 && line.endsWith("/") && !isEscapedAt(line, line.length - 1)) {
			line = line.slice(0, -1);
			dirOnly = true;
		}
		let fsAbsolute = false;
		let anchored = false;
		if (line.startsWith("//")) {
			fsAbsolute = true;
			anchored = true;
			line = line.slice(2);
		} else if (line.startsWith("/")) {
			anchored = true;
			line = line.slice(1);
		}
		const rawSegments = splitUnescaped(line);
		if (!anchored && rawSegments.length > 1) anchored = true;
		const segments = rawSegments.filter((segment) => segment.length > 0);
		if (segments.length === 0) continue;
		entries.push({
			negated,
			dirOnly,
			anchored,
			fsAbsolute,
			segments,
			source: line
		});
	}
	return entries;
}
/** 段是否为字面段 (不含 glob 元字符与转义), 可直接按文本拼接. */
function isLiteralSegment(segment) {
	return !/[*?[\]\\]/.test(segment);
}
function escapeRegExpChar(ch) {
	return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const POSIX_CLASSES = {
	alpha: "A-Za-z",
	alnum: "0-9A-Za-z",
	digit: "0-9",
	xdigit: "0-9A-Fa-f",
	lower: "a-z",
	upper: "A-Z",
	space: "\\t\\n\\v\\f\\r ",
	blank: " \\t",
	cntrl: "\\u0000-\\u001f\\u007f",
	punct: "!-/:-@\\[-`{-~",
	print: "\\x20-\\x7e",
	graph: "\\x21-\\x7e"
};
function escapeClassChar(ch) {
	return /[\\\]^[]/.test(ch) ? `\\${ch}` : ch;
}
/** 把 `[...]` 类编译为正则类片段; 未闭合时返回 undefined (按字面 `[` 处理). */
function parseCharClass(pattern, start) {
	let i = start + 1;
	let negated = false;
	if (pattern[i] === "!" || pattern[i] === "^") {
		negated = true;
		i += 1;
	}
	let body = "";
	let first = true;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "]" && !first) return {
			source: charClassSource(body, negated),
			next: i + 1
		};
		first = false;
		if (ch === "[" && pattern[i + 1] === ":") {
			const end = pattern.indexOf(":]", i + 2);
			if (end !== -1) {
				body += pattern.slice(i, end + 2);
				i = end + 2;
				continue;
			}
		}
		body += ch;
		i += 1;
	}
}
/** 类体到正则片段: `/` 永不匹配 (FNM_PATHNAME), POSIX 类展开为显式范围. */
function charClassSource(body, negated) {
	let inner = "";
	let i = 0;
	while (i < body.length) {
		if (body.startsWith("[:", i)) {
			const end = body.indexOf(":]", i + 2);
			const name = end === -1 ? void 0 : body.slice(i + 2, end);
			const range = name === void 0 ? void 0 : POSIX_CLASSES[name];
			if (range !== void 0) {
				inner += range;
				i = end + 2;
				continue;
			}
		}
		inner += escapeClassChar(body[i]);
		i += 1;
	}
	return `[${negated ? "^/" : ""}${inner}]`;
}
/**
* 把一个模式段编译为对单段路径名的全匹配正则 (段内不含真正的 `/`).
* `\x` 转义为字面 x; `*` 为 `[^/]*`, `?` 为 `[^/]`, `[...]` 为字符类.
*/
function segmentToRegExp(pattern, caseSensitive) {
	let source = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "\\" && i + 1 < pattern.length) {
			source += escapeRegExpChar(pattern[i + 1]);
			i += 2;
			continue;
		}
		if (ch === "*") {
			source += "[^/]*";
			i += 1;
			continue;
		}
		if (ch === "?") {
			source += "[^/]";
			i += 1;
			continue;
		}
		if (ch === "[") {
			const cls = parseCharClass(pattern, i);
			if (cls !== void 0) {
				source += cls.source;
				i = cls.next;
				continue;
			}
			source += "\\[";
			i += 1;
			continue;
		}
		source += escapeRegExpChar(ch);
		i += 1;
	}
	return new RegExp(`^${source}$`, caseSensitive ? "" : "i");
}
const GLOB_MATCH_CASE_SENSITIVE = process.platform !== "win32";
function compileEntry(entry) {
	const effective = entry.anchored || entry.fsAbsolute ? entry.segments : ["**", ...entry.segments];
	return {
		entry,
		effective,
		matchers: effective.map((segment) => segment === "**" ? null : segmentToRegExp(segment, GLOB_MATCH_CASE_SENSITIVE))
	};
}
/** 预算耗尽信号: 展开中途停止, 已收集的路径仍然有效. */
var BudgetExceeded = class extends Error {};
/** 共享的遍历预算: readdir 与 stat 都消耗. */
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
/** 带预算的目录性检查: 路径不存在时返回 null. */
function statIsDirBudgeted(path, budget) {
	budget.spend();
	try {
		return statSync(path).isDirectory();
	} catch {
		return null;
	}
}
/**
* 枚举一个条目在 `start` 下匹配的现有路径 (POSIX 形态词法路径). `**` 段按
* 零或多层目录递归, 字面段直接拼接并以存在性剪枝, 其余段用 readdir 过滤
* (非末段要求目录), 末段按 `dirOnly` 过滤.
*/
function collectGlobMatches(effective, matchers, dirOnly, start, budget) {
	const matches = [];
	let exhausted = false;
	const walk = (current, index) => {
		const segment = effective[index];
		const matcher = matchers[index];
		const last = index === effective.length - 1;
		if (matcher === null) {
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
				if (statIsDirBudgeted(child, budget) !== true) continue;
				walk(child, index);
			}
			return;
		}
		if (isLiteralSegment(segment)) {
			const next = `${current}/${segment}`;
			if (!last) {
				budget.spend();
				if (existsSync(next)) walk(next, index + 1);
				return;
			}
			const isDir = statIsDirBudgeted(next, budget);
			if (isDir === null || dirOnly && !isDir) return;
			matches.push({
				path: next,
				isDir
			});
			return;
		}
		budget.spend();
		let names;
		try {
			names = readdirSync(current);
		} catch {
			return;
		}
		for (const name of names) {
			if (!matcher.test(name)) continue;
			const next = `${current}/${name}`;
			if (!last) {
				budget.spend();
				if (statIsDirBudgeted(next, budget) !== true) continue;
				walk(next, index + 1);
				continue;
			}
			const isDir = statIsDirBudgeted(next, budget);
			if (isDir === null || dirOnly && !isDir) continue;
			matches.push({
				path: next,
				isDir
			});
		}
	};
	try {
		walk(start, 0);
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
function splitPosix(path) {
	return path.split("/").filter((segment) => segment.length > 0);
}
/** 单条目对候选路径的匹配: 目录标记, 锚定形态与 `**` 递归全部生效. */
function entryMatches(compiled, candidate, workspaceRoot) {
	if (compiled.entry.dirOnly && candidate.isDir === false) return false;
	let segments;
	if (compiled.entry.fsAbsolute) segments = splitPosix(toPosix(candidate.path));
	else {
		const rel = relative(workspaceRoot, candidate.path);
		if (rel.startsWith("..")) {
			if (compiled.entry.anchored && !compiled.entry.fsAbsolute) return false;
			segments = splitPosix(toPosix(candidate.path));
		} else segments = rel === "" ? [] : splitPosix(toPosix(rel));
	}
	return matchSegments(compiled.effective, compiled.matchers, segments);
}
/** 段序列匹配: `**` 匹配零或多层, 其余段逐段全匹配 (带记忆化避免指数回溯). */
function matchSegments(effective, matchers, segments) {
	const failed = /* @__PURE__ */ new Set();
	const walk = (pi, si) => {
		if (pi >= effective.length) return si === segments.length;
		const key = `${pi}:${si}`;
		if (failed.has(key)) return false;
		const matcher = matchers[pi];
		let ok;
		if (matcher === null) ok = walk(pi + 1, si) || si < segments.length && walk(pi, si + 1);
		else if (si >= segments.length) ok = false;
		else ok = matcher.test(segments[si]) && walk(pi + 1, si + 1);
		if (!ok) failed.add(key);
		return ok;
	};
	return walk(0, 0);
}
/** last-match-wins: 候选路径由顺序上最后命中的条目裁决去留. */
function lastMatchKeeps(candidate, compiledEntries, workspaceRoot) {
	let keeps = false;
	for (const compiled of compiledEntries) if (entryMatches(compiled, candidate, workspaceRoot)) keeps = !compiled.entry.negated;
	return keeps;
}
/**
* 把配置文本针对一次调用的工作区根展开为 canonical 保护路径, 语义对齐
* gitignore(5): 锚定字面条目不存在也保留; 其余条目只收集展开时刻已存在的
* 路径 (之后新建的路径要等下次展开才纳入); 预算耗尽时保留已收集的部分并
* 附带告警.
* @param text - gitignore 语义的配置文本.
* @param workspaceRoot - 本次调用的工作区根.
* @returns canonical 保护路径 (去重) 与告警列表.
*/
function expandReadOnlyPaths(text, workspaceRoot) {
	const warnings = [];
	const entries = parsePatternLines(text);
	const compiledEntries = entries.map(compileEntry);
	const budget = new NodeBudget(EXPAND_NODE_BUDGET);
	const candidates = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.negated) continue;
		const compiled = compiledEntries[index];
		const start = entry.fsAbsolute ? "/" : toPosix(workspaceRoot);
		let end = compiled.effective.length;
		while (end > 0 && compiled.effective[end - 1] === "**") end -= 1;
		if (end === 0) {
			candidates.push({
				path: start,
				isDir: true
			});
			continue;
		}
		if ((entry.anchored || entry.fsAbsolute) && compiled.effective.every((segment) => isLiteralSegment(segment))) {
			const path = resolve(entry.fsAbsolute ? "/" : workspaceRoot, entry.fsAbsolute ? `/${compiled.effective.join("/")}` : compiled.effective.join("/"));
			candidates.push({
				path,
				isDir: statIsDirBudgeted(path, budget)
			});
			continue;
		}
		const collected = collectGlobMatches(compiled.effective.slice(0, end), compiled.matchers.slice(0, end), entry.dirOnly || end < compiled.effective.length, start, budget);
		if (collected.exhausted) warnings.push(`glob "${entry.source}" reached the traversal budget (${EXPAND_NODE_BUDGET} nodes), the expansion may be incomplete`);
		candidates.push(...collected.paths);
	}
	const paths = [];
	const seen = /* @__PURE__ */ new Set();
	for (const candidate of candidates) {
		if (!lastMatchKeeps(candidate, compiledEntries, workspaceRoot)) continue;
		const canonical = canonicalPath(candidate.path);
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		paths.push(canonical);
	}
	return {
		paths,
		warnings
	};
}
/** 未转义的 glob 元字符: 额外可写根是字面路径, 命中则拒绝该行. */
function hasUnescapedGlobMeta(line) {
	for (let index = 0; index < line.length; index += 1) {
		if (line[index] === "\\") {
			index += 1;
			continue;
		}
		const ch = line[index];
		if (ch === "*" || ch === "?" || ch === "[") return true;
	}
	return false;
}
/** canonical 路径是否就是文件系统根 (POSIX `/` 或 Windows 盘符根). */
function isFilesystemRoot(path) {
	const canonical = canonicalPath(path);
	return canonical === parse(canonical).root;
}
/** 词法包含: extra 可写根若已落在工作区内则没有放宽效果. */
function isLexicallyUnderRoot(path, root) {
	const caseSensitive = process.platform !== "win32";
	const comparablePath = caseSensitive ? path : path.toLowerCase();
	const comparableRoot = caseSensitive ? root : root.toLowerCase();
	if (comparablePath === comparableRoot) return true;
	const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
	return comparablePath.startsWith(prefix);
}
/**
* 把额外可写配置文本展开为 canonical 根. 与保护路径不同, 这里是字面路径
* 列表而不是 gitignore glob: 行首 `~` / `~/...` 展开为当前用户家目录,
* `$NAME` / `${NAME}` 展开为环境变量; `//` 或宿主绝对路径按文件系统解析,
* 其余相对当前工作区 (含 `..`). 工作区内的条目没有放宽效果, 文件系统根
* 拒绝; 不存在的路径仍保留词法形态 (fs / Seatbelt 可按前缀放行, bwrap /
* Landlock 在叠加时跳过).
* @param text - 逐行一条字面路径的配置文本.
* @param workspaceRoot - 本次调用的工作区根.
* @returns canonical 额外可写根 (去重) 与告警列表.
*/
function expandWritablePaths(text, workspaceRoot) {
	const warnings = [];
	const paths = [];
	const seen = /* @__PURE__ */ new Set();
	const workspaceCanonical = canonicalPath(workspaceRoot);
	for (const rawLine of text.split(/\r?\n/)) {
		const line = stripTrailingSpaces(rawLine);
		if (line.length === 0 || line.startsWith("#")) continue;
		if (line.startsWith("!")) {
			warnings.push(`writable path "${line}" uses ! negation; extra writable roots are a literal list`);
			continue;
		}
		const expanded = expandTildeAndEnv(line);
		if ("error" in expanded) {
			warnings.push(`writable path "${line}" ${expanded.error}`);
			continue;
		}
		if (hasUnescapedGlobMeta(expanded.ok)) {
			warnings.push(`writable path "${line}" contains glob metacharacters; extra writable roots must be literal paths`);
			continue;
		}
		let resolved;
		if (expanded.ok.startsWith("//")) resolved = resolve("/", expanded.ok.slice(2));
		else if (isAbsolute(expanded.ok)) resolved = resolve(expanded.ok);
		else resolved = resolve(workspaceRoot, expanded.ok);
		if (isFilesystemRoot(resolved)) {
			warnings.push(`writable path "${line}" resolves to the filesystem root and is rejected`);
			continue;
		}
		const canonical = canonicalPath(resolved);
		if (isLexicallyUnderRoot(canonical, workspaceCanonical)) {
			warnings.push(`writable path "${line}" is already inside the workspace and is ignored`);
			continue;
		}
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		paths.push(canonical);
	}
	return {
		paths,
		warnings
	};
}
//#endregion
//#region src/preview.ts
/**
* 展开保护路径与额外可写根, 供设置页人工核对生效/未生效条目.
* @param patterns - gitignore 语义的保护路径文本.
* @param writablePatterns - 字面路径的额外可写根文本.
* @param workspaceRoot - 本次展开使用的工作区根.
*/
function previewPaths(patterns, writablePatterns, workspaceRoot) {
	const readOnly = expandReadOnlyPaths(patterns, workspaceRoot);
	const writable = expandWritablePaths(writablePatterns, workspaceRoot);
	return {
		workspaceRoot,
		readOnly: readOnly.paths,
		writable: writable.paths,
		warnings: [...readOnly.warnings, ...writable.warnings]
	};
}
//#endregion
//#region src/preview-route.ts
const MAX_BODY_BYTES = 262144;
function writeJson(response, status, value) {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": body.length
	});
	response.end(body);
}
function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		request.on("data", (chunk) => {
			const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			size += buffer.length;
			if (size > MAX_BODY_BYTES) {
				reject(/* @__PURE__ */ new Error("preview body too large"));
				request.destroy();
				return;
			}
			chunks.push(buffer);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}
function decodeDraft(value) {
	if (typeof value !== "object" || value === null) throw new Error("preview body must be an object");
	const record = value;
	const patterns = record.patterns;
	const writablePatterns = record.writablePatterns;
	if (patterns !== void 0 && typeof patterns !== "string") throw new Error("patterns must be a string");
	if (writablePatterns !== void 0 && typeof writablePatterns !== "string") throw new Error("writablePatterns must be a string");
	return {
		patterns: typeof patterns === "string" ? patterns : "",
		writablePatterns: typeof writablePatterns === "string" ? writablePatterns : ""
	};
}
/**
* 注册预览路由. 返回 disposer, 交给 ctx.effect.
* @param webServer - Host webServer 服务.
* @param workspaceRoot - 预览使用的工作区根 (部署回退根).
* @param connection - 可选鉴权.
*/
function mountPreviewRoute(webServer, workspaceRoot, connection) {
	return webServer.register({
		kind: "exact",
		path: PREVIEW_PATH,
		async handler(request, response) {
			try {
				const rejection = connection?.requestRejection?.(request);
				if (rejection !== void 0) {
					response.writeHead(rejection);
					response.end();
					return;
				}
				if (request.method !== "POST") {
					writeJson(response, 405, { error: "POST only" });
					return;
				}
				const draft = decodeDraft(JSON.parse(await readBody(request)));
				writeJson(response, 200, previewPaths(draft.patterns, draft.writablePatterns, workspaceRoot));
			} catch (error) {
				writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}
	});
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
		readOnlyPaths: z.array(z.string()).default([...DEFAULT_READ_ONLY_PATHS]),
		writablePaths: z.array(z.string()).default([...DEFAULT_WRITABLE_PATHS])
	});
	baseEntries;
	writableBaseEntries;
	settingsOwner;
	cache = {
		at: 0,
		key: "",
		readOnly: [],
		writable: []
	};
	warned = /* @__PURE__ */ new Set();
	constructor(ctx, config) {
		super(ctx, config);
		const entries = config.readOnlyPaths ?? [];
		const writableEntries = config.writablePaths ?? [];
		for (const entry of entries) if (entry.trim().length === 0) throw new Error("dsh-write-protect: readOnlyPaths entries must be non-empty strings");
		for (const entry of writableEntries) if (entry.trim().length === 0) throw new Error("dsh-write-protect: writablePaths entries must be non-empty strings");
		this.baseEntries = entries;
		this.writableBaseEntries = writableEntries;
		ctx.inject(["settings"], (scope) => {
			const owner = scope.settings.register(PLUGIN_ID, WriteProtectSettingsSchema, { base: {
				[PATTERNS_FIELD]: this.baseText(),
				[WRITABLE_FIELD]: this.writableBaseText()
			} });
			this.settingsOwner = owner;
			owner.watch(() => {
				this.cache = {
					at: 0,
					key: "",
					readOnly: [],
					writable: []
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
					const { readOnly, writable } = this.snapshot(this.resolve({ session }).workspaceRoot);
					const parts = [];
					if (readOnly.length > 0) parts.push(`Write-protected paths (all DSH-enforced operations deny writes beneath them; reads stay allowed): ${JSON.stringify(readOnly)}.`);
					if (writable.length > 0) parts.push(`Additional writable roots under workspace-write (sandboxed commands and write/edit tools may write here; write-protected paths still win; does not apply in read-only): ${JSON.stringify(writable)}.`);
					return parts.join(" ");
				}
			});
		});
		ctx.inject(["webServer"], (scope) => {
			const server = scope.webServer;
			const connection = scope.connection;
			scope.effect(() => mountPreviewRoute(server, this.workspaceRoot, connection), "dsh-write-protect: preview route");
		});
	}
	/** 部署 base 的保护路径文本形态 (patch 数组逐行合并). */
	baseText() {
		return this.baseEntries.join("\n");
	}
	/** 部署 base 的额外可写根文本形态 (patch 数组逐行合并). */
	writableBaseText() {
		return this.writableBaseEntries.join("\n");
	}
	/** 当前生效的保护路径文本: 用户在设置页保存过的 patterns 覆盖部署 base. */
	currentText() {
		const value = this.settingsOwner?.get()?.[PATTERNS_FIELD];
		return typeof value === "string" ? value : this.baseText();
	}
	/** 当前生效的额外可写文本: 用户保存过的 writablePatterns 覆盖部署 base. */
	currentWritableText() {
		const value = this.settingsOwner?.get()?.[WRITABLE_FIELD];
		return typeof value === "string" ? value : this.writableBaseText();
	}
	/**
	* 展开当前生效文本为 canonical 保护路径与额外可写根, 按
	* (两份文本, 工作区根) 做 TTL 缓存. 展开告警对每条只告警一次.
	*/
	snapshot(workspaceRoot) {
		const readOnlyText = this.currentText();
		const writableText = this.currentWritableText();
		const key = `${readOnlyText}\u0000${writableText}\u0000${workspaceRoot}`;
		const now = Date.now();
		if (now - this.cache.at < EXPAND_TTL_MS && this.cache.key === key) return {
			readOnly: this.cache.readOnly,
			writable: this.cache.writable
		};
		const readOnly = expandReadOnlyPaths(readOnlyText, workspaceRoot);
		const writable = expandWritablePaths(writableText, workspaceRoot);
		for (const warning of [...readOnly.warnings, ...writable.warnings]) if (!this.warned.has(warning)) {
			this.warned.add(warning);
			this.ctx.logger?.warn?.(`dsh-write-protect: ${warning}`);
		}
		this.cache = {
			at: now,
			key,
			readOnly: readOnly.paths,
			writable: writable.paths
		};
		return {
			readOnly: readOnly.paths,
			writable: writable.paths
		};
	}
	/**
	* 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
	* 追加注入解析后的保护路径与额外可写根.
	* @param request - 可选的会话与已批准的模式覆盖.
	* @returns 带有 `readOnlyPaths` 与 `writablePaths` 的完整逐次调用 policy.
	*/
	resolve(request = {}) {
		const policy = super.resolve(request);
		const { readOnly, writable } = this.snapshot(policy.workspaceRoot);
		policy.readOnlyPaths = readOnly;
		policy.writablePaths = writable;
		return policy;
	}
};
/** settings namespace 的 schema: 两份多行文本, 未编辑时为 undefined (走 base). */
const WriteProtectSettingsSchema = z.object({
	[PATTERNS_FIELD]: z.string(),
	[WRITABLE_FIELD]: z.string()
});
//#endregion
export { WriteProtectPolicyService, WriteProtectPolicyService as default, name };

//# sourceMappingURL=policy.mjs.map
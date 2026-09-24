import { dirname, isAbsolute, relative, sep } from "node:path";
import { stat } from "node:fs/promises";
//#region src/constants.ts
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
/**
* 工作区只读规则文件的默认文件名 (工作区根下的单份文件). 内容与设置页的
* 保护路径同语义 (gitignore), 运行期合并进生效文本; 置空即关闭该识别.
*/
const DEFAULT_READONLY_FILE_NAME = ".readonly";
/**
* 规则文件名的禁用值: 这些名字本身是配置或版本库元数据, 允许模型申请可写
* 授权后改写它们等于让规则来源可被写入方自己改写.
*/
const FORBIDDEN_READONLY_FILE_NAMES = [
	".git",
	".gitignore",
	".gitattributes"
];
/** 模型工具名: 申请工作区外可写根或放开某条保护路径的本会话授权. */
const REQUEST_WRITABLE_PATH_TOOL = "request_writable_path";
/**
* 校验只读规则文件名: 必须是工作区根下的单个文件名, 不含路径分隔符, 不是
* `.` / `..`, 也不是会被写保护法规本身依赖的元数据名.
* @param value - 设置页或 patch 给出的候选名 (前后空格忽略).
* @returns 合法返回原名, 非法返回 undefined (调用方回退默认值并告警).
*/
function isValidReadonlyFileName(value) {
	const name = value.trim();
	if (name.length === 0) return false;
	if (name.includes("/") || name.includes("\\")) return false;
	if (name === "." || name === "..") return false;
	return !FORBIDDEN_READONLY_FILE_NAMES.includes(name);
}
/** 设置页预览的 Host Fetch 路由, 走 `/api` 鉴权通道. POST JSON. */
const PREVIEW_PATH = "/api/dsh-write-protect.preview";
//#endregion
//#region src/gitignore.ts
/**
* gitignore(5) 语义的模式解析与匹配 —— **纯逻辑**: 只做字符串与正则运算, 不碰
* 文件系统, 不依赖任何 `@deepseek-ai/*` 包, 因此可以被 fs 围栏、枚举展开与测试
* 各自独立引用.
*
* 语义: 多行文本, 每行一条, `#` 注释, 空行忽略, `\` 转义 (`\#`, `\!`, 尾部空格
* 用 `\ ` 保留), 尾部 `/` 只匹配目录, 含开头或中间分隔符的条目锚定到工作区根
* (每个会话各自解析), 其余条目在任意层级匹配. 通配: `*` 与 `?` 不跨 `/`,
* `[...]` 字符类 (含 `[:alpha:]` 等 POSIX 类), `**` 仅在独立成段时递归 (开头 =
* 任意层级, 中间 = 零或多层目录); 段内连续星号按普通 `*` 处理. `!` 取反按
* gitignore 的 last-match-wins 顺序解释.
*
* 前缀围栏模型 (与 gitignore 的目录剪枝一致, 也是本插件执法语义的核心):
* 一条条目命中某个**目录**时, 该目录及其全部后代都受保护, 且不能在仍受保护的
* 目录内部用 `!` 重新放行后代; 被 `!` 放行的目录则是重新敞开的, 其内部的匹配
* 照常生效 —— {@link PatternSet.match} 从目标路径逐级向上找"最近的、顺序上最后
* 命中且未取反"的祖先, 命中的那个就是围栏起点.
*
* 执法扩展: `//` 前缀表示文件系统绝对路径 (gitignore 没有这个形态, 部署配置
* 需要). 相对条目只作用于工作区**内**, 工作区外只有 `//` 绝对条目有效.
* @module dsh-write-protect/gitignore
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
/** 平台默认的大小写敏感: Windows 上文件名不区分大小写 (git 亦如此). */
const DEFAULT_CASE_SENSITIVE = process.platform !== "win32";
/** 编译一条条目 (枚举展开与逐路径匹配共用同一份编译结果). */
function compileEntry(entry, caseSensitive = DEFAULT_CASE_SENSITIVE) {
	const effective = entry.anchored || entry.fsAbsolute ? entry.segments : ["**", ...entry.segments];
	return {
		entry,
		effective,
		matchers: effective.map((segment) => segment === "**" ? null : segmentToRegExp(segment, caseSensitive))
	};
}
/** 路径统一成分隔符为 `/` 的形态 (枚举展开与匹配都以 POSIX 形态拼接). */
function toPosix(path) {
	return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}
function splitPosix(path) {
	return path.split("/").filter((segment) => segment.length > 0);
}
/** 相对路径是否指向工作区之外 (`..` 开头或另一盘符的绝对路径). */
function isOutsideWorkspace(relativePath) {
	return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}
/** 单条目对候选路径的匹配: 目录标记, 锚定形态与 `**` 递归全部生效. */
function entryMatches(compiled, candidate, workspaceRoot) {
	if (compiled.entry.dirOnly && candidate.isDir === false) return false;
	let segments;
	if (compiled.entry.fsAbsolute) segments = splitPosix(toPosix(candidate.path));
	else {
		const rel = relative(workspaceRoot, candidate.path);
		if (isOutsideWorkspace(rel)) return false;
		segments = rel === "" ? [] : splitPosix(toPosix(rel));
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
/**
* 顺序上最后命中的条目 (last-match-wins 的原始裁决), 没有命中时为 undefined.
* 枚举展开用它做目录剪枝与结果裁决, {@link PatternSet.match} 用它判断某个祖先
* 目录是被保护还是被 `!` 放行.
*/
function lastMatchingEntry(candidate, compiledEntries, workspaceRoot) {
	let matched;
	for (const compiled of compiledEntries) if (entryMatches(compiled, candidate, workspaceRoot)) matched = compiled.entry;
	return matched;
}
/** last-match-wins: 候选路径由顺序上最后命中的条目裁决去留 (取反即放行). */
function lastMatchKeeps(candidate, compiledEntries, workspaceRoot) {
	const entry = lastMatchingEntry(candidate, compiledEntries, workspaceRoot);
	return entry !== void 0 && !entry.negated;
}
/**
* 把配置文本编译为可反复匹配的 {@link PatternSet}. 编译结果只取决于文本与
* 大小写设置, 与工作区根无关 (根是匹配时的参数), 因此同一份文本可以服务多个
* 会话工作区, 调用方可以放心按文本缓存.
*/
function compileGitignore(text, options = {}) {
	const caseSensitive = options.caseSensitive ?? DEFAULT_CASE_SENSITIVE;
	const entries = parsePatternLines(text);
	const compiledEntries = entries.map((entry) => compileEntry(entry, caseSensitive));
	return {
		entries,
		match(path, workspaceRoot, isDir) {
			if (compiledEntries.length === 0) return void 0;
			let current = path;
			let currentIsDir = isDir;
			while (true) {
				const entry = lastMatchingEntry({
					path: current,
					isDir: currentIsDir
				}, compiledEntries, workspaceRoot);
				if (entry !== void 0 && !entry.negated) return {
					path: current,
					entry
				};
				const parent = dirname(current);
				if (parent === current) return void 0;
				current = parent;
				currentIsDir = true;
			}
		}
	};
}
//#endregion
//#region src/containment.ts
const MISSING_CODES = /* @__PURE__ */ new Set(["ENOENT", "ENOTDIR"]);
function isMissing(error) {
	const code = error.code;
	return MISSING_CODES.has(code);
}
function comparablePath(path, caseSensitive) {
	return caseSensitive ? path : path.toLowerCase();
}
function isLexicallyUnder(path, root, caseSensitive) {
	const comparableTarget = comparablePath(path, caseSensitive);
	const comparableRoot = comparablePath(root, caseSensitive);
	if (comparableTarget === comparableRoot) return true;
	const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
	return comparableTarget.startsWith(prefix);
}
async function statIfPresent(path) {
	try {
		return await stat(path, { bigint: true });
	} catch (error) {
		if (isMissing(error)) return void 0;
		throw error;
	}
}
function sameIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}
/**
* 判断 canonical 目标是否就是某个保护根或位于其下. 词法快速路径处理常规
* canonical 拼写; 拼写不同时沿目标已存在的祖先向上比较文件系统身份, 因此
* 指向保护目录内部的符号链接仍会被拒绝, 而指向外部的则不会.
* @param path - canonical 目标键, 末尾可能带有尚不存在的后缀.
* @param root - canonical 保护路径.
* @param caseSensitive - 词法比较是否区分大小写; 默认按宿主文件系统惯例.
* @returns 目标是否为该根本身或其后代.
*/
async function isPathUnder(path, root, caseSensitive = process.platform !== "win32") {
	if (isLexicallyUnder(path, root, caseSensitive)) return true;
	const rootInfo = await statIfPresent(root);
	if (!rootInfo) return false;
	let ancestor = path;
	while (true) {
		const ancestorInfo = await statIfPresent(ancestor);
		if (ancestorInfo && sameIdentity(ancestorInfo, rootInfo)) return true;
		const parent = dirname(ancestor);
		if (parent === ancestor) return false;
		ancestor = parent;
	}
}
//#endregion
export { lastMatchKeeps as a, toPosix as c, DEFAULT_WRITABLE_PATHS as d, PREVIEW_PATH as f, isLiteralSegment as i, DEFAULT_READONLY_FILE_NAME as l, isValidReadonlyFileName as m, compileEntry as n, parsePatternLines as o, REQUEST_WRITABLE_PATH_TOOL as p, compileGitignore as r, stripTrailingSpaces as s, isPathUnder as t, DEFAULT_READ_ONLY_PATHS as u };

//# sourceMappingURL=containment-BZPfOinD.mjs.map
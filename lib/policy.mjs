import { a as DEFAULT_WRITABLE_PATHS, c as MAX_READONLY_ENTRIES_FIELD, d as PREVIEW_PATH, f as READONLY_FILE_FIELD, h as isValidReadonlyFileName, i as DEFAULT_READ_ONLY_PATHS, l as PATTERNS_FIELD, m as WRITABLE_FIELD, n as ALLOW_REQUESTS_FIELD, o as HARDEN_BROKER_FIELD, p as REQUEST_WRITABLE_PATH_TOOL, r as DEFAULT_READONLY_FILE_NAME, s as MAX_GRANTS_FIELD, t as isPathUnder, u as PLUGIN_ID } from "./containment-DSWpHb2F.mjs";
import z from "@deepseek-ai/schemastery";
import { canonicalPath, writableRoots } from "@deepseek-ai/dsh-sandbox";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
//#endregion
//#region src/path-expand.ts
/**
* 额外可写根的 `~` 与环境变量展开. 保护路径保持 gitignore 语义, 不走这里.
* 顺序对齐常见 shell: 先展开行首 `~` / `~/...` 为当前用户家目录, 再展开
* `$NAME` / `${NAME}`. `~user` 不支持. 未设置或空值的变量整行失败, 由调用
* 方告警跳过, 避免空串把路径拼成文件系统根.
*
* 平台差异: `\` 只在不把反斜杠当路径分隔符的平台 (POSIX) 上作转义符; Windows
* 上它是分隔符, 一律按字面保留 —— 否则 `C:\Users\me\caches` 会被吃成
* `C:Usermecaches`, 从盘符绝对路径变成落点取决于进程当前目录的盘符相对路径.
* Windows 上 `~\...` 与 `~/...` 同样展开为家目录.
* @module dsh-write-protect/path-expand
*/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const TILDE_ERROR = "only ~ and ~/... expand to the current user home (~\\... is accepted on Windows)";
/** 平台路径 API: Windows 用 win32 语义, 其余用 POSIX 语义. */
function pathApiOf(platform = process.platform) {
	return platform === "win32" ? win32 : posix;
}
/** 该平台是否把 `\` 当转义符 (Windows 上它是路径分隔符). */
function escapesWithBackslash(platform = process.platform) {
	return platform !== "win32";
}
/**
* 展开一行额外可写配置: 行首 `~`, 然后 `$NAME` / `${NAME}`.
* POSIX 上 `\` 转义下一字符 (`\$` 保留字面 `$`, `\~` 保留字面 `~`);
* Windows 上 `\` 是分隔符, 不做转义.
*/
function expandTildeAndEnv(line, options = {}) {
	const platform = options.platform ?? process.platform;
	const withTilde = expandLeadingTilde(line, pathApiOf(platform), options.home ?? homedir());
	if ("error" in withTilde) return withTilde;
	return expandEnvVars(withTilde.ok, escapesWithBackslash(platform));
}
/** 只认当前用户: 裸 `~` 与 `~/...` (Windows 上还有 `~\...`); `~user` 拒绝. */
function expandLeadingTilde(line, api, home) {
	if (!line.startsWith("~")) return { ok: line };
	if (home.length === 0) return { error: "current user home directory is empty" };
	if (line === "~") return { ok: home };
	const rest = line.slice(1);
	if (rest.startsWith("/") || api.sep === "\\" && rest.startsWith("\\")) return { ok: api.join(home, rest.slice(1)) };
	return { error: TILDE_ERROR };
}
/** 展开 `$NAME` 与 `${NAME}`; 名字必须是 POSIX 标识符. */
function expandEnvVars(input, backslashEscapes) {
	let out = "";
	let index = 0;
	while (index < input.length) {
		const ch = input[index];
		if (backslashEscapes && ch === "\\" && index + 1 < input.length) {
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
* 保护路径的**枚举展开**: 把 `gitignore.ts` 解析出的模式针对某个工作区根枚举成
* 具体存在的路径, 供进程沙箱 (bwrap `--ro-bind` / Seatbelt `subpath`) 与 fs 围栏
* 的前缀比较使用 —— 它们都得拿到真实路径.
*
* gitignore(5) 的模式语义与逐路径匹配都在 `gitignore.ts` (纯逻辑, 零运行时依赖),
* 本模块只负责把模式落到磁盘上: 多行文本, `#` 注释, 空行忽略, `\` 转义, 尾部 `/`
* 只匹配目录, 锚定判定, `!` 取反的 last-match-wins 顺序, 以及前缀围栏模型
* (无法在仍受保护的目录内部重新放行后代) 全部沿用那份实现.
*
* 展开语义: 锚定字面条目是单一显式路径, 不存在也保留 (fs 围栏与 Seatbelt
* 对不存在路径同样有效); 其余条目枚举展开时刻已存在的路径 (新建路径要等
* 下次重新展开才纳入). 执法扩展: `//` 前缀表示文件系统绝对路径
* (gitignore 没有这种形态, 部署配置需要); 以 `/**` 结尾的条目按前缀围栏
* 等价性保护其命名目录本身, 而不是枚举全部后代. 展开遍历用 lstat, 不走进
* 目录符号链接, 避免链到工作区外的大树 (如 `Applications -> /Applications`).
* @module dsh-write-protect/patterns
*/
/**
* 目录性检查: 用 lstat, 不跟随符号链接. 路径不存在时返回 null; 指向目录的
* 链接视为非目录, 展开时不走进去.
*/
function statIsDir(path) {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return null;
	}
}
/**
* 枚举一个条目在 `start` 下匹配的现有路径 (POSIX 形态词法路径). 按队列
* 广度优先展开: `**` 段按零或多层目录展开, 字面段直接拼接并以存在性剪枝,
* 其余段用 readdir 过滤 (非末段要求目录), 末段按 `dirOnly` 过滤.
* 已经会被保护的目录不再往里走 (里面的后代本来也写不了); 被取反放行的
* 目录还会继续找. 目录符号链接不进入.
*/
function collectGlobMatches(effective, matchers, dirOnly, start, compiledEntries, workspaceRoot) {
	const isKeptDir = (path) => lastMatchKeeps({
		path,
		isDir: true
	}, compiledEntries, workspaceRoot);
	const matches = [];
	const queue = [{
		current: start,
		index: 0
	}];
	let head = 0;
	while (head < queue.length) {
		const { current, index } = queue[head];
		head += 1;
		const segment = effective[index];
		const matcher = matchers[index];
		const last = index === effective.length - 1;
		if (matcher === null) {
			queue.push({
				current,
				index: index + 1
			});
			if (isKeptDir(current)) continue;
			let names;
			try {
				names = readdirSync(current);
			} catch {
				continue;
			}
			for (const name of names) {
				const child = `${current}/${name}`;
				if (statIsDir(child) !== true) continue;
				if (isKeptDir(child)) continue;
				queue.push({
					current: child,
					index
				});
			}
			continue;
		}
		if (isLiteralSegment(segment)) {
			const next = `${current}/${segment}`;
			if (!last) {
				if (statIsDir(next) === true && !isKeptDir(next)) queue.push({
					current: next,
					index: index + 1
				});
				continue;
			}
			const isDir = statIsDir(next);
			if (isDir === null || dirOnly && !isDir) continue;
			matches.push({
				path: next,
				isDir
			});
			continue;
		}
		if (isKeptDir(current)) continue;
		let names;
		try {
			names = readdirSync(current);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!matcher.test(name)) continue;
			const next = `${current}/${name}`;
			if (!last) {
				if (statIsDir(next) !== true) continue;
				if (isKeptDir(next)) continue;
				queue.push({
					current: next,
					index: index + 1
				});
				continue;
			}
			const isDir = statIsDir(next);
			if (isDir === null || dirOnly && !isDir) continue;
			matches.push({
				path: next,
				isDir
			});
		}
	}
	return matches;
}
/**
* 把配置文本针对一次调用的工作区根展开为 canonical 保护路径, 语义对齐
* gitignore(5): 锚定字面条目不存在也保留; 其余条目只收集展开时刻已存在的
* 路径 (之后新建的路径要等下次展开才纳入). 已经会被保护的目录不往里走;
* 命中工作区根本身的条目 (如 `.`, 裸 `**`) 会把根自己作为围栏起点列出来.
* @param text - gitignore 语义的配置文本.
* @param workspaceRoot - 本次调用的工作区根.
* @returns canonical 保护路径 (去重) 与告警列表.
*/
function expandReadOnlyPaths(text, workspaceRoot) {
	const warnings = [];
	const entries = parsePatternLines(text);
	const compiledEntries = entries.map((entry) => compileEntry(entry));
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
				isDir: statIsDir(path)
			});
			continue;
		}
		candidates.push(...collectGlobMatches(compiled.effective.slice(0, end), compiled.matchers.slice(0, end), entry.dirOnly || end < compiled.effective.length, start, compiledEntries, workspaceRoot));
	}
	const canonicalRoot = canonicalPath(workspaceRoot);
	if (lastMatchKeeps({
		path: canonicalRoot,
		isDir: true
	}, compiledEntries, workspaceRoot)) candidates.push({
		path: canonicalRoot,
		isDir: true
	});
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
/**
* 未转义的 glob 元字符: 额外可写根是字面路径, 命中则拒绝该行.
* `\` 只在把它当转义符的平台 (POSIX) 上跳过下一字符; Windows 上它是分隔符,
* 其后的 `*` / `?` / `[` 同样算元字符.
*/
function hasUnescapedGlobMeta(line, backslashEscapes) {
	for (let index = 0; index < line.length; index += 1) {
		if (backslashEscapes && line[index] === "\\") {
			index += 1;
			continue;
		}
		const ch = line[index];
		if (ch === "*" || ch === "?" || ch === "[") return true;
	}
	return false;
}
/** canonical 路径是否就是文件系统根 (POSIX `/` 或 Windows 盘符根). */
function isFilesystemRoot(path, api) {
	const canonical = canonicalPath(path);
	return canonical === api.parse(canonical).root;
}
/** 词法包含: extra 可写根若已落在工作区内则没有放宽效果. */
function isLexicallyUnderRoot(path, root, separator, caseSensitive) {
	const comparablePath = caseSensitive ? path : path.toLowerCase();
	const comparableRoot = caseSensitive ? root : root.toLowerCase();
	if (comparablePath === comparableRoot) return true;
	const prefix = comparableRoot.endsWith(separator) ? comparableRoot : comparableRoot + separator;
	return comparablePath.startsWith(prefix);
}
/** 盘符相对路径 (`C:foo`): Windows 上按"该盘当时的当前目录"解析, 落点不可预期. */
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;
/**
* 解析一行字面路径 (额外可写根与可写申请共用同一套规则): 展开 `~` / `~/...` 与
* `$NAME` / `${NAME}`, `//` 与宿主绝对路径按文件系统解析, 其余 (含 `..`) 相对
* 工作区根解析, 最后 canonical 化.
*
* 工作区内的条目也会给出绝对目标 (外加一条告警), 由调用方决定是当成"没有放宽效果"
* 忽略掉 (额外可写根), 还是当成受保护路径继续受理 (可写申请). 相对条目必须在这里
* 就按工作区根定死: canonical 化对相对且不存在的路径会原样返回相对形态, 拿它做
* 包含判定会一路判错.
* @param line - 一行字面路径 (允许前后空白).
* @param workspaceRoot - 相对条目与工作区判定的基准.
* @param options - 平台与家目录覆盖, 缺省按当前进程与当前用户.
* @returns 目标路径 (或 undefined), 告警, 以及是否落在工作区内.
*/
function resolveLiteralPath(line, workspaceRoot, options = {}) {
	const platform = options.platform ?? process.platform;
	const api = pathApiOf(platform);
	const backslashEscapes = escapesWithBackslash(platform);
	const caseSensitive = platform !== "win32";
	const reject = (warning) => ({
		warnings: [warning],
		insideWorkspace: false
	});
	const trimmed = stripTrailingSpaces(line);
	if (trimmed.length === 0 || trimmed.startsWith("#")) return {
		warnings: [],
		insideWorkspace: false
	};
	if (trimmed.startsWith("!")) return reject(`writable path "${trimmed}" uses ! negation; extra writable roots are a literal list`);
	const expanded = expandTildeAndEnv(trimmed, options);
	if ("error" in expanded) return reject(`writable path "${trimmed}" ${expanded.error}`);
	if (platform === "win32" && DRIVE_RELATIVE.test(expanded.ok)) return reject(`writable path "${trimmed}" is drive-relative and has no fixed target; write the drive root explicitly, e.g. "${expanded.ok.slice(0, 2)}\\${expanded.ok.slice(2)}"`);
	if (hasUnescapedGlobMeta(expanded.ok, backslashEscapes)) return reject(`writable path "${trimmed}" contains glob metacharacters; extra writable roots must be literal paths`);
	const resolved = expanded.ok.startsWith("//") ? api.resolve("/", expanded.ok.slice(2)) : api.isAbsolute(expanded.ok) ? api.resolve(expanded.ok) : api.resolve(workspaceRoot, expanded.ok);
	if (isFilesystemRoot(resolved, api)) return reject(`writable path "${trimmed}" resolves to the filesystem root and is rejected`);
	const canonical = canonicalPath(resolved);
	const insideWorkspace = isLexicallyUnderRoot(canonical, canonicalPath(workspaceRoot), api.sep, caseSensitive);
	return {
		path: canonical,
		warnings: insideWorkspace ? [`writable path "${trimmed}" is already inside the workspace and is ignored`] : [],
		insideWorkspace
	};
}
/**
* 把额外可写配置文本展开为 canonical 根. 与保护路径不同, 这里是字面路径
* 列表而不是 gitignore glob: 行首 `~` / `~/...` 展开为当前用户家目录,
* `$NAME` / `${NAME}` 展开为环境变量; `//` 或宿主绝对路径按文件系统解析,
* 其余相对当前工作区 (含 `..`). 工作区内的条目没有放宽效果, 文件系统根
* 拒绝; 不存在的路径仍保留词法形态 (fs / Seatbelt 可按前缀放行, bwrap /
* Landlock 在叠加时跳过). Windows 上盘符相对路径 (`C:caches`) 拒绝 —— 它的
* 落点取决于进程当前目录, 会静默给出调用方从未指定的可写根.
* @param text - 逐行一条字面路径的配置文本.
* @param workspaceRoot - 本次调用的工作区根.
* @param options - 平台与家目录覆盖, 缺省按当前进程与当前用户.
* @returns canonical 额外可写根 (去重) 与告警列表.
*/
function expandWritablePaths(text, workspaceRoot, options = {}) {
	const warnings = [];
	const paths = [];
	const seen = /* @__PURE__ */ new Set();
	for (const rawLine of text.split(/\r?\n/)) {
		const resolution = resolveLiteralPath(rawLine, workspaceRoot, options);
		warnings.push(...resolution.warnings);
		if (resolution.path === void 0 || resolution.insideWorkspace) continue;
		if (seen.has(resolution.path)) continue;
		seen.add(resolution.path);
		paths.push(resolution.path);
	}
	return {
		paths,
		warnings
	};
}
//#endregion
//#region src/readonly-file.ts
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
/** 规则文件缓存的有效时长: 同步读取放在判定路径上, 不能每次都碰磁盘. */
const FILE_TTL_MS = 1e3;
/** 关闭识别或还没读到时的空结果. */
const EMPTY_READ_ONLY_FILE = {
	present: false,
	path: "",
	text: "",
	entries: [],
	warnings: []
};
/**
* 同步读一次规则文件并校验.
* @param workspaceRoot - 工作区根, 条目相对它解析.
* @param fileName - 规则文件名 (调用方已按 `isValidReadonlyFileName` 校验).
* @param maxEntries - 条目数上限, 超出的条目丢弃并告警.
*/
function readReadOnlyFile(workspaceRoot, fileName, maxEntries) {
	const target = resolve(workspaceRoot, fileName);
	const warnings = [];
	const notRegular = {
		present: false,
		path: target,
		text: "",
		entries: [],
		warnings: [`read-only rules file "${target}" is not a regular file (symbolic links are refused); ignored`]
	};
	let fd;
	try {
		if (!lstatSync(target).isFile()) return notRegular;
		fd = openSync(target, "r");
	} catch (error) {
		const code = error.code;
		if (code === "ENOENT" || code === "ENOTDIR") return {
			present: false,
			path: target,
			text: "",
			entries: [],
			warnings
		};
		return {
			present: false,
			path: target,
			text: "",
			entries: [],
			warnings: [`read-only rules file "${target}" cannot be read (${code ?? String(error)}); ignored`]
		};
	}
	try {
		if (!fstatSync(fd).isFile()) return notRegular;
		return parseReadOnlyFile(readFileSync(fd, { encoding: "utf8" }), target, workspaceRoot, maxEntries, warnings);
	} catch (error) {
		return {
			present: false,
			path: target,
			text: "",
			entries: [],
			warnings: [`read-only rules file "${target}" cannot be read (${error instanceof Error ? error.message : String(error)}); ignored`]
		};
	} finally {
		try {
			closeSync(fd);
		} catch {}
	}
}
/**
* 解析规则文件正文: 逐行复用 gitignore 解析器, 逐条做绝对路径与越界校验.
* @param content - 文件正文.
* @param target - 规范化的文件路径 (告警定位用).
* @param workspaceRoot - 工作区根.
* @param maxEntries - 条目数上限.
* @param warnings - 追加告警的数组 (调用方持有).
*/
function parseReadOnlyFile(content, target, workspaceRoot, maxEntries, warnings) {
	const entries = [];
	let truncated = 0;
	for (const parsed of parsePatternLines(content)) {
		if (parsed.fsAbsolute) {
			warnings.push(`read-only rules file "${target}": ${JSON.stringify(parsed.source)} is a filesystem-absolute entry; only workspace-relative entries are accepted`);
			continue;
		}
		if (escapesWorkspace(parsed.segments)) {
			warnings.push(`read-only rules file "${target}": ${JSON.stringify(parsed.source)} escapes the workspace; ignored`);
			continue;
		}
		if (entries.length >= maxEntries) {
			truncated += 1;
			continue;
		}
		entries.push(formatEntry(parsed));
	}
	if (truncated > 0) warnings.push(`read-only rules file "${target}": ${String(truncated)} entries beyond the limit of ${String(maxEntries)} were ignored`);
	return {
		present: true,
		path: target,
		text: entries.join("\n"),
		entries,
		warnings
	};
}
/**
* 条目是否指向工作区之外: 只看 `..` 段 (纯词法), 因此通配条目不会被误判 ——
* 通配由匹配器与展开各自保证不越界, 而 `..` 会让模式落到工作区外的宿主路径上.
*/
function escapesWorkspace(segments) {
	return segments.some((segment) => segment === "..");
}
/**
* 把一条已解析的规则文件条目还原为配置行原文: `//` 绝对条目在解析阶段就被拒,
* 因此这里只需处理 `!` 前缀, 锚定 `/` 与尾部 `/`. 还原出来的文本交给
* `parsePatternLines` 会得到同一条条目, 因此逐条校验 / 过滤 / 拼接可以放心往返.
* 锚定条目统一写成前导 `/` 形态 —— 对含中间 `/` 的条目而言这与原文等价但更明确.
*/
function formatEntry(entry) {
	return `${entry.negated ? "!" : ""}${entry.anchored ? "/" : ""}${entry.segments.join("/")}${entry.dirOnly ? "/" : ""}`;
}
/**
* 按 (工作区根, 文件名) 缓存的规则文件读取器. 判定路径上是同步读取, 因此结果
* 带一个短 TTL: TTL 内复用缓存, 过期后由下一次读取刷新, 并发请求天然合并.
*/
var ReadOnlyFileCache = class {
	maxEntries;
	onWarning;
	entries = /* @__PURE__ */ new Map();
	warned = /* @__PURE__ */ new Set();
	/**
	* @param maxEntries - 条目数上限.
	* @param onWarning - 告警回调 (每条告警只回调一次, 跨刷新去重).
	*/
	constructor(maxEntries, onWarning = () => {}) {
		this.maxEntries = maxEntries;
		this.onWarning = onWarning;
	}
	/** 缓存里仍然新鲜的规则文件; 没读过、换了文件名或已过期时返回 undefined. */
	peek(workspaceRoot, fileName) {
		const entry = this.entries.get(workspaceRoot);
		if (entry === void 0 || entry.fileName !== fileName) return void 0;
		if (Date.now() - entry.at >= FILE_TTL_MS) return void 0;
		return entry.file;
	}
	/**
	* 取规则文件: 缓存新鲜就用缓存, 否则同步重读一次.
	* @param workspaceRoot - 工作区根.
	* @param fileName - 规则文件名.
	*/
	read(workspaceRoot, fileName) {
		const cached = this.peek(workspaceRoot, fileName);
		if (cached !== void 0) return cached;
		const file = readReadOnlyFile(workspaceRoot, fileName, this.maxEntries);
		this.entries.set(workspaceRoot, {
			at: Date.now(),
			fileName,
			file
		});
		this.report(file);
		return file;
	}
	/** 无条件重读一次 (设置页预览要看到刚写入磁盘的内容). */
	refresh(workspaceRoot, fileName) {
		this.entries.delete(workspaceRoot);
		return this.read(workspaceRoot, fileName);
	}
	/** 工作区根上的缓存作废. */
	forget(workspaceRoot) {
		this.entries.delete(workspaceRoot);
	}
	/** 告警按内容去重后转交回调, 避免每次刷新都重复刷屏. */
	report(file) {
		for (const warning of file.warnings) {
			if (this.warned.has(warning)) continue;
			this.warned.add(warning);
			this.onWarning(warning);
		}
	}
};
/** 把规则文件原文与设置页文本合并为生效的保护路径文本. */
function mergeReadOnlyText(settingsText, fileText) {
	if (fileText.trim().length === 0) return settingsText;
	if (settingsText.trim().length === 0) return fileText;
	return `${settingsText}\n${fileText}`;
}
//#endregion
//#region src/preview.ts
/**
* 展开保护路径与额外可写根, 供设置页人工核对生效/未生效条目.
* @param patterns - gitignore 语义的保护路径文本 (设置页草稿).
* @param writablePatterns - 字面路径的额外可写根文本 (设置页草稿).
* @param workspaceRoot - 本次展开使用的工作区根.
* @param file - 工作区只读规则文件的读取结果.
* @param grants - 本会话已批准的可写授权.
*/
function previewPaths(patterns, writablePatterns, workspaceRoot, file = EMPTY_READ_ONLY_FILE, grants = []) {
	const readOnly = expandReadOnlyPaths(mergeReadOnlyText(patterns, file.text), workspaceRoot);
	const writable = expandWritablePaths(writablePatterns, workspaceRoot);
	const readOnlyFile = {
		...file.present ? { path: file.path } : {},
		patterns: file.text,
		warnings: file.warnings
	};
	return {
		workspaceRoot,
		readOnly: readOnly.paths,
		writable: writable.paths,
		warnings: [...readOnly.warnings, ...writable.warnings],
		readOnlyFile,
		grants: grants.map((grant) => ({
			path: grant.path,
			kind: grant.kind
		}))
	};
}
//#endregion
//#region src/preview-route.ts
/**
* 设置页预览入口: 挂在 Connection 的 `/api` Fetch 路由上, 走官方鉴权,
* 避免裸 webServer 路由 401 空 body. POST 当前草稿, 不写 settings.
* 工作区根必须由请求体带进来 (当前会话 cwd), 没有根就直接报错.
*
* 预览还会读一次工作区只读规则文件 (按配置的文件名), 并列出本会话已批准的可写
* 授权: 前者是生效保护路径的一部分来源, 后者解释了为什么某条被保护的路径现在
* 写得进去. 没有 policy service 时 (单测或极简组合) 这两块按空处理.
* @module dsh-write-protect/preview-route
*/
const MAX_BODY_BYTES = 262144;
function decodeDraft(value) {
	if (typeof value !== "object" || value === null) throw new Error("preview body must be an object");
	const record = value;
	const patterns = record.patterns;
	const writablePatterns = record.writablePatterns;
	const workspaceRoot = record.workspaceRoot;
	if (patterns !== void 0 && typeof patterns !== "string") throw new Error("patterns must be a string");
	if (writablePatterns !== void 0 && typeof writablePatterns !== "string") throw new Error("writablePatterns must be a string");
	if (workspaceRoot !== void 0 && typeof workspaceRoot !== "string") throw new Error("workspaceRoot must be a string");
	const trimmedRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
	return {
		patterns: typeof patterns === "string" ? patterns : "",
		writablePatterns: typeof writablePatterns === "string" ? writablePatterns : "",
		...trimmedRoot.length > 0 ? { workspaceRoot: trimmedRoot } : {}
	};
}
function jsonError(status, message) {
	return Response.json({ error: message }, { status });
}
/** 与官方 sandbox-policy 同一套工作区根规范化: 先解 symlink, 再绝对化. */
function resolvePreviewRoot(path) {
	return resolve(canonicalPath(path));
}
/** 读一次规则文件 (走 policy 持有的缓存并按需重读); 没有 host 或关闭识别时为空. */
function readPreviewFile(host, workspaceRoot) {
	if (host === void 0) return EMPTY_READ_ONLY_FILE;
	const fileName = host.currentReadonlyFileName();
	if (fileName.length === 0) return EMPTY_READ_ONLY_FILE;
	return host.readOnlyFileReader().refresh(workspaceRoot, fileName);
}
/**
* 注册预览 Fetch 路由. 返回 disposer, 交给 ctx.effect.
*
* 请求体必须带当前会话的工作区根: 没有根就不展开, 也不回退部署根 (部署根是进程
* cwd, 可能是一棵极大的树, 在那里同步枚举会把 Host 事件循环堵住).
* @param connection - Host connection 服务.
* @param host - 可选的插件侧信息 (规则文件与授权列表); 缺省时这两块按空处理.
*/
function mountPreviewRoute(connection, host) {
	const dispose = connection.fetch.register({
		path: PREVIEW_PATH,
		methods: ["POST"],
		fetch: async (request) => {
			try {
				const text = await request.text();
				if (text.length > MAX_BODY_BYTES) return jsonError(400, "preview body too large");
				const draft = decodeDraft(JSON.parse(text));
				const requestedRoot = draft.workspaceRoot;
				if (requestedRoot === void 0) return jsonError(400, "preview needs the current session workspace root; open a session before previewing (no deployment-root fallback)");
				const workspaceRoot = resolvePreviewRoot(requestedRoot);
				const grants = host === void 0 ? [] : host.grantsView().recordsForWorkspace(workspaceRoot, (sessionId) => host.workspaceRootOfSession(sessionId));
				return Response.json({ ...previewPaths(draft.patterns, draft.writablePatterns, workspaceRoot, readPreviewFile(host, workspaceRoot), grants) });
			} catch (error) {
				return jsonError(400, error instanceof Error ? error.message : String(error));
			}
		}
	});
	return () => {
		dispose();
	};
}
//#endregion
//#region src/request-writable-path.ts
const EMPTY_RECORD = {
	extraRoots: [],
	overrides: [],
	grants: []
};
/**
* 会话级可写授权表. 键为会话 id; 会话结束后记录随 map 一起失效 (进程内存态).
*/
var GrantsService = class {
	maxGrants;
	onChange;
	records = /* @__PURE__ */ new Map();
	constructor(maxGrants, onChange) {
		this.maxGrants = maxGrants;
		this.onChange = onChange;
	}
	/** 某个会话的授权记录 (没有记录时返回空记录). */
	recordOf(sessionId) {
		return this.records.get(sessionId) ?? EMPTY_RECORD;
	}
	/**
	* 记录一条授权. 已存在同一路径时视为成功且不重复计数.
	* @param sessionId - 授权所属会话.
	* @param path - canonical 绝对路径.
	* @param kind - 工作区外的额外根 (`extra-root`) 或保护旁路 (`override`).
	*/
	grant(sessionId, path, kind) {
		const current = this.recordOf(sessionId);
		const existing = current.grants.find((grant) => grant.path === path);
		if (existing !== void 0) return {
			ok: true,
			record: current,
			kind: existing.kind
		};
		const limit = this.maxGrants();
		if (current.grants.length >= limit) return {
			ok: false,
			reason: `this session already holds the maximum of ${String(limit)} extra write grants; ask the user to raise the limit or write inside the workspace`
		};
		const record = {
			extraRoots: kind === "extra-root" ? [...current.extraRoots, path] : current.extraRoots,
			overrides: kind === "override" ? [...current.overrides, path] : current.overrides,
			grants: [...current.grants, {
				path,
				kind
			}]
		};
		this.records.set(sessionId, record);
		this.onChange();
		return {
			ok: true,
			record,
			kind
		};
	}
	/** 按工作区根查找已授权的会话记录 (设置页预览用: 请求体只带 cwd). */
	recordsForWorkspace(workspaceRoot, cwdOf) {
		const canonicalRoot = canonicalPath(workspaceRoot);
		const found = [];
		for (const [sessionId, record] of this.records) {
			if (canonicalPath(cwdOf(sessionId) ?? "") !== canonicalRoot) continue;
			found.push(...record.grants);
		}
		return found;
	}
};
function renderResult(result) {
	return [result.granted ? result.kind === "already-writable" ? `"${result.path}" is already writable in this session.` : `Write access to "${result.path}" was granted for this session (${result.kind}).` : `Write access to "${result.path}" was not granted.`, ...result.notes].join(" ");
}
/**
* 注册 `request_writable_path`. 只在组合里有 `ctx.tools` 时调用.
* @param ctx - Host 上下文 (会用到 `ctx.approval`).
* @param grants - 授权表.
* @param host - policy service 的最小接口.
*/
function registerRequestWritablePath(ctx, grants, host) {
	ctx.tools.register(defineTool({
		name: REQUEST_WRITABLE_PATH_TOOL,
		description: "Ask the user to grant write access to one path for this session, for work that will keep writing the same protected path or area (a directory of files to generate, a build output tree, a path outside the workspace that several writes depend on). A single file is written with the ordinary write/edit tools. The user decides in an approval prompt, and a granted path stays writable only until the session ends.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "The path that needs write access: absolute, //-prefixed, ~/..., or relative to the session workspace (.. allowed). No globs."
			},
			justification: {
				type: "string",
				required: true,
				description: "One sentence for the user explaining why this exact path needs write access."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					granted: {
						type: "boolean",
						required: true
					},
					kind: {
						type: "string",
						required: true,
						enum: [
							"already-writable",
							"extra-root",
							"override"
						]
					},
					scope: {
						type: "string",
						required: true,
						enum: ["session"]
					},
					notes: {
						type: "array",
						required: true,
						items: { type: "string" }
					}
				}
			},
			render: (args, value) => [{
				type: "text",
				text: renderResult(value)
			}]
		},
		async execute(args, exec) {
			return await handleRequest(ctx, grants, host, args.path, args.justification, exec);
		}
	}));
}
/**
* 一次申请的判定与执行. 单独导出是为了让测试不必经过工具注册表就能覆盖判定
* 分支 (参数校验在上面那条 schema 里).
* @param ctx - Host 上下文 (会用到 `ctx.approval`).
* @param grants - 授权表.
* @param host - policy service 的最小接口.
* @param rawPath - 模型给出的路径原文.
* @param justification - 模型给出的一句话理由.
* @param exec - 工具执行上下文 (取其中的 agent / callId / signal).
*/
async function handleRequest(ctx, grants, host, rawPath, justification, exec) {
	if (!host.allowRequests()) throw new Error("request_writable_path is disabled by this deployment (allowWritableRequests); treat denied writes as final");
	if (justification.trim().length === 0) throw new Error("justification must be a non-empty sentence");
	return await requestAccess(ctx, grants, host, rawPath, justification, exec);
}
/** 一次申请的完整判定流程: 解析 → 直通 → 硬保护 → 审批 → 记录. */
async function requestAccess(ctx, grants, host, rawPath, justification, exec) {
	const agent = exec.agent;
	const sessionId = agent?.session.id;
	if (sessionId === void 0) throw new Error("request_writable_path needs a session to attach the grant to");
	const sessionCwd = agent?.session.header?.cwd;
	const workspaceRoot = host.workspaceRootOfSession(sessionId, sessionCwd);
	if (workspaceRoot === void 0) throw new Error(`request_writable_path cannot judge write protection: session "${sessionId}" has no workspace root (its log has no cwd and no earlier policy resolution recorded one); do not retry this tool for this session`);
	const policy = host.resolve(sessionId, sessionCwd);
	const rulesFile = host.rulesFilePath(workspaceRoot);
	if (rulesFile !== void 0 && canonicalPath(rawPath) === rulesFile) throw new Error(`request_writable_path rejected: "${rawPath}" is the workspace write-protect rules file, which is read-only by design and cannot be granted`);
	const resolution = resolveLiteralPath(rawPath, workspaceRoot);
	const blocking = resolution.warnings.filter((warning) => !warning.includes("already inside the workspace"));
	if (blocking.length > 0) throw new Error(`request_writable_path rejected: ${blocking[0]}`);
	if (resolution.path === void 0) throw new Error(`request_writable_path rejected: "${rawPath}" has no target path; give an absolute path, or one relative to the session workspace`);
	const target = resolution.path;
	if (await isPathUnder(target, workspaceRoot)) {
		for (const root of [...policy.writablePaths ?? [], ...policy.writableOverrides ?? []]) if (await isPathUnder(target, root)) return {
			path: target,
			granted: true,
			kind: "already-writable",
			scope: "session",
			notes: [`already covered by the session grant on "${root}"; one grant covers everything under it, so do not ask again for this path.`]
		};
		const hit = await protectedBy(target, host.currentProtectedPaths(sessionId, sessionCwd));
		if (hit === void 0) return {
			path: target,
			granted: true,
			kind: "already-writable",
			scope: "session",
			notes: ["already writable in this session; no write-protect pattern matches it."]
		};
		return await askApproval(ctx, grants, policy, sessionId, target, "override", hit, justification, exec);
	}
	for (const root of [...writableRoots(policy), ...policy.writablePaths ?? []]) if (await isPathUnder(target, root)) return {
		path: target,
		granted: true,
		kind: "already-writable",
		scope: "session",
		notes: [`already inside the writable root "${root}"; one grant covers everything under it, so do not ask again for this path.`]
	};
	return await askApproval(ctx, grants, policy, sessionId, target, "extra-root", void 0, justification, exec);
}
/**
* 目标是否落在某一保护路径之下, 命中时返回命中的那条配置行 (未命中原样返回).
* 展开出来的保护路径与围栏消费的是同一份清单, 因此通配条目、目录标记与规则
* 文件的条目都算数.
*/
async function protectedBy(target, protectedPaths) {
	for (const path of protectedPaths) if (await isPathUnder(target, path)) return path;
}
/** 走一次审批弹窗, 同意后记录授权. */
async function askApproval(ctx, grants, policy, sessionId, target, kind, matchedPattern, justification, exec) {
	const approval = ctx.get("approval");
	const agent = exec.agent;
	if (approval === void 0) throw new Error(`write access to "${target}" requires user approval, but no approval service is composed in this deployment`);
	if (agent === void 0) throw new Error(`write access to "${target}" requires user approval, but the call has no agent to route it through`);
	if ((approval.overrideOf(agent.session) ?? approval.config.policy ?? "ask") === "never") throw new Error(`write access to "${target}" requires user approval, but approval prompts are disabled in this session`);
	const seeking = kind === "override" ? `grant write access to "${target}" for this session, overriding write protection on "${matchedPattern ?? ""}"` : `grant write access to "${target}" (outside the session workspace) for this session`;
	const outcome = await approval.request({
		agent,
		toolName: REQUEST_WRITABLE_PATH_TOOL,
		callId: exec.callId,
		reason: `${seeking}: ${justification}`,
		signal: exec.signal
	});
	if (outcome !== "allowed-once") throw new Error(describeDenial(outcome, target));
	const granted = grants.grant(sessionId, target, kind);
	if (!granted.ok) throw new Error(`write access to "${target}" could not be granted: ${granted.reason}`);
	const notes = kind === "override" ? [`write protection on "${matchedPattern ?? ""}" is bypassed for the write/edit tools and for sandboxed commands under "${target}".`, "the grant already covers every path beneath it, so do not ask again for a subdirectory or another file in there while it lasts."] : [
		`"${target}" joined the writable roots for this session, so sandboxed commands and the write/edit tools may write there.`,
		"the grant already covers every path beneath it, so do not ask again for a subdirectory or another file in there while it lasts.",
		"write-protect patterns still win inside it."
	];
	if (policy.mode === "read-only") notes.push("the session is in read-only mode right now, so this grant takes effect only after the mode is switched to workspace-write or danger-full-access.");
	return {
		path: target,
		granted: true,
		kind,
		scope: "session",
		notes
	};
}
/** 未获同意的三种结果各自的说明, 让模型能区分"用户拒绝"和"没有审批通道". */
function describeDenial(outcome, target) {
	switch (outcome) {
		case "rejected": return `the user rejected write access to "${target}"`;
		case "cancelled": return `the request for write access to "${target}" was cancelled`;
		case "unavailable": return `write access to "${target}" requires approval, but no approval channel is available`;
	}
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
		writablePaths: z.array(z.string()).default([...DEFAULT_WRITABLE_PATHS]),
		hardenBroker: z.boolean().default(true),
		readonlyFileName: z.string().default(DEFAULT_READONLY_FILE_NAME),
		maxReadOnlyEntries: z.number().default(200),
		maxGrants: z.number().default(8),
		allowWritableRequests: z.boolean().default(true)
	});
	baseEntries;
	writableBaseEntries;
	hardenBrokerBase;
	readonlyFileNameBase;
	maxReadOnlyEntriesBase;
	maxGrantsBase;
	allowRequestsBase;
	readOnlyFiles;
	grants;
	/**
	* 会话 id 到工作区根的记忆: 审批工具只拿得到 agent.session.id (agent 类型不
	* 暴露给本模块), 因此这里把每次解析过的会话工作区根记下来, 让它能按 id 解析
	* 同一份 policy; 设置页预览也用它把授权记录对上是哪个工作区. 进程内存态.
	*/
	sessionRoots = /* @__PURE__ */ new Map();
	settingsOwner;
	cache = {
		at: 0,
		key: "",
		readOnly: [],
		writable: [],
		overrides: [],
		readOnlyPatterns: "",
		readOnlyFilePatterns: "",
		file: EMPTY_READ_ONLY_FILE
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
		this.hardenBrokerBase = config.hardenBroker ?? true;
		this.readonlyFileNameBase = this.warnAboutFileName(config.readonlyFileName ?? ".readonly");
		this.maxReadOnlyEntriesBase = this.positiveLimit(config.maxReadOnlyEntries, 200, "maxReadOnlyEntries");
		this.maxGrantsBase = this.positiveLimit(config.maxGrants, 8, "maxGrants");
		this.allowRequestsBase = config.allowWritableRequests ?? true;
		this.readOnlyFiles = new ReadOnlyFileCache(this.maxReadOnlyEntriesBase, (message) => this.warn(message));
		this.grants = new GrantsService(() => this.currentLimits().maxGrants, () => this.invalidate());
		ctx.inject(["settings"], (scope) => {
			const owner = scope.settings.register(PLUGIN_ID, WriteProtectSettingsSchema, { base: {
				[PATTERNS_FIELD]: this.baseText(),
				[WRITABLE_FIELD]: this.writableBaseText(),
				[HARDEN_BROKER_FIELD]: this.hardenBrokerBase,
				[READONLY_FILE_FIELD]: this.readonlyFileNameBase,
				[MAX_READONLY_ENTRIES_FIELD]: this.maxReadOnlyEntriesBase,
				[MAX_GRANTS_FIELD]: this.maxGrantsBase,
				[ALLOW_REQUESTS_FIELD]: this.allowRequestsBase
			} });
			this.settingsOwner = owner;
			owner.watch(() => this.invalidate());
		});
		ctx.inject(["systemPrompt"], (scope) => {
			scope.systemPrompt.context({
				name: "sandbox:write-protect",
				order: 112,
				text: (context) => {
					const session = context.agent?.session;
					if (session === void 0) return "";
					const policy = this.resolve({ session });
					const patterns = this.currentReadOnlyText(policy.workspaceRoot).trim();
					const parts = [];
					if (patterns.length > 0) parts.push(`Write-protected patterns (gitignore semantics; in read-only and workspace-write mode every DSH-enforced operation denies writes beneath matching paths, reads stay allowed; danger-full-access is unrestricted): ${JSON.stringify(patterns)}.`);
					const source = this.currentReadonlyFileName();
					if (source.length > 0) parts.push(`The workspace read-only rules file "${source}" contributes to those patterns; it is read from the session workspace root and cannot be modified by any tool or command.`);
					const writable = policy.writablePaths ?? [];
					if (writable.length > 0) parts.push(`Additional writable roots under workspace-write (sandboxed commands and write/edit tools may write here; write-protected paths still win; does not apply in read-only): ${JSON.stringify(writable)}.`);
					const overrides = policy.writableOverrides ?? [];
					if (overrides.length > 0) parts.push(`Session write grants that bypass write protection for the write/edit tools and for sandboxed commands: ${JSON.stringify(overrides)}.`);
					if (this.currentLimits().allowWritableRequests) parts.push(`Extra write access is not granted by default. Call ${JSON.stringify(REQUEST_WRITABLE_PATH_TOOL)} when the task will keep writing the same protected path or area (a directory of files to generate, a build output tree, a path outside the workspace that several writes depend on); a single file is written with the ordinary write/edit tools, and if that write is denied, leave it at that. The user decides in an approval prompt, and the grant lasts only for this session.`);
					else parts.push("Extra write access is not granted by this deployment: do not ask for it.");
					return parts.join(" ");
				}
			});
		});
		ctx.inject(["tools"], (scope) => {
			registerRequestWritablePath(scope, this.grants, {
				workspaceRootOfSession: (sessionId, cwd) => this.workspaceRootOfSession(sessionId, cwd),
				resolve: (sessionId, cwd) => this.resolveForSession(sessionId ?? "", cwd),
				currentProtectedPaths: (sessionId, cwd) => this.resolveForSession(sessionId ?? "", cwd).readOnlyPaths ?? [],
				maxGrants: () => this.currentLimits().maxGrants,
				rulesFilePath: (workspaceRoot) => this.rulesFilePath(workspaceRoot),
				allowRequests: () => this.currentLimits().allowWritableRequests
			});
		});
		ctx.inject(["connection"], (scope) => {
			const connection = scope.connection;
			scope.effect(() => mountPreviewRoute(connection, this), "dsh-write-protect: preview route");
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
	/** 当前生效的 broker 加固开关: 用户拨动过设置页开关则以其为准, 否则走部署 base. */
	currentHardenBroker() {
		const value = this.settingsOwner?.get()?.[HARDEN_BROKER_FIELD];
		return typeof value === "boolean" ? value : this.hardenBrokerBase;
	}
	/** 当前生效的规则文件名 (空串即关闭识别). */
	currentReadonlyFileName() {
		return this.currentLimits().readonlyFileName;
	}
	/**
	* 当前工作区根的规则文件路径 (canonical), 文件名关闭时为 undefined.
	*
	* 这份文件是唯一"硬保护": 它自己改写规则, 因此既不能被任何写入旁路放行, 也不
	* 在可写申请的受理范围内. 要改它只能改设置页的文件名或由用户在编辑器里改.
	* @param workspaceRoot - 会话工作区根.
	*/
	rulesFilePath(workspaceRoot) {
		const name = this.currentLimits().readonlyFileName;
		if (name.length === 0) return void 0;
		return canonicalPath(resolve(workspaceRoot, name));
	}
	/** 某个工作区根的规则文件: 缓存新鲜就用缓存, 否则同步读一次. */
	readOnlyFileAt(workspaceRoot) {
		const name = this.currentLimits().readonlyFileName;
		if (name.length === 0) return EMPTY_READ_ONLY_FILE;
		return this.readOnlyFiles.read(workspaceRoot, name);
	}
	/** 规则文件名与其上限 (供设置页预览复用同一份配置). */
	limits() {
		return this.currentLimits();
	}
	/**
	* 会话 id 到工作区根的记忆 (只为设置页预览把授权记录对上是哪个工作区).
	* 每次 resolve() 顺手记录; 进程内存态, 不持久化.
	*/
	rememberSession(sessionId, workspaceRoot) {
		this.sessionRoots.set(sessionId, workspaceRoot);
	}
	/**
	* 会话的工作区根: 最近一次 resolve() 记下的那一份, 或调用方从会话日志带来的
	* cwd (`resolve` 成绝对路径, 同时记下). 两者都没有时返回 undefined.
	*
	* 这里刻意**不回退部署根**: 部署根是进程 cwd, 可能就是一棵极大的树 (从 home
	* 启动时的整个 home), 而保护路径展开是同步扫盘 —— 在那里枚举会把 Host 事件循环
	* 堵住几十秒, 表现成整个 dsh 无响应. 没有根就不展开, 由调用方决定怎么办.
	* @param sessionId - 目标会话 id.
	* @param cwd - 会话日志里的 cwd; 缺省表示调用方拿不到.
	* @returns 绝对工作区根, 或 undefined.
	*/
	workspaceRootOfSession(sessionId, cwd) {
		const remembered = this.sessionRoots.get(sessionId);
		if (remembered !== void 0) return remembered;
		if (cwd === void 0 || cwd.trim().length === 0) return void 0;
		const root = resolve(cwd);
		this.rememberSession(sessionId, root);
		return root;
	}
	/** 当前生效的规则文件条目上限, 会话授权上限与可写申请开关. */
	currentLimits() {
		const section = this.settingsOwner?.get();
		const fileName = section?.[READONLY_FILE_FIELD];
		const maxEntries = section?.[MAX_READONLY_ENTRIES_FIELD];
		const maxGrants = section?.[MAX_GRANTS_FIELD];
		const allowRequests = section?.[ALLOW_REQUESTS_FIELD];
		return {
			readonlyFileName: this.warnAboutFileName(typeof fileName === "string" ? fileName : this.readonlyFileNameBase),
			maxReadOnlyEntries: this.positiveLimit(typeof maxEntries === "number" ? maxEntries : this.maxReadOnlyEntriesBase, 200, "maxReadOnlyEntries"),
			maxGrants: this.positiveLimit(typeof maxGrants === "number" ? maxGrants : this.maxGrantsBase, 8, "maxGrants"),
			allowWritableRequests: typeof allowRequests === "boolean" ? allowRequests : this.allowRequestsBase
		};
	}
	/** 当前生效的保护路径原文: 设置页文本与规则文件原文合并. */
	currentReadOnlyText(workspaceRoot) {
		return mergeReadOnlyText(this.currentText(), this.readOnlyFileAt(workspaceRoot).text);
	}
	/** 校验并回退规则文件名, 非法值告警一次. */
	warnAboutFileName(value) {
		if (value.trim().length === 0) return "";
		if (isValidReadonlyFileName(value)) return value.trim();
		this.warn(`readonlyFileName ${JSON.stringify(value)} is not a plain file name (no path separators, not "." / "..", not git metadata); falling back to "${DEFAULT_READONLY_FILE_NAME}"`);
		return DEFAULT_READONLY_FILE_NAME;
	}
	/** 取正数上限, 非法值回退默认并告警一次. */
	positiveLimit(value, fallback, field) {
		if (value === void 0) return fallback;
		if (Number.isSafeInteger(value) && value > 0) return value;
		this.warn(`${field} must be a positive integer, got ${JSON.stringify(value)}; falling back to ${String(fallback)}`);
		return fallback;
	}
	/** 告警去重后写到日志. */
	warn(message) {
		if (this.warned.has(message)) return;
		this.warned.add(message);
		this.ctx.logger?.warn?.(`dsh-write-protect: ${message}`);
	}
	/** 设置 / 授权 / 规则文件变化后作废展开缓存. */
	invalidate() {
		this.cache = {
			...this.cache,
			at: 0,
			key: ""
		};
	}
	/**
	* 解析一次调用的完整生效文本: 设置页文本, 规则文件文本, 本会话授权, 以及
	* 合并后的可写文本; 按 key 做 TTL 缓存. 展开告警对每条只告警一次.
	*
	* `workspaceRoot` 为 undefined 表示没有已知的会话工作区根: 此时不读规则文件,
	* 也不做展开 (返回空的路径清单与设置页原文), 因为唯一现成的候选是部署根 (进程
	* cwd), 在那里枚举会同步堵住 Host 事件循环.
	* @param workspaceRoot - 会话工作区根, 未知时为 undefined.
	* @param sessionId - 调用所属会话, 缺省表示无会话调用.
	*/
	snapshot(workspaceRoot, sessionId) {
		const settingsText = this.currentText();
		const record = sessionId === void 0 ? {
			extraRoots: [],
			overrides: [],
			grants: []
		} : this.grants.recordOf(sessionId);
		if (workspaceRoot === void 0) {
			this.warn("no session workspace root is known, so write-protect patterns stay unexpanded (readOnlyPaths / writablePaths are empty) until a session with a cwd resolves the policy");
			return {
				readOnlyPatterns: settingsText,
				readOnlyFilePatterns: "",
				readOnly: [],
				writable: [],
				overrides: record.overrides,
				file: EMPTY_READ_ONLY_FILE
			};
		}
		const writableSettingsText = this.currentWritableText();
		const file = this.readOnlyFileAt(workspaceRoot);
		const readOnlyPatterns = mergeReadOnlyText(settingsText, file.text);
		const writableText = [...record.extraRoots, writableSettingsText].filter((line) => line.trim().length > 0).join("\n");
		const key = [
			settingsText,
			file.text,
			writableText,
			record.overrides.join("\n"),
			workspaceRoot
		].join("\0");
		const now = Date.now();
		if (now - this.cache.at < EXPAND_TTL_MS && this.cache.key === key) return {
			readOnlyPatterns: this.cache.readOnlyPatterns,
			readOnlyFilePatterns: this.cache.readOnlyFilePatterns,
			readOnly: this.cache.readOnly,
			writable: this.cache.writable,
			overrides: this.cache.overrides,
			file: this.cache.file
		};
		const readOnly = expandReadOnlyPaths(readOnlyPatterns, workspaceRoot);
		const writable = expandWritablePaths(writableText, workspaceRoot);
		for (const warning of [...readOnly.warnings, ...writable.warnings]) this.warn(warning);
		this.cache = {
			at: now,
			key,
			readOnly: readOnly.paths,
			writable: writable.paths,
			overrides: record.overrides,
			readOnlyPatterns,
			readOnlyFilePatterns: file.text,
			file
		};
		return {
			readOnlyPatterns,
			readOnlyFilePatterns: file.text,
			readOnly: readOnly.paths,
			writable: writable.paths,
			overrides: record.overrides,
			file
		};
	}
	/** 展开一次生效文本 (供设置页预览复用同一套解析; 不带任何会话授权). */
	snapshotForPreview(workspaceRoot) {
		return this.snapshot(workspaceRoot, void 0);
	}
	/** 规则文件读取器 (设置页预览直接读一次磁盘, 不依赖缓存). */
	readOnlyFileReader() {
		return this.readOnlyFiles;
	}
	/** 会话授权记录 (设置页预览列出当前生效的授权). */
	grantsView() {
		return this.grants;
	}
	/**
	* 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
	* 追加注入合并后的保护路径 (原文与展开形态), 规则文件原文, 额外可写根,
	* 本会话授权, 保护旁路与 broker 加固开关.
	*
	* 展开只在**确实知道会话工作区根**时进行 (会话日志里的 cwd); 会话没有 cwd 时
	* 不做回退: 官方 root 此时是部署根 (进程 cwd), 可能是一棵极大的树, 在那里枚举
	* 保护路径会同步堵住 Host 事件循环.
	* @param request - 可选的会话与已批准的模式覆盖.
	* @returns 带有 `readOnlyPatterns` / `readOnlyPaths` / `writablePaths` /
	* `writableOverrides` / `hardenBroker` 的完整逐次调用 policy.
	*/
	resolve(request = {}) {
		const policy = super.resolve(request);
		const sessionId = request.session?.id;
		const root = request.session?.header.cwd === void 0 ? void 0 : policy.workspaceRoot;
		const snapshot = this.snapshot(root, sessionId);
		policy.readOnlyPatterns = snapshot.readOnlyPatterns;
		policy.readOnlyPaths = snapshot.readOnly;
		policy.readOnlyFilePatterns = snapshot.readOnlyFilePatterns;
		policy.writablePaths = snapshot.writable;
		policy.writableOverrides = snapshot.overrides;
		policy.writableGrants = sessionId === void 0 ? [] : this.grants.recordOf(sessionId).grants.map((grant) => grant.path);
		policy.rulesFilePath = root === void 0 ? void 0 : this.rulesFilePath(root);
		policy.hardenBroker = this.currentHardenBroker();
		if (sessionId !== void 0 && root !== void 0) this.rememberSession(sessionId, root);
		return policy;
	}
	/**
	* 按会话 id 解析一次 policy: 给只拿得到会话 id 的消费方 (审批工具) 用. 工作区
	* 根取该会话最近一次解析出来的那一份, 没有就用调用方给的 cwd, 两者都没有时
	* 保护路径不展开 (readOnlyPaths / writablePaths 为空) —— 不回退部署根.
	*
	* 这里刻意不走本类覆写过的 `resolve()`: 那一支会先按"无会话"解析一次, 从而把
	* 保护路径展开到部署根 (进程 cwd) 上. 部署根很大时那是一次几十秒的同步扫盘,
	* Host 事件循环会被它堵死. 本方法只借 super 的 mode 与部署默认值, 保护范围随后
	* 全部按会话自己那份重算.
	* @param sessionId - 目标会话 id.
	* @param cwd - 会话日志里的 cwd, 供会话尚未被 resolve 过时定位工作区根.
	*/
	resolveForSession(sessionId, cwd) {
		const base = super.resolve({});
		const workspaceRoot = this.workspaceRootOfSession(sessionId, cwd);
		const snapshot = this.snapshot(workspaceRoot, sessionId);
		return {
			...base,
			workspaceRoot: workspaceRoot ?? base.workspaceRoot,
			sessionId,
			readOnlyPatterns: snapshot.readOnlyPatterns,
			readOnlyPaths: snapshot.readOnly,
			readOnlyFilePatterns: snapshot.readOnlyFilePatterns,
			writablePaths: snapshot.writable,
			writableOverrides: snapshot.overrides,
			writableGrants: this.grants.recordOf(sessionId).grants.map((grant) => grant.path),
			rulesFilePath: workspaceRoot === void 0 ? void 0 : this.rulesFilePath(workspaceRoot),
			hardenBroker: this.currentHardenBroker()
		};
	}
};
/** settings namespace 的 schema: 两份多行文本, 三项配置, 两个开关. */
const WriteProtectSettingsSchema = z.object({
	[PATTERNS_FIELD]: z.string(),
	[WRITABLE_FIELD]: z.string(),
	[HARDEN_BROKER_FIELD]: z.boolean(),
	[READONLY_FILE_FIELD]: z.string(),
	[MAX_READONLY_ENTRIES_FIELD]: z.number(),
	[MAX_GRANTS_FIELD]: z.number(),
	[ALLOW_REQUESTS_FIELD]: z.boolean()
});
//#endregion
export { WriteProtectPolicyService, WriteProtectPolicyService as default, name };

//# sourceMappingURL=policy.mjs.map
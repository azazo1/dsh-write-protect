import { a as parsePatternLines, i as lastMatchKeeps, o as stripTrailingSpaces, r as isLiteralSegment, s as toPosix, t as compileEntry } from "./gitignore-BAIQt9eU.mjs";
import z from "@deepseek-ai/schemastery";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { lstatSync, readdirSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";
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
/** settings namespace 的 macOS broker 加固开关字段名. */
const HARDEN_BROKER_FIELD = "hardenBroker";
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
* 完整 (非截断) 展开结果缓存的有效时长: 后台补齐的完整结果不必按
* `resolve()` 的短 TTL 反复重算; 部分结果仍走短 TTL 重新做有界同步遍历.
* 同时它也是后台补全的最小启动间隔 —— 超大工作区的补全不反复全量扫描,
* 避免持续占用事件循环.
*/
const EXPAND_FULL_TTL_MS = 6e4;
/** 设置页预览的 Host Fetch 路由, 走 `/api` 鉴权通道. POST JSON. */
const PREVIEW_PATH = "/api/dsh-write-protect.preview";
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
* 具体存在的路径, 供进程沙箱 (bwrap `--ro-bind` / Seatbelt `subpath`) 与提示词
* 使用 —— 它们必须拿到真实路径. write / edit 围栏不走这里, 而是直接按模式逐路径
* 判定 (`gitignore.ts` 的 `PatternSet.match`), 因此不受这里枚举预算的影响.
*
* 展开语义: 锚定字面条目是单一显式路径, 不存在也保留 (Seatbelt 对不存在路径同样
* 有效); 其余条目枚举展开时刻已存在的路径 (新建路径要等下次重新展开才纳入);
* 以 `/**` 结尾的条目按前缀围栏等价性保护其命名目录本身, 而不是枚举全部后代.
* 遍历用 lstat, 不走进目录符号链接, 避免链到工作区外的大树
* (如 `Applications -> /Applications`).
*
* 非锚定通配 (默认的 `.git`) 必须遍历工作区, 而 `policy.resolve()` 是同步契约:
* 同步展开有队列项与墙钟双重上限, 被截断的深层匹配由后台异步展开分片补齐,
* 两套驱动共用同一套遍历语义 (见 {@link walkGlobMatches}).
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
* 读取一个目录的条目 (含类型). readdir 已经带回条目类型, 绝大多数情况下不必
* 再逐项 lstat, 让同一份预算覆盖更多路径. 读取失败按空目录处理.
*/
function readDirents(path) {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch {
		return [];
	}
}
/**
* 条目是否为目录 (lstat 语义: 指向目录的符号链接不算). readdir 在个别文件
* 系统上返回未知类型, 此时回退到 lstat, 保证不因省 lstat 而漏掉目录.
*/
function direntIsDirectory(dirent, path) {
	if (dirent.isDirectory()) return true;
	if (dirent.isFile() || dirent.isSymbolicLink() || dirent.isFIFO() || dirent.isSocket() || dirent.isBlockDevice() || dirent.isCharacterDevice()) return false;
	return statIsDir(path) === true;
}
/**
* 枚举一个条目在 `start` 下匹配的现有路径 (POSIX 形态词法路径). 按队列
* 广度优先展开: `**` 段按零或多层目录展开, 字面段直接拼接并以存在性剪枝,
* 其余段用 readdir 过滤 (非末段要求目录), 末段按 `dirOnly` 过滤.
* 已经会被保护的目录不再往里走 (里面的后代本来也写不了); 被取反放行的
* 目录还会继续找. 目录符号链接不进入.
*
* 实现为生成器: 每处理一个队列项 yield 一次, 由同步 / 异步驱动决定步数上限与
* 是否在切片之间让出事件循环. 命中项经 `push` 交回调用方, 保证两个驱动共用
* 完全相同的遍历语义.
*/
function* walkGlobMatches(effective, matchers, dirOnly, start, compiledEntries, workspaceRoot, push) {
	const isKeptDir = (path) => lastMatchKeeps({
		path,
		isDir: true
	}, compiledEntries, workspaceRoot);
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
			if (!isKeptDir(current)) for (const dirent of readDirents(current)) {
				const child = `${current}/${dirent.name}`;
				if (!direntIsDirectory(dirent, child)) continue;
				if (isKeptDir(child)) continue;
				queue.push({
					current: child,
					index
				});
			}
		} else if (isLiteralSegment(segment)) {
			const next = `${current}/${segment}`;
			if (!last) {
				if (statIsDir(next) === true && !isKeptDir(next)) queue.push({
					current: next,
					index: index + 1
				});
			} else {
				const isDir = statIsDir(next);
				if (isDir !== null && (!dirOnly || isDir)) push({
					path: next,
					isDir
				});
			}
		} else if (!isKeptDir(current)) for (const dirent of readDirents(current)) {
			if (!matcher.test(dirent.name)) continue;
			const next = `${current}/${dirent.name}`;
			if (!last) {
				if (!direntIsDirectory(dirent, next)) continue;
				if (isKeptDir(next)) continue;
				queue.push({
					current: next,
					index: index + 1
				});
			} else {
				const isDir = statIsDir(next);
				if (isDir !== null && (!dirOnly || isDir)) push({
					path: next,
					isDir
				});
			}
		}
		yield;
	}
}
/** 同步驱动的最多看一项: 恰好跑完的遍历不该被误报为截断. */
function lookaheadDone(generator) {
	if (generator.next().done) return true;
	generator.return();
	return false;
}
/**
* 同步驱动: 最多处理 `budget.remaining` 个队列项, 且不超过墙钟截止时刻, 任一
* 到顶即停止. 停止前多看一项, 避免恰好跑完的遍历被误报为截断.
* @returns 是否完整跑完.
*/
function runWalkSync(generator, budget) {
	while (budget.remaining > 0 && Date.now() < budget.deadline) {
		if (generator.next().done) return true;
		budget.remaining -= 1;
	}
	return lookaheadDone(generator);
}
/**
* 异步驱动: 按 {@link AsyncWalkOptions} 分片跑完遍历, 每个切片之间让出事件
* 循环, 因此再大的工作区也不会长时间独占事件循环. 队列项预算 / 墙钟上限到顶,
* 或 `shouldStop` 返回 true (服务已释放或配置已变化) 时中止.
* @returns 是否完整跑完.
*/
async function runWalkAsync(generator, options) {
	let sinceYield = 0;
	let sliceEnd = Date.now() + options.sliceMs;
	while (true) {
		if (options.shouldStop?.() === true) {
			generator.return();
			return false;
		}
		if (options.budget.remaining <= 0 || Date.now() >= options.budget.deadline) return lookaheadDone(generator);
		if (generator.next().done) return true;
		options.budget.remaining -= 1;
		sinceYield += 1;
		if (sinceYield >= options.chunkEntries || Date.now() >= sliceEnd) {
			sinceYield = 0;
			sliceEnd = Date.now() + options.sliceMs;
			await new Promise((resolvePromise) => {
				setImmediate(resolvePromise);
			});
		}
	}
}
/** 把非取反条目编译为执行计划, 顺序与配置文本一致 (last-match-wins 依赖它). */
function planEntries(entries, compiledEntries, workspaceRoot) {
	const plans = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.negated) continue;
		const compiled = compiledEntries[index];
		const start = entry.fsAbsolute ? "/" : toPosix(workspaceRoot);
		let end = compiled.effective.length;
		while (end > 0 && compiled.effective[end - 1] === "**") end -= 1;
		if (end === 0) {
			plans.push({
				kind: "direct",
				candidate: {
					path: start,
					isDir: true
				}
			});
			continue;
		}
		if ((entry.anchored || entry.fsAbsolute) && compiled.effective.every((segment) => isLiteralSegment(segment))) {
			const path = resolve(entry.fsAbsolute ? "/" : workspaceRoot, entry.fsAbsolute ? `/${compiled.effective.join("/")}` : compiled.effective.join("/"));
			plans.push({
				kind: "direct",
				candidate: {
					path,
					isDir: statIsDir(path)
				}
			});
			continue;
		}
		const effective = compiled.effective.slice(0, end);
		const matchers = compiled.matchers.slice(0, end);
		const dirOnly = entry.dirOnly || end < compiled.effective.length;
		plans.push({
			kind: "walk",
			build: (push) => walkGlobMatches(effective, matchers, dirOnly, start, compiledEntries, workspaceRoot, push)
		});
	}
	return plans;
}
/** 候选去重 + canonical 化, 再按 last-match-wins 裁决去留. */
function finalizeExpansion(candidates, compiledEntries, workspaceRoot) {
	const paths = [];
	const seen = /* @__PURE__ */ new Set();
	for (const candidate of candidates) {
		if (!lastMatchKeeps(candidate, compiledEntries, workspaceRoot)) continue;
		const canonical = canonicalPath(candidate.path);
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		paths.push(canonical);
	}
	return paths;
}
/** 遍历 (同步或异步) 未跑完时的统一告警文本. */
function truncationWarning(workspaceRoot, budget) {
	return `wildcard expansion is incomplete under ${JSON.stringify(workspaceRoot)}: stopped at the ${String(budget)}-entry / time budget; the paths found so far still apply (breadth first, shallow first) and the deeper matches are filled in by the background pass — list deep matches as anchored entries (e.g. "/.git") to make them exact`;
}
/**
* 把配置文本针对一次调用的工作区根展开为 canonical 保护路径, 语义对齐
* gitignore(5): 锚定字面条目不存在也保留; 其余条目只收集展开时刻已存在的
* 路径 (之后新建的路径要等下次展开才纳入). 已经会被保护的目录不往里走.
*
* 非锚定通配条目 (默认的 `.git`) 需要遍历工作区, 而本函数是同步接口
* (`resolve()` 的契约): 队列项预算与墙钟上限任一先到即停止遍历并把
* `truncated` 置为 true, 已找到的路径照常返回 (广度优先, 浅层优先 —— 工作区
* 根上的匹配基本是头几项就命中), 避免大工作区把 Host 事件循环卡住 —— 那会让
* 整个 `dsh web` 无响应. 需要完整结果时用 {@link expandReadOnlyPathsAsync};
* 锚定字面条目恒为 O(1), 不受预算影响.
* @param text - gitignore 语义的配置文本.
* @param workspaceRoot - 本次调用的工作区根.
* @param budget - 本次同步遍历允许的队列项数, 缺省 {@link EXPAND_SYNC_BUDGET}.
* @param maxMillis - 本次同步遍历的墙钟上限, 缺省 {@link EXPAND_SYNC_MS}.
* @returns canonical 保护路径 (去重), 告警列表与是否被预算截断.
*/
function expandReadOnlyPaths(text, workspaceRoot, budget = 500, maxMillis = 50) {
	const warnings = [];
	const entries = parsePatternLines(text);
	const compiledEntries = entries.map((entry) => compileEntry(entry));
	const plans = planEntries(entries, compiledEntries, workspaceRoot);
	const candidates = [];
	const walkBudget = {
		remaining: Math.max(0, budget),
		deadline: Number.isFinite(maxMillis) ? Date.now() + Math.max(0, maxMillis) : Number.POSITIVE_INFINITY
	};
	let truncated = false;
	for (const plan of plans) {
		if (plan.kind === "direct") {
			candidates.push(plan.candidate);
			continue;
		}
		if (!runWalkSync(plan.build((candidate) => candidates.push(candidate)), walkBudget)) {
			truncated = true;
			if (walkBudget.remaining <= 0) continue;
		}
	}
	if (truncated) warnings.push(truncationWarning(workspaceRoot, budget));
	return {
		paths: finalizeExpansion(candidates, compiledEntries, workspaceRoot),
		warnings,
		truncated
	};
}
/**
* {@link expandReadOnlyPaths} 的异步完整版本: 同一套遍历语义, 但没有"同步接口"
* 的短预算 —— 每 `chunkEntries` 项或 `sliceMs` 毫秒让出一次事件循环, 因此超大
* 工作区也不会阻塞 Host; 仍保留 {EXPAND_ASYNC_BUDGET} 项 / {@link EXPAND_ASYNC_MS}
* 毫秒的上限, 家目录级的根到顶就停并告警, 不做无休止的后台扫描.
* 供设置页预览 (HTTP handler 可以 await) 与 policy 的后台补全使用.
* @param text - gitignore 语义的配置文本.
* @param workspaceRoot - 本次调用的工作区根.
* @param options - 切片大小, 预算与中止判据 (服务释放或配置变化时提前结束).
* @returns 完整展开结果; 预算到顶或 `shouldStop` 触发时 `truncated` 为 true.
*/
async function expandReadOnlyPathsAsync(text, workspaceRoot, options = {}) {
	const chunkEntries = Math.max(1, options.chunkEntries ?? 500);
	const sliceMs = Math.max(0, options.sliceMs ?? 15);
	const budget = Math.max(0, options.budget ?? 2e4);
	const maxMillis = options.maxMillis ?? 1e4;
	const entries = parsePatternLines(text);
	const compiledEntries = entries.map((entry) => compileEntry(entry));
	const plans = planEntries(entries, compiledEntries, workspaceRoot);
	const candidates = [];
	let truncated = false;
	let aborted = false;
	const walkBudget = {
		remaining: budget,
		deadline: Number.isFinite(maxMillis) ? Date.now() + Math.max(0, maxMillis) : Number.POSITIVE_INFINITY
	};
	for (const plan of plans) {
		if (options.shouldStop?.() === true) {
			truncated = true;
			aborted = true;
			break;
		}
		if (plan.kind === "direct") {
			candidates.push(plan.candidate);
			continue;
		}
		if (!await runWalkAsync(plan.build((candidate) => candidates.push(candidate)), {
			chunkEntries,
			sliceMs,
			budget: walkBudget,
			shouldStop: options.shouldStop
		})) {
			truncated = true;
			aborted = options.shouldStop?.() === true;
			break;
		}
	}
	const warnings = truncated && !aborted ? [truncationWarning(workspaceRoot, budget)] : [];
	return {
		paths: finalizeExpansion(candidates, compiledEntries, workspaceRoot),
		warnings,
		truncated
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
	const platform = options.platform ?? process.platform;
	const api = pathApiOf(platform);
	const backslashEscapes = escapesWithBackslash(platform);
	const caseSensitive = platform !== "win32";
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
		const expanded = expandTildeAndEnv(line, options);
		if ("error" in expanded) {
			warnings.push(`writable path "${line}" ${expanded.error}`);
			continue;
		}
		if (platform === "win32" && DRIVE_RELATIVE.test(expanded.ok)) {
			warnings.push(`writable path "${line}" is drive-relative and has no fixed target; write the drive root explicitly, e.g. "${expanded.ok.slice(0, 2)}\\${expanded.ok.slice(2)}"`);
			continue;
		}
		if (hasUnescapedGlobMeta(expanded.ok, backslashEscapes)) {
			warnings.push(`writable path "${line}" contains glob metacharacters; extra writable roots must be literal paths`);
			continue;
		}
		let resolved;
		if (expanded.ok.startsWith("//")) resolved = api.resolve("/", expanded.ok.slice(2));
		else if (api.isAbsolute(expanded.ok)) resolved = api.resolve(expanded.ok);
		else resolved = api.resolve(workspaceRoot, expanded.ok);
		if (isFilesystemRoot(resolved, api)) {
			warnings.push(`writable path "${line}" resolves to the filesystem root and is rejected`);
			continue;
		}
		const canonical = canonicalPath(resolved);
		if (isLexicallyUnderRoot(canonical, workspaceCanonical, api.sep, caseSensitive)) {
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
async function previewPaths(patterns, writablePatterns, workspaceRoot) {
	const readOnly = await expandReadOnlyPathsAsync(patterns, workspaceRoot);
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
/**
* 设置页预览入口: 挂在 Connection 的 `/api` Fetch 路由上, 走官方鉴权,
* 避免裸 webServer 路由 401 空 body. POST 当前草稿, 不写 settings.
* 工作区根优先用请求体里的当前会话 cwd, 缺省才用部署回退根.
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
/**
* 注册预览 Fetch 路由. 返回 disposer, 交给 ctx.effect.
* @param connection - Host connection 服务.
* @param fallbackRoot - 请求未带会话 cwd 时的部署回退根.
*/
function mountPreviewRoute(connection, fallbackRoot) {
	const dispose = connection.fetch.register({
		path: PREVIEW_PATH,
		methods: ["POST"],
		fetch: async (request) => {
			try {
				const text = await request.text();
				if (text.length > MAX_BODY_BYTES) return jsonError(400, "preview body too large");
				const draft = decodeDraft(JSON.parse(text));
				const requestedRoot = draft.workspaceRoot;
				const workspaceRoot = requestedRoot === void 0 ? fallbackRoot : resolvePreviewRoot(requestedRoot);
				return Response.json({
					...await previewPaths(draft.patterns, draft.writablePatterns, workspaceRoot),
					workspaceSource: requestedRoot === void 0 ? "fallback" : "session"
				});
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
//#region src/policy.ts
const name = "dsh-write-protect-policy";
/** 展开结果的缓存有效时长: resolve 每个 tool call 都会调用, glob 枚举有 IO 成本. */
const EXPAND_TTL_MS = 5e3;
/** 缓存条目按状态取 TTL: 部分结果短 TTL, 完整 / 已放弃补全的结果长 TTL. */
function ttlOf(status) {
	return status === "partial" ? EXPAND_TTL_MS : EXPAND_FULL_TTL_MS;
}
/**
* 同一份配置 / 工作区根两次展开结果的并集 (保序去重). 去留由同一条
* last-match-wins 谓词决定, 两次展开的差异只在"访问到哪些候选", 因此并集
* 不会把被取反剔除的路径重新纳入; 反过来它能保证"已经发现的深层匹配"不被
* 后续更差的同步部分结果覆盖掉.
*/
function mergePaths(previous, next) {
	if (previous === void 0 || previous.length === 0) return next;
	if (next.length === 0) return previous;
	const merged = [...previous];
	const seen = new Set(previous);
	for (const path of next) {
		if (seen.has(path)) continue;
		seen.add(path);
		merged.push(path);
	}
	return merged;
}
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
		hardenBroker: z.boolean().default(true)
	});
	baseEntries;
	writableBaseEntries;
	hardenBrokerBase;
	settingsOwner;
	/**
	* 每个 (两份文本, 工作区根) 的展开结果. 结果只增不减: 同步展开是被预算
	* 截断的浅层子集, 后台补全的完整结果按并集合并进来. 合并是安全的 ——
	* 去留由同一条 last-match-wins 谓词决定, 两次展开的差异只在"访问到哪些
	* 候选", 所以并集不会重新放行被取反剔除的路径; 反过来, 也不能用更差的
	* 同步部分结果覆盖已经拿到的完整结果, 否则保护范围会在两个值之间反复跳.
	*
	* `status` 决定重算节奏: `partial` 走短 TTL (同步遍历有界, 重算便宜, 能尽快
	* 纳入新建路径); `complete` 与 `exhausted` 走长 TTL —— 后者表示后台补全
	* 也到顶了, 对同一个根不再做无望的全量扫描.
	*/
	expanded = /* @__PURE__ */ new Map();
	/** 上一次后台补全结束的时间, 用于限制后台全量补全的启动频率. */
	fullExpandedAt = 0;
	/** 后台补全的在飞标记; 配置 / 工作区根变化时靠 generation 丢弃过期结果. */
	fullRefresh;
	/** 已判定"超出异步补全预算"的工作区根: 不再反复做无望的全量扫描. */
	exhaustedRoots = /* @__PURE__ */ new Set();
	generation = 0;
	disposed = false;
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
		ctx.effect(() => () => {
			this.disposed = true;
			this.generation += 1;
			this.fullRefresh = void 0;
		}, "dsh-write-protect: stop background expansion");
		ctx.inject(["settings"], (scope) => {
			const owner = scope.settings.register(PLUGIN_ID, WriteProtectSettingsSchema, { base: {
				[PATTERNS_FIELD]: this.baseText(),
				[WRITABLE_FIELD]: this.writableBaseText(),
				[HARDEN_BROKER_FIELD]: this.hardenBrokerBase
			} });
			this.settingsOwner = owner;
			owner.watch(() => {
				this.generation += 1;
				this.fullRefresh = void 0;
				this.exhaustedRoots.clear();
				this.expanded.clear();
			});
		});
		ctx.inject(["systemPrompt"], (scope) => {
			scope.systemPrompt.context({
				name: "sandbox:write-protect",
				order: 112,
				text: (context) => {
					const session = context.agent?.session;
					if (session === void 0) return "";
					const { readOnly, writable, patterns, truncated } = this.snapshot(this.resolve({ session }).workspaceRoot);
					const parts = [];
					if (!truncated && readOnly.length > 0) parts.push(`Write-protected paths (all DSH-enforced operations deny writes beneath them; reads stay allowed): ${JSON.stringify(readOnly)}.`);
					else if (truncated) {
						const sources = parsePatternLines(patterns).map((entry) => `${entry.negated ? "!" : ""}${entry.source}`);
						parts.push(`Write-protected patterns (gitignore semantics; the write/edit tools deny every matching path, reads stay allowed): ${JSON.stringify(sources)}. Sandboxed commands additionally pin these resolved locations: ${JSON.stringify(readOnly)} — incomplete, only the shallowest matches could be enumerated; deeper matches stay write-protected for the tools but are not pinned for commands, so use anchored entries such as "/.git" if commands must be blocked there too.`);
					}
					if (writable.length > 0) parts.push(`Additional writable roots under workspace-write (sandboxed commands and write/edit tools may write here; write-protected paths still win; does not apply in read-only): ${JSON.stringify(writable)}.`);
					return parts.join(" ");
				}
			});
		});
		ctx.inject(["connection"], (scope) => {
			const connection = scope.connection;
			scope.effect(() => mountPreviewRoute(connection, this.workspaceRoot), "dsh-write-protect: preview route");
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
	/** 逐条告警, 同一文本只出现一次. */
	warnAll(warnings) {
		for (const warning of warnings) {
			if (this.warned.has(warning)) continue;
			this.warned.add(warning);
			this.ctx.logger?.warn?.(`dsh-write-protect: ${warning}`);
		}
	}
	/**
	* 展开当前生效文本为 canonical 保护路径与额外可写根, 按
	* (两份文本, 工作区根) 缓存; 同时给出生效的保护路径**原文** (fs 围栏按它逐条
	* 匹配, 不依赖枚举) 与枚举是否被截断.
	*
	* 同步展开有队列项与墙钟双重上限 (`resolve()` 是同步契约, 不能阻塞 Host
	* 事件循环): 结果被截断时先返回已找到的浅层匹配并告警, 同时把该根交给
	* {@link expandInBackground} 在后台按分片补齐, 补齐结果与已有结果取并集.
	* 完整结果只覆盖不丢失: 更差的同步部分结果不会把已拿到的深层匹配置换掉.
	*/
	snapshot(workspaceRoot) {
		const readOnlyText = this.currentText();
		const writableText = this.currentWritableText();
		const key = `${readOnlyText}\u0000${writableText}\u0000${workspaceRoot}`;
		const now = Date.now();
		const previous = this.expanded.get(key);
		if (previous !== void 0 && now - previous.at < ttlOf(previous.status)) return {
			readOnly: previous.readOnly,
			writable: previous.writable,
			patterns: readOnlyText,
			truncated: previous.status !== "complete"
		};
		const readOnly = expandReadOnlyPaths(readOnlyText, workspaceRoot);
		const writable = expandWritablePaths(writableText, workspaceRoot);
		this.warnAll([...readOnly.warnings, ...writable.warnings]);
		const truncated = readOnly.truncated === true;
		const status = !truncated ? "complete" : previous === void 0 || previous.status === "partial" ? "partial" : previous.status;
		const next = {
			at: now,
			readOnly: mergePaths(previous?.readOnly, readOnly.paths),
			writable: writable.paths,
			status
		};
		this.expanded.set(key, next);
		if (truncated) this.expandInBackground(key, readOnlyText, workspaceRoot, writable.paths);
		return {
			readOnly: next.readOnly,
			writable: next.writable,
			patterns: readOnlyText,
			truncated: status !== "complete"
		};
	}
	/**
	* 后台把被同步预算截断的根补齐: 同一时刻只跑一个 (全量遍历很贵), 且启动
	* 间隔不小于 {@link EXPAND_FULL_TTL_MS}. 补全结果与既有结果取并集后写回;
	* 到顶仍不完整 (家目录级工作区) 则记为该根已放弃, 只保留告警给出的"改用
	* 锚定条目"建议. 结果经 generation 校验, 服务释放或配置变化时直接丢弃.
	*/
	expandInBackground(key, readOnlyText, workspaceRoot, writable) {
		if (this.disposed || this.fullRefresh !== void 0) return;
		if (this.exhaustedRoots.has(workspaceRoot)) return;
		if (Date.now() - this.fullExpandedAt < 6e4) return;
		const generation = this.generation;
		this.fullRefresh = {
			key,
			generation
		};
		expandReadOnlyPathsAsync(readOnlyText, workspaceRoot, { shouldStop: () => this.disposed || this.generation !== generation }).then((result) => {
			this.fullRefresh = void 0;
			this.fullExpandedAt = Date.now();
			if (this.disposed || this.generation !== generation) return;
			this.warnAll(result.warnings);
			if (result.truncated === true) this.exhaustedRoots.add(workspaceRoot);
			const previous = this.expanded.get(key);
			this.expanded.set(key, {
				at: Date.now(),
				readOnly: mergePaths(previous?.readOnly, result.paths),
				writable: previous?.writable ?? writable,
				status: result.truncated === true ? "exhausted" : "complete"
			});
		}, (error) => {
			this.fullRefresh = void 0;
			this.fullExpandedAt = Date.now();
			this.ctx.logger?.warn?.(`dsh-write-protect: background expansion failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}
	/**
	* 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
	* 追加注入保护路径 (枚举形态给进程沙箱, 原文给 write/edit 围栏), 额外可写根
	* 与 broker 加固开关.
	* @param request - 可选的会话与已批准的模式覆盖.
	* @returns 带有 `readOnlyPatterns` / `readOnlyPaths` / `writablePaths` /
	* `hardenBroker` 的完整逐次调用 policy.
	*/
	resolve(request = {}) {
		const policy = super.resolve(request);
		const { readOnly, writable, patterns } = this.snapshot(policy.workspaceRoot);
		policy.readOnlyPatterns = patterns;
		policy.readOnlyPaths = readOnly;
		policy.writablePaths = writable;
		policy.hardenBroker = this.currentHardenBroker();
		return policy;
	}
};
/** settings namespace 的 schema: 两份多行文本加 broker 加固开关. */
const WriteProtectSettingsSchema = z.object({
	[PATTERNS_FIELD]: z.string(),
	[WRITABLE_FIELD]: z.string(),
	[HARDEN_BROKER_FIELD]: z.boolean()
});
//#endregion
export { WriteProtectPolicyService, WriteProtectPolicyService as default, name };

//# sourceMappingURL=policy.mjs.map
import { a as parsePatternLines, i as lastMatchKeeps, o as stripTrailingSpaces, r as isLiteralSegment, s as toPosix, t as compileEntry } from "./gitignore-BAIQt9eU.mjs";
import z from "@deepseek-ai/schemastery";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { lstat, readdir } from "node:fs/promises";
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
* 目录性检查: 用 lstat, 不跟随符号链接. 路径不存在时返回 null; 指向目录的
* 链接视为非目录, 展开时不走进去.
*/
async function statIsDir(path) {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return null;
	}
}
/**
* 读取一个目录的条目 (含类型). readdir 已经带回条目类型, 绝大多数情况下不必
* 再逐项 lstat. 读取失败按空目录处理.
*/
async function readDirents(path) {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch {
		return [];
	}
}
/**
* 条目是否为目录 (lstat 语义: 指向目录的符号链接不算). readdir 在个别文件
* 系统上返回未知类型, 此时回退到 lstat, 保证不因省 lstat 而漏掉目录.
*/
async function direntIsDirectory(dirent, path) {
	if (dirent.isDirectory()) return true;
	if (dirent.isFile() || dirent.isSymbolicLink() || dirent.isFIFO() || dirent.isSocket() || dirent.isBlockDevice() || dirent.isCharacterDevice()) return false;
	return await statIsDir(path) === true;
}
/**
* 枚举一个条目在 `start` 下匹配的现有路径 (POSIX 形态词法路径). 按队列
* 广度优先展开: `**` 段按零或多层目录展开, 字面段直接拼接并以存在性剪枝,
* 其余段用 readdir 过滤 (非末段要求目录), 末段按 `dirOnly` 过滤.
* 已经会被保护的目录不再往里走 (里面的后代本来也写不了); 被取反放行的
* 目录还会继续找. 目录符号链接不进入.
*/
async function walkGlobMatches(effective, matchers, dirOnly, start, compiledEntries, workspaceRoot, push) {
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
			if (!isKeptDir(current)) for (const dirent of await readDirents(current)) {
				const child = `${current}/${dirent.name}`;
				if (!await direntIsDirectory(dirent, child)) continue;
				if (isKeptDir(child)) continue;
				queue.push({
					current: child,
					index
				});
			}
		} else if (isLiteralSegment(segment)) {
			const next = `${current}/${segment}`;
			if (!last) {
				if (await statIsDir(next) === true && !isKeptDir(next)) queue.push({
					current: next,
					index: index + 1
				});
			} else {
				const isDir = await statIsDir(next);
				if (isDir !== null && (!dirOnly || isDir)) push({
					path: next,
					isDir
				});
			}
		} else if (!isKeptDir(current)) for (const dirent of await readDirents(current)) {
			if (!matcher.test(dirent.name)) continue;
			const next = `${current}/${dirent.name}`;
			if (!last) {
				if (!await direntIsDirectory(dirent, next)) continue;
				if (isKeptDir(next)) continue;
				queue.push({
					current: next,
					index: index + 1
				});
			} else {
				const isDir = await statIsDir(next);
				if (isDir !== null && (!dirOnly || isDir)) push({
					path: next,
					isDir
				});
			}
		}
	}
}
/** 把非取反条目编译为执行计划, 顺序与配置文本一致 (last-match-wins 依赖它). */
async function planEntries(entries, compiledEntries, workspaceRoot) {
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
					isDir: await statIsDir(path)
				}
			});
			continue;
		}
		const effective = compiled.effective.slice(0, end);
		const matchers = compiled.matchers.slice(0, end);
		const dirOnly = entry.dirOnly || end < compiled.effective.length;
		plans.push({
			kind: "walk",
			run: (push) => walkGlobMatches(effective, matchers, dirOnly, start, compiledEntries, workspaceRoot, push)
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
/**
* 把配置文本针对一次调用的工作区根展开为 canonical 保护路径, 语义对齐
* gitignore(5): 锚定字面条目不存在也保留; 其余条目只收集展开时刻已存在的
* 路径 (之后新建的路径要等下次展开才纳入). 已经会被保护的目录不往里走.
* @param text - gitignore 语义的配置文本.
* @param workspaceRoot - 本次调用的工作区根.
* @returns canonical 保护路径 (去重) 与告警列表.
*/
async function expandReadOnlyPaths(text, workspaceRoot) {
	const warnings = [];
	const entries = parsePatternLines(text);
	const compiledEntries = entries.map((entry) => compileEntry(entry));
	const plans = await planEntries(entries, compiledEntries, workspaceRoot);
	const candidates = [];
	for (const plan of plans) {
		if (plan.kind === "direct") {
			candidates.push(plan.candidate);
			continue;
		}
		await plan.run((candidate) => candidates.push(candidate));
	}
	return {
		paths: finalizeExpansion(candidates, compiledEntries, workspaceRoot),
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
	const readOnly = await expandReadOnlyPaths(patterns, workspaceRoot);
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
/**
* 枚举结果的缓存有效时长. write / edit 不靠这份清单, 长一点能避免大工作区
* 上每次 bash 都重扫; 新建的匹配目录仍由模式围栏挡住, 只是进程沙箱要等下次
* materialize 才把路径编进 bind / profile.
*/
const EXPAND_TTL_MS = 6e4;
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
	cache = {
		at: 0,
		key: "",
		readOnly: [],
		writable: [],
		patterns: ""
	};
	warned = /* @__PURE__ */ new Set();
	inflight;
	generation = 0;
	constructor(ctx, config) {
		super(ctx, config);
		const entries = config.readOnlyPaths ?? [];
		const writableEntries = config.writablePaths ?? [];
		for (const entry of entries) if (entry.trim().length === 0) throw new Error("dsh-write-protect: readOnlyPaths entries must be non-empty strings");
		for (const entry of writableEntries) if (entry.trim().length === 0) throw new Error("dsh-write-protect: writablePaths entries must be non-empty strings");
		this.baseEntries = entries;
		this.writableBaseEntries = writableEntries;
		this.hardenBrokerBase = config.hardenBroker ?? true;
		ctx.inject(["settings"], (scope) => {
			const owner = scope.settings.register(PLUGIN_ID, WriteProtectSettingsSchema, { base: {
				[PATTERNS_FIELD]: this.baseText(),
				[WRITABLE_FIELD]: this.writableBaseText(),
				[HARDEN_BROKER_FIELD]: this.hardenBrokerBase
			} });
			this.settingsOwner = owner;
			owner.watch(() => {
				this.generation += 1;
				this.cache = {
					at: 0,
					key: "",
					readOnly: [],
					writable: [],
					patterns: ""
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
					const policy = this.resolve({ session });
					const patterns = this.currentText().trim();
					const parts = [];
					if (patterns.length > 0) parts.push(`Write-protected patterns (gitignore semantics; all DSH-enforced operations deny writes beneath matching paths; reads stay allowed): ${JSON.stringify(patterns)}.`);
					const writable = policy.writablePaths ?? [];
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
	/**
	* 异步展开当前生效文本. 同一 (两份文本, 工作区根) 的进行中请求会合到一次
	* 遍历上; 结果按 TTL 缓存. 展开告警对每条只告警一次.
	*/
	async materialize(workspaceRoot) {
		const readOnlyText = this.currentText();
		const writableText = this.currentWritableText();
		const key = `${readOnlyText}\u0000${writableText}\u0000${workspaceRoot}`;
		const cached = this.peek(key);
		if (cached !== void 0) return cached;
		if (this.inflight?.key === key) return this.inflight.promise;
		const generation = this.generation;
		const promise = this.expandNow(workspaceRoot, key, readOnlyText, writableText, generation);
		this.inflight = {
			key,
			promise
		};
		try {
			return await promise;
		} finally {
			if (this.inflight?.promise === promise) this.inflight = void 0;
		}
	}
	/** 缓存命中且未过期时返回快照, 否则 undefined. */
	peek(key) {
		if (Date.now() - this.cache.at >= EXPAND_TTL_MS || this.cache.key !== key) return void 0;
		return {
			readOnly: this.cache.readOnly,
			writable: this.cache.writable,
			patterns: this.cache.patterns
		};
	}
	async expandNow(workspaceRoot, key, readOnlyText, writableText, generation) {
		const readOnly = await expandReadOnlyPaths(readOnlyText, workspaceRoot);
		const writable = expandWritablePaths(writableText, workspaceRoot);
		for (const warning of [...readOnly.warnings, ...writable.warnings]) if (!this.warned.has(warning)) {
			this.warned.add(warning);
			this.ctx.logger?.warn?.(`dsh-write-protect: ${warning}`);
		}
		const snapshot = {
			readOnly: readOnly.paths,
			writable: writable.paths,
			patterns: readOnlyText
		};
		if (this.generation === generation) this.cache = {
			at: Date.now(),
			key,
			...snapshot
		};
		return snapshot;
	}
	/**
	* 解析一次调用的完整 policy: 官方的 mode/root/session 逻辑原样保留, 在结果上
	* 追加注入保护路径原文 (给 write/edit 围栏), 额外可写根, broker 加固开关,
	* 以及缓存里已有的枚举路径 (给进程沙箱). 同步契约不允许在这里等完整扫盘;
	* 冷缓存时 `readOnlyPaths` 为空, `confine()` 会 await {@link materialize}.
	* @param request - 可选的会话与已批准的模式覆盖.
	* @returns 带有 `readOnlyPatterns` / `readOnlyPaths` / `writablePaths` /
	* `hardenBroker` 的完整逐次调用 policy.
	*/
	resolve(request = {}) {
		const policy = super.resolve(request);
		const readOnlyText = this.currentText();
		const writableText = this.currentWritableText();
		const key = `${readOnlyText}\u0000${writableText}\u0000${policy.workspaceRoot}`;
		const cached = this.peek(key);
		policy.readOnlyPatterns = readOnlyText;
		policy.readOnlyPaths = cached?.readOnly ?? [];
		policy.writablePaths = cached?.writable ?? expandWritablePaths(writableText, policy.workspaceRoot).paths;
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
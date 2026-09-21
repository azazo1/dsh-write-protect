import { dirname, sep } from "node:path";
import { stat } from "node:fs/promises";
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
/** settings namespace 的工作区只读规则文件名 (单值, 空串即关闭识别). */
const READONLY_FILE_FIELD = "readonlyFileName";
/** settings namespace 的规则文件条目上限字段名. */
const MAX_READONLY_ENTRIES_FIELD = "maxReadOnlyEntries";
/** settings namespace 的单会话可写授权上限字段名. */
const MAX_GRANTS_FIELD = "maxGrants";
/** settings namespace 的"是否允许模型申请可写路径"开关字段名. */
const ALLOW_REQUESTS_FIELD = "allowWritableRequests";
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
export { DEFAULT_WRITABLE_PATHS as a, MAX_READONLY_ENTRIES_FIELD as c, PREVIEW_PATH as d, READONLY_FILE_FIELD as f, isValidReadonlyFileName as h, DEFAULT_READ_ONLY_PATHS as i, PATTERNS_FIELD as l, WRITABLE_FIELD as m, ALLOW_REQUESTS_FIELD as n, HARDEN_BROKER_FIELD as o, REQUEST_WRITABLE_PATH_TOOL as p, DEFAULT_READONLY_FILE_NAME as r, MAX_GRANTS_FIELD as s, isPathUnder as t, PLUGIN_ID as u };

//# sourceMappingURL=containment-DSWpHb2F.mjs.map
import { dirname, sep } from "node:path";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { FsError } from "@deepseek-ai/dsh-fs";
import { stat } from "node:fs/promises";
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
//#region src/fs.ts
/**
* 替换 base 的 `fs-sandbox` 行: 官方 `SandboxedFileSystem` 的模式围栏原样
* 保留, 只在两个变更入口 (writeText/editText) 之前追加保护路径检查. 读取
* 永远放行; `read-only` 模式官方已全量拒绝, 检查只会在 `workspace-write` 与
* `danger-full-access` 下生效 — 后者正是本插件的立足点: 进程沙箱整体放开时,
* 用户声明的保护路径对 write/edit 工具仍然拒绝写入.
* @module dsh-write-protect/fs
*/
const name = "dsh-write-protect-fs";
var WriteProtectFileSystem = class extends SandboxedFileSystem {
	/**
	* 先做保护路径检查, 再委托继承的围栏写入. 拒绝发生在官方 checkedTarget
	* 之前, 保护语义与模式围栏彼此独立.
	*/
	async writeText(target, content, expected, signal, sandboxPolicy) {
		await this.assertNotProtected(target, sandboxPolicy);
		return super.writeText(target, content, expected, signal, sandboxPolicy);
	}
	/** 先做保护路径检查, 再委托继承的围栏编辑. */
	async editText(target, edit, expected, signal, sandboxPolicy) {
		await this.assertNotProtected(target, sandboxPolicy);
		return super.editText(target, edit, expected, signal, sandboxPolicy);
	}
	/**
	* 目标落在保护路径之下时拒绝. 拒绝沿用官方围栏的 `FS_SANDBOX_DENIED` 码,
	* 工具层的拒绝标记与升级引导保持一致, message 中说明是本插件实施的拒绝.
	* 检查作用于重新 canonical 化的路径 (与官方围栏同一防御面): 指向保护目录
	* 内部的符号链接同样被拒, 指向外部的不受影响.
	*/
	async assertNotProtected(target, sandboxPolicy) {
		const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
		if (policy.mode === "read-only") return;
		const paths = policy.readOnlyPaths ?? [];
		if (paths.length === 0) return;
		const fresh = await this.resolve(target.displayPath);
		for (const root of paths) if (await isPathUnder(fresh.targetKey, root)) throw new FsError(`cannot write "${target.displayPath}": the path is write-protected by dsh-write-protect (beneath ${root})`, "FS_SANDBOX_DENIED");
	}
};
//#endregion
export { WriteProtectFileSystem, WriteProtectFileSystem as default, name };

//# sourceMappingURL=fs.mjs.map
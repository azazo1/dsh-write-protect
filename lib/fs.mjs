import { n as compileGitignore } from "./gitignore-BAIQt9eU.mjs";
import { dirname, sep } from "node:path";
import { writableRoots } from "@deepseek-ai/dsh-sandbox";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
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
* 替换 base 的 `fs-sandbox` 行: 官方模式围栏由本类接管 allow-list, 再叠加
* 保护路径拒绝. 读取永远放行; `read-only` 仍全量拒绝 (额外可写根不打穿);
* `workspace-write` 在官方 `writableRoots` 之外并入 `policy.writablePaths`;
* `danger-full-access` 进程沙箱整体放开时, 用户声明的保护路径对 write/edit
* 工具仍然拒绝写入.
*
* 保护判定走 `gitignore.ts` 的 `PatternSet.match`, 直接拿目标路径与模式匹配,
* **不依赖**进程沙箱那条路上枚举出来的路径清单: 深层嵌套、乃至尚未存在的
* `.git` 都能挡住, 而且每条写入只做几次正则, 没有遍历成本.
* @module dsh-write-protect/fs
*/
const name = "dsh-write-protect-fs";
var WriteProtectFileSystem = class extends SandboxedFileSystem {
	/** 按配置文本缓存的匹配器: 文本是唯一输入, 设置改动换文本即自动失效. */
	compiledPatterns;
	/**
	* 先做本插件的 allow-list 与保护路径检查, 再委托 LocalFileSystem 的原子
	* 写入. 不调用 SandboxedFileSystem.writeText: 官方 checkedTarget 看不见
	* `writablePaths`, 额外可写根会被误拒.
	*/
	async writeText(target, content, expected, signal, sandboxPolicy) {
		const gated = await this.gateMutation(target, sandboxPolicy);
		return LocalFileSystem.prototype.writeText.call(this, gated, content, expected, signal);
	}
	/** 先做本插件的 allow-list 与保护路径检查, 再委托 LocalFileSystem 的原子编辑. */
	async editText(target, edit, expected, signal, sandboxPolicy) {
		const gated = await this.gateMutation(target, sandboxPolicy);
		return LocalFileSystem.prototype.editText.call(this, gated, edit, expected, signal);
	}
	/**
	* 按官方模式语义围栏, 再拒绝保护路径. `read-only` 全拒; `workspace-write`
	* 要求目标落在 `writableRoots ∪ writablePaths` 之下; `danger-full-access`
	* 跳过 allow-list, 仍检查保护路径. 返回给底层写入的目标在 workspace-write
	* 下是重新 canonical 化的 fresh target, 与官方 checkedTarget 一致.
	*/
	async gateMutation(target, sandboxPolicy) {
		const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
		if (policy.mode === "read-only") throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, "FS_SANDBOX_DENIED");
		if (policy.mode === "danger-full-access") {
			await this.denyIfProtected(target.displayPath, (await this.resolve(target.displayPath)).targetKey, policy);
			return target;
		}
		const fresh = await this.resolve(target.displayPath);
		const roots = [...writableRoots(policy), ...policy.writablePaths ?? []];
		let contained = false;
		for (const root of roots) if (await isPathUnder(fresh.targetKey, root)) {
			contained = true;
			break;
		}
		if (!contained) throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, "FS_SANDBOX_DENIED");
		await this.denyIfProtected(target.displayPath, fresh.targetKey, policy);
		return fresh;
	}
	/**
	* 目标落在保护路径之下时拒绝. 保护文本随执行 policy 一起传入
	* (`readOnlyPatterns`), 按它逐条匹配目标路径: 命中的可以是目标自身, 也可以是
	* 它的某个祖先目录 —— 这正是"被保护的目录连同其后代一起挡"的前缀围栏语义.
	*
	* 目标是 write / edit 要写的文件 (`isDir` 恒为 false), 所以带尾部 `/` 的条目
	* 只会在祖先目录上命中, 与 gitignore 一致. 拒绝沿用官方围栏的
	* `FS_SANDBOX_DENIED` 码, 工具层的拒绝标记与升级引导保持一致, message 中说明
	* 是本插件实施的拒绝以及命中的是哪条模式.
	*/
	async denyIfProtected(displayPath, targetKey, policy) {
		const patterns = policy.readOnlyPatterns;
		if (typeof patterns === "string") {
			if (patterns.trim().length === 0) return;
			const hit = this.patternSetFor(patterns).match(targetKey, policy.workspaceRoot, false);
			if (hit !== void 0) throw new FsError(`cannot write "${displayPath}": the path is write-protected by dsh-write-protect (matches "${hit.entry.source}"; the fence is ${hit.path})`, "FS_SANDBOX_DENIED");
			return;
		}
		const paths = policy.readOnlyPaths ?? [];
		if (paths.length === 0) return;
		for (const root of paths) if (await isPathUnder(targetKey, root)) throw new FsError(`cannot write "${displayPath}": the path is write-protected by dsh-write-protect (beneath ${root})`, "FS_SANDBOX_DENIED");
	}
	/** 按文本取编译结果, 同一文本只编译一次. */
	patternSetFor(text) {
		if (this.compiledPatterns?.text === text) return this.compiledPatterns.set;
		const set = compileGitignore(text);
		this.compiledPatterns = {
			text,
			set
		};
		return set;
	}
};
//#endregion
export { WriteProtectFileSystem, WriteProtectFileSystem as default, name };

//# sourceMappingURL=fs.mjs.map
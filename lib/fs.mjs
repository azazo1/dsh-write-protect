import { l as REQUEST_WRITABLE_PATH_TOOL, t as isPathUnder } from "./containment-CwZXGzMh.mjs";
import { n as compileGitignore } from "./gitignore-BAIQt9eU.mjs";
import { writableRoots } from "@deepseek-ai/dsh-sandbox";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { FsError } from "@deepseek-ai/dsh-fs";
//#region src/fs.ts
/**
* 替换 base 的 `fs-sandbox` 行: 官方模式围栏由本类接管 allow-list, 再叠加
* 保护路径拒绝. 读取永远放行; `read-only` 仍全量拒绝 (额外可写根不打穿);
* `workspace-write` 在官方 `writableRoots` 之外并入 `policy.writablePaths`;
* `danger-full-access` 完全放行 —— 该模式是用户显式选定的"不设限", 保护路径与
* 规则文件判定都不再介入.
*
* 保护判定走 `gitignore.ts` 的 `PatternSet.match`, 直接拿目标路径与模式原文匹配,
* **不依赖**进程沙箱那条路上枚举出来的路径清单: 深层嵌套、乃至尚未存在的
* `.git` 都能挡住, 而且每条写入只做几次正则, 没有遍历成本.
*
* 两条优先级在匹配之前: 工作区只读规则文件自身是硬保护 (它自己就是规则来源, 任何
* 授权都不放行); 本会话经审批得到的保护旁路 (`policy.writableOverrides`) 则相反,
* 它让受保护子树里的目标直接通过.
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
	* 要求目标落在 `writableRoots ∪ writablePaths` 之下, 并检查保护路径;
	* `danger-full-access` 完全放行 (既跳过 allow-list, 也不应用保护路径与规则
	* 文件判定) —— 该模式是用户显式选择的"不设限", 沙箱本来就不介入. 返回给底层
	* 写入的目标在 workspace-write 下是重新 canonical 化的 fresh target, 与官方
	* checkedTarget 一致.
	*/
	async gateMutation(target, sandboxPolicy) {
		const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
		if (policy.mode === "read-only") throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, "FS_SANDBOX_DENIED");
		if (policy.mode === "danger-full-access") return target;
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
	* 目标落在保护路径之下时拒绝. 规则文件本身先挡 (硬保护), 再看本会话的保护
	* 旁路, 最后按生效的保护路径**原文**逐路径匹配目标: 命中的可以是目标自身, 也
	* 可以是它的某个祖先目录 —— 这正是"被保护的目录连同其后代一起挡"的前缀围栏
	* 语义, 而且不依赖任何扫盘结果.
	*
	* 执行 policy 没有带模式原文时 (不是本插件的 policy service 生成的) 退回按
	* 枚举出来的路径做前缀比较. 拒绝沿用官方围栏的 `FS_SANDBOX_DENIED` 码, 工具层
	* 的拒绝标记与升级引导保持一致, message 中说明是本插件实施的拒绝, 指出命中的
	* 是哪条模式, 并告诉模型可以申请本会话授权.
	*/
	async denyIfProtected(displayPath, targetKey, policy) {
		const rulesFile = policy.rulesFilePath;
		if (rulesFile !== void 0 && await isPathUnder(targetKey, rulesFile)) throw new FsError(`cannot write "${displayPath}": the workspace write-protect rules file is read-only by design; change the "readonlyFileName" setting or edit that file outside DSH`, "FS_SANDBOX_DENIED");
		for (const override of policy.writableOverrides ?? []) if (await isPathUnder(targetKey, override)) return;
		const patterns = policy.readOnlyPatterns;
		if (typeof patterns === "string") {
			if (patterns.trim().length === 0) return;
			const hit = this.patternSetFor(patterns).match(targetKey, policy.workspaceRoot, false);
			if (hit !== void 0) throw new FsError(`cannot write "${displayPath}": the path is write-protected by dsh-write-protect (matches "${hit.entry.source}"; the fence is ${hit.path}). Call ${REQUEST_WRITABLE_PATH_TOOL} once for that directory to ask the user for a session grant; one grant covers everything under it.`, "FS_SANDBOX_DENIED");
			return;
		}
		const paths = policy.readOnlyPaths ?? [];
		if (paths.length === 0) return;
		for (const root of paths) if (await isPathUnder(targetKey, root)) throw new FsError(`cannot write "${displayPath}": the path is write-protected by dsh-write-protect (beneath ${root}). Call ${REQUEST_WRITABLE_PATH_TOOL} once for that directory to ask the user for a session grant; one grant covers everything under it.`, "FS_SANDBOX_DENIED");
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
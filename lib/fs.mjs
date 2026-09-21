import { p as REQUEST_WRITABLE_PATH_TOOL, t as isPathUnder } from "./containment-DSWpHb2F.mjs";
import { writableRoots } from "@deepseek-ai/dsh-sandbox";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { SandboxedFileSystem } from "@deepseek-ai/dsh-fs-sandbox";
import { FsError } from "@deepseek-ai/dsh-fs";
//#region src/fs.ts
/**
* 替换 base 的 `fs-sandbox` 行: 官方模式围栏由本类接管 allow-list, 再叠加
* 保护路径拒绝. 读取永远放行; `read-only` 仍全量拒绝 (额外可写根不打穿);
* `workspace-write` 在官方 `writableRoots` 之外并入 `policy.writablePaths`;
* `danger-full-access` 进程沙箱整体放开时, 用户声明的保护路径对 write/edit
* 工具仍然拒绝写入.
*
* 判定用执行 policy 带来的展开清单 (`policy.readOnlyPaths`): 它是设置页文本与
* 工作区只读规则文件合并后的结果, 因此两者在这一侧地位相同. 本会话经审批得到的
* 保护旁路 (`policy.writableOverrides`) 在此之前短路放行; 工作区只读规则文件
* 自身则相反, 它自己就是规则来源, 任何授权都不放行.
* @module dsh-write-protect/fs
*/
const name = "dsh-write-protect-fs";
var WriteProtectFileSystem = class extends SandboxedFileSystem {
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
	* 目标落在保护路径之下时拒绝. 规则文件本身先挡 (硬保护), 再看本会话的保护
	* 旁路, 最后按展开出来的保护路径做前缀比较 —— 命中的可以是目标自身, 也可以是
	* 它的某个祖先目录, 这正是"被保护的目录连同其后代一起挡"的语义.
	*
	* 拒绝沿用官方围栏的 `FS_SANDBOX_DENIED` 码, 工具层的拒绝标记与升级引导保持
	* 一致, message 中说明是本插件实施的拒绝, 并指出可以申请本会话授权.
	*/
	async denyIfProtected(displayPath, targetKey, policy) {
		const rulesFile = policy.rulesFilePath;
		if (rulesFile !== void 0 && await isPathUnder(targetKey, rulesFile)) throw new FsError(`cannot write "${displayPath}": the workspace write-protect rules file is read-only by design; change the "readonlyFileName" setting or edit that file outside DSH`, "FS_SANDBOX_DENIED");
		for (const override of policy.writableOverrides ?? []) if (await isPathUnder(targetKey, override)) return;
		const paths = policy.readOnlyPaths ?? [];
		if (paths.length === 0) return;
		for (const root of paths) if (await isPathUnder(targetKey, root)) throw new FsError(`cannot write "${displayPath}": the path is write-protected by dsh-write-protect (beneath ${root}). Call ${REQUEST_WRITABLE_PATH_TOOL} to ask the user for a session grant for this path.`, "FS_SANDBOX_DENIED");
	}
};
//#endregion
export { WriteProtectFileSystem, WriteProtectFileSystem as default, name };

//# sourceMappingURL=fs.mjs.map
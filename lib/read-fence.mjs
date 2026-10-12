import { t as isPathUnder, u as REQUEST_WRITABLE_PATH_TOOL } from "./containment-OLhAfh28.mjs";
import { n as compileGitignore } from "./gitignore-BAIQt9eU.mjs";
import { canonicalPath } from "@deepseek-ai/dsh-sandbox";
import { resolve } from "node:path";
//#region src/read-fence.ts
/**
* 读拒绝围栏 (工具层): 在工具派发前按会话判定目标路径是否在读拒绝范围内, 命中
* 即拒绝; 并在搜索结果落地之后滤掉落在读拒绝范围内的条目.
*
* 为什么在工具层而不是 `ctx.fs` 层: 读接口 (`readText` / `streamText` / `listDir`
* 等) 的签名里既没有 policy 也没有会话, 拿不到当前会话的工作区根与会话授权.
* `tools/pre-execute` 的 `exec` 带 `agent.session`, 因此这一层既能按会话工作区根
* 判定模式, 也能认 `request_writable_path` 批准过的会话授权 (一条授权同时放开
* 该路径的读与写).
*
* 搜索工具 (`grep` / `glob`) 的 ripgrep 由 `ctx.subprocess` 直接拉起, 既不经过
* `ctx.fs`, 也不经过命令沙箱, 所以只有这一层挡得住它们. 它们默认搜索整个会话
* 工作区, 因此"请求的 scope 本身未命中"并不等于"结果里没有命中": 派发前只拦
* scope 本身落在读拒绝范围内的调用, 结果侧再逐条滤掉读拒绝路径下的命中.
*
* 与写保护一致: `danger-full-access` 下不介入; 没有 policy service 时不拦.
* @module dsh-write-protect/read-fence
*/
const name = "dsh-write-protect-read-fence";
/** 会读取文件内容的工具及其携带目标路径的参数名. */
const READ_TOOL_ARGS = {
	read: ["file_path"],
	read_image: ["file_path"],
	grep: ["path"],
	glob: ["path"],
	str_replace_editor: ["path"]
};
/** 结果里逐项带工作区相对路径的搜索工具: 工具名 -> 结果里的路径字段. */
const SEARCH_RESULT_FIELDS = {
	grep: "matches",
	glob: "paths"
};
/**
* 只有这些命令才算读取的工具 (其余命令是写, 由写围栏处理): 工具名 -> 读命令.
* `str_replace_editor` 的 `view` 是读文件内容, `create` / `str_replace` / `insert`
* 是写, 后者不该被读拒绝挡住.
*/
const READ_ONLY_COMMANDS = { str_replace_editor: ["view"] };
/** 一次判定需要的 policy 面 (与 `SandboxExecutionPolicy` 的插件扩展字段一致). */
function readDenyTextOf(policy) {
	const text = policy.readDenyPatterns;
	return typeof text === "string" ? text : "";
}
/** 这份 policy 上是否真的配了读拒绝 (原文或枚举清单任一非空). */
function hasReadDeny(policy) {
	return readDenyTextOf(policy).trim().length > 0 || (policy.readDenyPaths ?? []).length > 0;
}
/** 拒绝原因的构造: 说明命中的模式, 并引导模型走已有的授权通道. */
function denialReason(displayPath, pattern) {
	return `[sandbox: read denied by dsh-write-protect] cannot read "${displayPath}": the path is read-denied (matches "${pattern}"). Call ${REQUEST_WRITABLE_PATH_TOOL} once for that path to ask the user for a session grant; one grant covers reading and writing that path and everything under it.`;
}
/**
* 读拒绝围栏. 每个 `apply()` 建一个实例, 模式编译结果按文本缓存.
*/
var ReadFence = class {
	ctx;
	/** 按配置文本缓存的匹配器: 文本是唯一输入, 设置改动换文本即自动失效. */
	compiledPatterns;
	constructor(ctx) {
		this.ctx = ctx;
	}
	/**
	* 派发前判定: 工具读取的目标路径落在读拒绝范围内时拒绝. 先跑完其余监听器,
	* 让它们自己的拒绝 (例如别的策略插件) 优先.
	* @param exec - 本次工具调用.
	* @param next - 瀑布链的下一环.
	*/
	async preExecute(exec, next) {
		const decision = await next();
		if (decision.kind !== "allow") return decision;
		const policy = this.policyOf(exec);
		if (policy === void 0) return decision;
		const argumentsValue = exec.arguments;
		const commands = READ_ONLY_COMMANDS[exec.name];
		if (commands !== void 0 && !commands.includes(String(argumentsValue?.command ?? ""))) return decision;
		for (const name of READ_TOOL_ARGS[exec.name] ?? []) {
			const value = argumentsValue?.[name];
			if (typeof value !== "string" || value.trim().length === 0) continue;
			const target = this.targetOf(exec, policy, value);
			const hit = await this.deniedPattern(policy, target);
			if (hit !== void 0) return {
				kind: "deny",
				reason: denialReason(target, hit)
			};
		}
		return decision;
	}
	/**
	* 结果落地后过滤: 搜索类工具的结果里逐条滤掉读拒绝路径下的条目, 其余工具
	* 原样放行. 只在确实滤掉了条目时才改写决策.
	* @param exec - 本次工具调用.
	* @param result - 派发得到的原始结果.
	* @param next - 瀑布链的下一环.
	*/
	async postExecute(exec, result, next) {
		const decision = await next();
		if (result.isError) return decision;
		if (decision.kind === "accept" && decision.content !== void 0) return decision;
		const field = SEARCH_RESULT_FIELDS[exec.name];
		if (field === void 0) return decision;
		const policy = this.policyOf(exec);
		if (policy === void 0 || !hasReadDeny(policy)) return decision;
		const value = valueOf(decision, result);
		if (typeof value !== "object" || value === null) return decision;
		const record = value;
		const items = record[field];
		if (!Array.isArray(items)) return decision;
		const kept = [];
		for (const item of items) {
			const display = exec.name === "grep" && typeof item === "object" && item !== null ? item.path : item;
			if (typeof display !== "string") {
				kept.push(item);
				continue;
			}
			const target = this.targetOf(exec, policy, display);
			if (await this.deniedPattern(policy, target) === void 0) kept.push(item);
		}
		if (kept.length === items.length) return decision;
		const contexts = decision.additionalContexts;
		const extra = contexts === void 0 || contexts.length === 0 ? {} : { additionalContexts: contexts };
		if (kept.length === 0) return {
			kind: "block",
			feedback: [{
				type: "text",
				text: `[sandbox: read denied by dsh-write-protect] every hit of this ${exec.name} call is under a read-denied path; nothing is returned. Call ${REQUEST_WRITABLE_PATH_TOOL} once for that path to ask the user for a session grant, or search outside it.`
			}],
			...extra
		};
		return {
			kind: "accept",
			value: {
				...record,
				[field]: kept
			},
			...extra
		};
	}
	/** 目标是否被读拒绝, 命中时返回那条模式原文; 已批准的会话授权优先放行. */
	async deniedPattern(policy, target) {
		if (policy.mode === "danger-full-access") return void 0;
		if (!hasReadDeny(policy)) return void 0;
		const text = readDenyTextOf(policy);
		for (const grant of policy.sessionGrantPaths ?? []) if (await isPathUnder(target, grant)) return void 0;
		return this.patternSetFor(text).match(target, policy.workspaceRoot, null)?.entry.source;
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
	/**
	* 当前调用的 policy. 拿不到 policy service (极简组合 / 单测) 时返回 undefined,
	* 此时不拦任何读取.
	*/
	policyOf(exec) {
		const service = this.ctx.get("sandboxPolicy");
		if (service === void 0 || typeof service.resolve !== "function") return void 0;
		const session = exec.agent?.session;
		try {
			return service.resolve(session === void 0 ? {} : { session });
		} catch {
			return;
		}
	}
	/**
	* 把工具参数或结果里的路径解析成用于判定的绝对路径: 相对当前会话 cwd, 再解
	* 符号链接, 与 policy 的 `workspaceRoot` 同一套规范形态.
	*/
	targetOf(exec, policy, path) {
		const base = exec.agent?.session.header.cwd ?? policy.workspaceRoot;
		return canonicalPath(resolve(base, path));
	}
};
/** 后置过滤要看的 value: 下游已经换过 value 时以那份为准. */
function valueOf(decision, result) {
	if (decision.kind === "accept" && Object.hasOwn(decision, "value")) return decision.value;
	return result.value;
}
/**
* 注册读拒绝围栏. 组合里没有工具注册表时事件不会触发, 本插件不额外声明 inject.
* @param ctx - 插件上下文.
*/
function apply(ctx) {
	const fence = new ReadFence(ctx);
	ctx.on("tools/pre-execute", (exec, next) => fence.preExecute(exec, next));
	ctx.on("tools/post-execute", (exec, result, next) => fence.postExecute(exec, result, next));
}
//#endregion
export { READ_ONLY_COMMANDS, READ_TOOL_ARGS, ReadFence, SEARCH_RESULT_FIELDS, apply, apply as default, name };

//# sourceMappingURL=read-fence.mjs.map
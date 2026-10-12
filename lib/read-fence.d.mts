import { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import { Context } from "@deepseek-ai/cordis";
//#region src/read-fence.d.ts
export declare const name = "dsh-write-protect-read-fence";
/** 会读取文件内容的工具及其携带目标路径的参数名. */
export declare const READ_TOOL_ARGS: Readonly<Record<string, readonly string[]>>;
/** 结果里逐项带工作区相对路径的搜索工具: 工具名 -> 结果里的路径字段. */
export declare const SEARCH_RESULT_FIELDS: Readonly<Record<string, string>>;
/**
 * 只有这些命令才算读取的工具 (其余命令是写, 由写围栏处理): 工具名 -> 读命令.
 * `str_replace_editor` 的 `view` 是读文件内容, `create` / `str_replace` / `insert`
 * 是写, 后者不该被读拒绝挡住.
 */
export declare const READ_ONLY_COMMANDS: Readonly<Record<string, readonly string[]>>;
/** 每个会话解析一次 policy 的最小接口, 避免本模块直接依赖 policy service 类. */ export interface ReadFencePolicy {
  /** 解析一次调用的 policy (带上调用所属会话). */
  resolve(request: {
    session?: NonNullable<ToolExecution['agent']>['session'];
  }): SandboxExecutionPolicy;
}
/**
 * 读拒绝围栏. 每个 `apply()` 建一个实例, 模式编译结果按文本缓存.
 */
export declare class ReadFence {
  private readonly ctx;
  /** 按配置文本缓存的匹配器: 文本是唯一输入, 设置改动换文本即自动失效. */
  private compiledPatterns;
  constructor(ctx: Context);
  /**
   * 派发前判定: 工具读取的目标路径落在读拒绝范围内时拒绝. 先跑完其余监听器,
   * 让它们自己的拒绝 (例如别的策略插件) 优先.
   * @param exec - 本次工具调用.
   * @param next - 瀑布链的下一环.
   */
  preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
  /**
   * 结果落地后过滤: 搜索类工具的结果里逐条滤掉读拒绝路径下的条目, 其余工具
   * 原样放行. 只在确实滤掉了条目时才改写决策.
   * @param exec - 本次工具调用.
   * @param result - 派发得到的原始结果.
   * @param next - 瀑布链的下一环.
   */
  postExecute(exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>;
  /** 目标是否被读拒绝, 命中时返回那条模式原文; 已批准的会话授权优先放行. */
  private deniedPattern;
  /** 按文本取编译结果, 同一文本只编译一次. */
  private patternSetFor;
  /**
   * 当前调用的 policy. 拿不到 policy service (极简组合 / 单测) 时返回 undefined,
   * 此时不拦任何读取.
   */
  private policyOf;
  /**
   * 把工具参数或结果里的路径解析成用于判定的绝对路径: 相对当前会话 cwd, 再解
   * 符号链接, 与 policy 的 `workspaceRoot` 同一套规范形态.
   */
  private targetOf;
}
/**
 * 注册读拒绝围栏. 组合里没有工具注册表时事件不会触发, 本插件不额外声明 inject.
 * @param ctx - 插件上下文.
 */
export declare function apply(ctx: Context): void;
//#endregion
export { apply as default };
//# sourceMappingURL=read-fence.d.mts.map
/**
 * 共享契约: 纯常量与类型合并, Host 与 Client 两端共用. 不允许引入任何
 * 运行时依赖 (Client bundle 的纯度要求双端共享的值必须是浏览器安全的字面量).
 * @module dsh-write-protect/constants
 */

/** 插件标识: settings namespace, client 注册 id 与 package name 三者一致. */
export const PLUGIN_ID = 'dsh-write-protect'

/** settings namespace 的 patterns 字段名 (gitignore 风格的多行文本). */
export const PATTERNS_FIELD = 'patterns'

/** 未做任何用户编辑时的默认保护配置文本. */
export const DEFAULT_PATTERN_TEXT = '**/.git'

/** patch 配置的 `readOnlyPaths` 数组默认值 (与 {@link DEFAULT_PATTERN_TEXT} 等价). */
export const DEFAULT_READ_ONLY_PATHS: readonly string[] = ['**/.git']

/**
 * systemPrompt 中写保护提示的位置: 紧跟官方 sandbox-policy context (110),
 * 位于 approval context (115) 之前.
 */
export const PROMPT_CONTEXT_ORDER = 112

/** 单次 glob 展开的遍历节点预算, 防止 `**` 模式在超大目录树上失控. */
export const EXPAND_NODE_BUDGET = 5000

/**
 * 为逐次调用的沙箱 policy 追加解析后的保护路径. 官方 policy 类型不做改动,
 * 这个接口合并让每个消费方都能直接读 `policy.readOnlyPaths`, 无需再引入
 * 插件私有的 service.
 */
declare module '@deepseek-ai/dsh-sandbox' {
  interface SandboxExecutionPolicy {
    readOnlyPaths?: readonly string[]
  }
}

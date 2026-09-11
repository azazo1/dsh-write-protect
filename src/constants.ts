/**
 * 共享契约: 纯常量与类型合并, Host 与 Client 两端共用. 不允许引入任何
 * 运行时依赖 (Client bundle 的纯度要求双端共享的值必须是浏览器安全的字面量).
 * @module dsh-write-protect/constants
 */

/** 插件标识: settings namespace, client 注册 id 与 package name 三者一致. */
export const PLUGIN_ID = 'dsh-write-protect'

/** settings namespace 的 patterns 字段名 (gitignore 风格的多行文本). */
export const PATTERNS_FIELD = 'patterns'

/** settings namespace 的额外可写根字段名 (字面路径的多行文本). */
export const WRITABLE_FIELD = 'writablePatterns'

/** settings namespace 的 macOS broker 加固开关字段名. */
export const HARDEN_BROKER_FIELD = 'hardenBroker'

/**
 * macOS broker 逃逸加固的默认值: 开启. 官方 profile 的 `(allow default)`
 * 让沙箱内一条 `open x.app` 就能经 launchd 在沙箱外执行, 属于应当默认堵上的
 * 漏洞, 因此默认收紧; 只在确实需要从沙箱内驱动宿主 GUI 时才在设置页关掉.
 */
export const DEFAULT_HARDEN_BROKER = true

/**
 * 保护路径的唯一默认来源: patch 配置 `readOnlyPaths` 的 schema 默认值与
 * 设置页展示的部署 base 都由它推导. 修改默认保护范围只需改这一处.
 * gitignore 语义下 `.git` 在任意层级匹配, 覆盖工作区根与嵌套仓库; 通配
 * 只收集展开时刻已存在的路径, 需要无条件保护时用锚定条目 (如 `/.git`).
 */
export const DEFAULT_READ_ONLY_PATHS: readonly string[] = ['.git']

/**
 * 额外可写根的默认来源: 空列表. 只在 `workspace-write` 下把工作区外的
 * 字面路径并进 allow-list, 默认不放宽任何位置.
 */
export const DEFAULT_WRITABLE_PATHS: readonly string[] = []

/**
 * systemPrompt 中写保护提示的位置: 紧跟官方 sandbox-policy context (110),
 * 位于 approval context (115) 之前.
 */
export const PROMPT_CONTEXT_ORDER = 112

/** 设置页预览的 Host Fetch 路由, 走 `/api` 鉴权通道. POST JSON. */
export const PREVIEW_PATH = '/api/dsh-write-protect.preview'

/** 设置页预览请求/响应: 展开后的生效路径与未生效原因. */
export interface PathPreview {
  workspaceRoot: string
  /**
   * 工作区根来源. `session` 是当前选中会话的 cwd, `fallback` 是部署回退根
   * (通常是 `dsh web` 的启动路径). 缺省按 fallback 展示.
   */
  workspaceSource?: 'session' | 'fallback'
  readOnly: readonly string[]
  writable: readonly string[]
  warnings: readonly string[]
}

/**
 * 为逐次调用的沙箱 policy 追加解析后的保护路径, 额外可写根与 broker 加固开关.
 * 官方 policy 类型不做改动, 这个接口合并让每个消费方都能直接读
 * `policy.readOnlyPaths` / `policy.writablePaths` / `policy.hardenBroker`,
 * 无需再引入插件私有的 service.
 */
declare module '@deepseek-ai/dsh-sandbox' {
  interface SandboxExecutionPolicy {
    readOnlyPaths?: readonly string[]
    writablePaths?: readonly string[]
    /**
     * macOS Seatbelt 是否追加 broker 逃逸拒绝形式. 缺省视为开启; 只有设置页
     * 或部署配置显式关掉时才为 false, 此时命令按官方 profile 运行.
     */
    hardenBroker?: boolean
  }
}

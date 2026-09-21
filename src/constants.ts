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

/** settings namespace 的工作区只读规则文件名 (单值, 空串即关闭识别). */
export const READONLY_FILE_FIELD = 'readonlyFileName'

/** settings namespace 的规则文件条目上限字段名. */
export const MAX_READONLY_ENTRIES_FIELD = 'maxReadOnlyEntries'

/** settings namespace 的单会话可写授权上限字段名. */
export const MAX_GRANTS_FIELD = 'maxGrants'

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
 * 工作区只读规则文件的默认文件名 (工作区根下的单份文件). 内容与设置页的
 * 保护路径同语义 (gitignore), 运行期合并进生效文本; 置空即关闭该识别.
 */
export const DEFAULT_READONLY_FILE_NAME = '.readonly'

/**
 * 规则文件条目数上限: 超出只取前若干条并告警, 避免一份异常大的文件把每次
 * 写入判定的编译与匹配成本推高.
 */
export const DEFAULT_MAX_READONLY_ENTRIES = 200

/**
 * 单会话可写授权条数上限: 模型每申请一条都要用户点一次同意, 这里只是防止
 * 会话内无限累积.
 */
export const DEFAULT_MAX_GRANTS = 8

/**
 * 规则文件名的禁用值: 这些名字本身是配置或版本库元数据, 允许模型申请可写
 * 授权后改写它们等于让规则来源可被写入方自己改写.
 */
const FORBIDDEN_READONLY_FILE_NAMES: readonly string[] = ['.git', '.gitignore', '.gitattributes']

/** 模型工具名: 申请工作区外可写根或放开某条保护路径的本会话授权. */
export const REQUEST_WRITABLE_PATH_TOOL = 'request_writable_path'

/**
 * 校验只读规则文件名: 必须是工作区根下的单个文件名, 不含路径分隔符, 不是
 * `.` / `..`, 也不是会被写保护法规本身依赖的元数据名.
 * @param value - 设置页或 patch 给出的候选名 (前后空格忽略).
 * @returns 合法返回原名, 非法返回 undefined (调用方回退默认值并告警).
 */
export function isValidReadonlyFileName(value: string): boolean {
  const name = value.trim()
  if (name.length === 0) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name === '.' || name === '..') return false
  return !FORBIDDEN_READONLY_FILE_NAMES.includes(name)
}

/**
 * systemPrompt 中写保护提示的位置: 紧跟官方 sandbox-policy context (110),
 * 位于 approval context (115) 之前.
 */
export const PROMPT_CONTEXT_ORDER = 112

/** 设置页预览的 Host Fetch 路由, 走 `/api` 鉴权通道. POST JSON. */
export const PREVIEW_PATH = '/api/dsh-write-protect.preview'

/** 一次可写授权的性质. */
export type GrantKind = 'extra-root' | 'override'

/** 预览里的规则文件信息: 路径缺省表示该工作区没有这份文件. */
export interface ReadOnlyFilePreview {
  readonly path?: string
  readonly patterns: string
  readonly warnings: readonly string[]
}

/** 预览里的一条本会话授权. */
export interface GrantPreview {
  readonly path: string
  readonly kind: GrantKind
}

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
  /** 工作区只读规则文件 (部署配置决定是否识别, 关闭时为关闭说明). */
  readOnlyFile?: ReadOnlyFilePreview
  /** 本会话已批准的可写授权; 只读展开, 不能在本页撤销. */
  grants?: readonly GrantPreview[]
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
     * 生效的保护路径配置**原文** (gitignore 语义, 设置页文本与工作区规则文件
     * 合并之后). 供提示词与日志陈述"当前挡的是哪些模式", 判定仍走
     * `readOnlyPaths` 的展开清单.
     */
    readOnlyPatterns?: string
    /**
     * 当前生效的工作区规则文件原文 (没有该文件或关闭识别时为空串). 引擎里其他
     * 消费方可以用它把"规则文件也算一份来源"这件事讲清楚.
     */
    readOnlyFilePatterns?: string
    /**
     * 本会话经审批得到的可写授权 (工作区外的额外根 + 工作区内的保护旁路,
     * 只是审计与展示用的一份复制; 判定分别走 `writablePaths` 与
     * `writableOverrides`).
     */
    writableGrants?: readonly string[]
    /**
     * 本会话经审批得到的保护旁路路径: 落在这些根之下的目标跳过保护路径判定.
     * 只由 write / edit 围栏消费; 命令侧的沙箱挂载 / profile 在命令执行前
     * 就已经定好, 运行期撤不掉, 因此不因它收窄.
     */
    writableOverrides?: readonly string[]
    /**
     * 当前工作区根上那份只读规则文件的 canonical 路径 (文件名关闭时为
     * undefined). 这是唯一不接受放行的路径: 它自己就是规则来源, 任何写入
     * (包括本会话已批准的保护旁路) 都不能改它.
     */
    rulesFilePath?: string
    /**
     * macOS Seatbelt 是否追加 broker 逃逸拒绝形式. 缺省视为开启; 只有设置页
     * 或部署配置显式关掉时才为 false, 此时命令按官方 profile 运行.
     */
    hardenBroker?: boolean
  }
}

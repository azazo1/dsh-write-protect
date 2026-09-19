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

/**
 * 同步展开的队列项预算. 保护路径展开是同步的 (`resolve()` 的契约), 非锚定
 * 通配条目 (默认的 `.git`) 必须遍历工作区才能找到任意层级的匹配; 不设上限时,
 * 一个把家目录当工作区的部署会让这一次同步遍历阻塞 Host 事件循环几十秒到
 * 几分钟 —— 表现就是整个 `dsh web` 卡死 (`resolve()` 在 systemPrompt 组装、
 * bash / 终端 spawn、fs 写围栏与设置页预览上都会走到).
 *
 * 实测: `.git` 在 `/home/vagrant/workspace` 上走满 5000 项要 1.5s 以上, 走完
 * 十万项仍未结束; 500 项约 50-150ms. 预算是硬上限, 先到者生效: 同步结果被
 * 截断时已收集的路径立即生效 (广度优先, 浅层优先 —— 工作区根上的 `.git` 是
 * 头两项就命中的), 其余匹配由后台异步展开补齐. 锚定字面条目恒为 O(1),
 * 不受预算影响.
 */
export const EXPAND_SYNC_BUDGET = 500

/**
 * 同步展开的墙钟上限 (毫秒): 与 {@link EXPAND_SYNC_BUDGET} 同时生效, 任一
 * 先到即停止遍历. 单独限项数挡不住"目录很大"的情况 (一个 readdirSync 可能就
 * 要上百毫秒), 限时才是"同步遍历不阻塞事件循环"的硬保证. 超出时结果同样被
 * 截断, 已有路径照常生效.
 */
export const EXPAND_SYNC_MS = 50

/**
 * 后台异步补全展开的队列项预算: 同步被截断的根在后台按
 * {@link EXPAND_ASYNC_CHUNK} / {@link EXPAND_ASYNC_SLICE_MS} 分片遍历.
 * 超大工作区 (家目录级) 走到底要几分钟, 因此也给异步补全设上限: 到顶就放弃
 * 该根并告警 (告警里给出改写成锚定条目的建议), 不做无休止的后台扫描.
 */
export const EXPAND_ASYNC_BUDGET = 20_000

/** 后台异步补全展开的墙钟上限 (毫秒): 慢盘上项数不是可靠的代价代理. */
export const EXPAND_ASYNC_MS = 10_000

/** 异步补全展开每个事件循环切片最多检查的队列项数 (与时间片同时生效). */
export const EXPAND_ASYNC_CHUNK = 500

/** 异步补全展开相邻两次让出事件循环的最大间隔 (毫秒). */
export const EXPAND_ASYNC_SLICE_MS = 15

/**
 * 完整 (非截断) 展开结果缓存的有效时长: 后台补齐的完整结果不必按
 * `resolve()` 的短 TTL 反复重算; 部分结果仍走短 TTL 重新做有界同步遍历.
 * 同时它也是后台补全的最小启动间隔 —— 超大工作区的补全不反复全量扫描,
 * 避免持续占用事件循环.
 */
export const EXPAND_FULL_TTL_MS = 60_000

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
 * 为逐次调用的沙箱 policy 追加保护路径 (枚举形态与原文) 额外可写根与 broker
 * 加固开关. 官方 policy 类型不做改动, 这个接口合并让每个消费方都能直接读
 * `policy.readOnlyPatterns` / `policy.readOnlyPaths` / `policy.writablePaths` /
 * `policy.hardenBroker`, 无需再引入插件私有的 service.
 */
declare module '@deepseek-ai/dsh-sandbox' {
  interface SandboxExecutionPolicy {
    /**
     * 枚举展开后的保护路径. 进程沙箱 (bwrap `--ro-bind` / Seatbelt `subpath`)
     * 必须拿到具体路径, 只能消费这一份; 它可能被展开预算截断.
     */
    readOnlyPaths?: readonly string[]
    /**
     * 生效的保护路径配置**原文** (gitignore 语义). write / edit 围栏直接按它
     * 逐路径匹配, 因此不受枚举预算影响: 深层嵌套、尚未存在、枚举没覆盖到的匹配
     * 一样挡得住. 缺省表示这份 policy 不是本插件的 policy service 生成的, 消费方
     * 应退回按 `readOnlyPaths` 做前缀比较.
     */
    readOnlyPatterns?: string
    writablePaths?: readonly string[]
    /**
     * macOS Seatbelt 是否追加 broker 逃逸拒绝形式. 缺省视为开启; 只有设置页
     * 或部署配置显式关掉时才为 false, 此时命令按官方 profile 运行.
     */
    hardenBroker?: boolean
  }
}

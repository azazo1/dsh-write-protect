/**
 * macOS Seatbelt (sandbox-exec) profile 的拼接工具与 broker 逃逸加固形式.
 *
 * 官方 profile 的形状是
 * `(version 1) (allow default) (deny file-write*) (allow file-write* ...)`,
 * 即 `mach-lookup` 与 `process-exec` 全开. 而被 launchd 代理启动的进程不继承
 * Seatbelt profile, 于是一条 `open x.app` 就能让沙箱内的命令在沙箱外执行,
 * 任意写文件 —— `deny file-write*` 因此可被完全绕开. 本模块追加一组拒绝形式
 * 堵住已知的 broker 通道; 规则是 last-match-wins, 必须追加在 profile 末尾才能
 * 盖过 `(allow default)`.
 *
 * 这是纵深加固而非完备隔离: 它关掉的是 launchd / LaunchServices 这条代理通道,
 * 沙箱内的进程仍可通过其他本地守护进程 (Docker socket, ssh-agent 一类) 让沙箱外
 * 的服务代劳. 根本修复是上游把 profile 反转成 deny-by-default.
 * @module dsh-write-protect/seatbelt
 */

import { parsePatternLines, type PatternEntry } from './gitignore.ts'

/** 把一个路径引用为 SBPL 字符串字面量 (与官方 profiles 的转义规则一致). */
export function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/** 正则元字符转义: 字面条目里的 `.` 一类字符必须按字面匹配. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 条目能否直接翻译成正则: 含通配或转义的段留给枚举清单. */
function isPlainLiteral(entry: PatternEntry): boolean {
  return entry.segments.length > 0
    && entry.segments.every(segment => !/[\\*?[\]]/.test(segment))
}

/**
 * 一条字面条目对应的路径正则: 条目本体与它下面的全部后代都覆盖
 * (Seatbelt 的 regex 过滤器不自动包含后代, 必须写进正则).
 * 绝对条目 (`//` 前缀) 从文件系统根起算, 锚定条目从工作区根起算,
 * 其余条目允许出现在工作区根之下的任意层级.
 */
function regexForEntry(entry: PatternEntry, workspaceRoot: string): string {
  const literal = entry.segments.map(escapeRegex).join('/')
  if (entry.fsAbsolute) return `^/${literal}(/.*)?$`
  const root = escapeRegex(workspaceRoot.replace(/\/+$/, ''))
  if (entry.anchored) return `^${root}/${literal}(/.*)?$`
  return `^${root}(/.*)?/${literal}(/.*)?$`
}

/**
 * 按保护路径**原文**生成 Seatbelt 正则拒绝形式.
 *
 * 枚举清单只能覆盖展开当时已经存在的路径, 因此像 `.git` 这种"会话中途才出现"
 * 的受保护路径会漏掉 (展开结果还带缓存窗口). 字面条目不必扫盘就能翻译成正则,
 * 于是它们在 macOS 上持续生效, 与该路径当前是否存在、展开缓存新旧都无关.
 *
 * 只处理字面条目: 含通配或转义的条目仍交给枚举清单. 只要文本里出现 `!` 取反就
 * 整体放弃 —— 纯 deny 表达不了 gitignore 的 last-match-wins, 交给枚举兜底.
 * 目录标记 (`build/`) 在这里不额外区分: 同名文件也会一并挡住, 属于收紧.
 * @param text - 生效的保护路径原文 (设置页文本与工作区规则文件合并后的结果).
 * @param workspaceRoot - 工作区根, 锚定条目与任意层级条目都以它为界.
 * @returns SBPL `(deny file-write* (regex ...))` 形式; 无法表达时为空数组.
 */
export function seatbeltRegexDenials(text: string, workspaceRoot: string): string[] {
  if (text.trim().length === 0) return []
  const entries = parsePatternLines(text)
  if (entries.some(entry => entry.negated)) return []
  const forms: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!isPlainLiteral(entry)) continue
    const pattern = regexForEntry(entry, workspaceRoot)
    if (seen.has(pattern)) continue
    seen.add(pattern)
    forms.push(`(deny file-write* (regex #"${pattern.replaceAll('"', String.raw`\"`)}"))`)
  }
  return forms
}

/**
 * 追加到 Seatbelt profile 末尾的 broker 逃逸拒绝形式. 每条都是完整的 SBPL 形式,
 * 顺序无关, 但整体必须出现在官方 `(allow default)` 之后.
 */
export const SEATBELT_BROKER_DENIALS: readonly string[] = [
  // LaunchServices 的服务名段. `open` / NSWorkspace 靠它把启动请求交给 launchd,
  // 由 launchd 派生出不带 profile 的进程. SBPL 的名称过滤器按 reverse-DNS 分段
  // 匹配 (`com.apple.coreservices.q` 匹配不到 `...quarantine-resolver`), 所以只能
  // 整段拒绝, 无法按子前缀收窄.
  '(deny mach-lookup (global-name-prefix "com.apple.coreservices"))',
  // AppleEvents: 让沙箱外已在运行的 app 代劳 (osascript tell app ... 一类).
  '(deny appleevent-send)',
  // 沙箱外进程的 task port, 可用于注入已在运行的进程.
  '(deny mach-priv-task-port)',
]

/**
 * 把一组 SBPL 形式追加到 `-p` 之后的 profile 文本末尾.
 * @param argv - 官方 provider 返回的沙箱 argv (profile 位于 `-p` 的下一个位置).
 * @param forms - 要追加的 SBPL 形式, 空数组时原样返回.
 * @returns 追加后的 argv; 形状不符合预期 (`-p` 缺失) 时返回 undefined.
 */
export function appendSeatbeltForms(argv: readonly string[], forms: readonly string[]): string[] | undefined {
  if (forms.length === 0) return [...argv]
  const profileIndex = argv.indexOf('-p')
  if (profileIndex === -1 || profileIndex + 1 >= argv.length) return undefined
  const next = [...argv]
  next[profileIndex + 1] = `${next[profileIndex + 1]} ${forms.join(' ')}`
  return next
}

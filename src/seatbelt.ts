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

/** 把一个路径引用为 SBPL 字符串字面量 (与官方 profiles 的转义规则一致). */
export function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
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

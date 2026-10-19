/**
 * 模型可见的文案: 系统提示词里的沙箱策略说明, 以及 `request_writable_path` 的
 * 工具描述.
 *
 * **纯拼接**: 不碰文件系统, 也不探测平台；平台由调用方传入, 因此在非 Windows
 * 机器上也能覆盖 Windows 分支.
 *
 * 为什么要分支: Windows 上官方沙箱只能把整个工作区设成可写或不可写, 子路径的
 * 写保护, 额外可写根与会话授权只有 write / edit 围栏能落实, bash / pwsh 拿不到.
 * 提示词若照搬其他平台的措辞, 模型会把"命令跑通了"当成"模式没命中", 在 Windows
 * 上放心删受保护的路径.
 * @module dsh-write-protect/prompt
 */

import { REQUEST_WRITABLE_PATH_TOOL } from './constants.ts'

/** 提示词输入: 已解析好的生效值, 本模块只负责措辞. */
export interface PromptInput {
  /** 宿主平台, 决定是否附上 Windows 的收窄说明. */
  platform: NodeJS.Platform
  /** 生效的保护路径原文 (含工作区只读规则文件贡献的条目), 空串省略. */
  patterns: string
  /** 工作区只读规则文件名, 空串表示关闭识别. */
  readonlyFileName: string
  /** 读拒绝路径原文, 空串省略. */
  readDeny: string
  /** 生效的额外可写根. */
  writable: readonly string[]
  /** 本会话绕过写保护的授权路径. */
  overrides: readonly string[]
  /** 本会话读侧的授权路径, 只在有读拒绝时展示. */
  sessionGrants: readonly string[]
  /** 是否受理 `request_writable_path`. */
  allowWritableRequests: boolean
  /** 是否叠加了 WSL 互操作加固, 只在 WSL 宿主上为真. */
  hardenWsl: boolean
}

/** Windows 上命令侧没有围栏, 必须把这件事直说. */
const WINDOWS_NARROWING = 'On Windows the sandbox can only make the whole workspace writable or read-only, so the entries above bind only the write and edit tools: sandboxed commands (bash / pwsh) neither deny protected paths nor receive additional writable roots or session grants, and they can still read read-denied paths. A command that succeeded is not evidence that a path was checked.'

/**
 * 拼出系统提示词里的策略说明. 没有任何可说的条目时返回空数组 (调用方 join 成
 * 空串, 不改动官方提示词).
 * @param input - 生效值与平台.
 * @returns 每项一句话, 顺序固定.
 */
export function writeProtectPromptLines(input: PromptInput): string[] {
  const windows = input.platform === 'win32'
  const parts: string[] = []
  const patterns = input.patterns.trim()
  const readDeny = input.readDeny.trim()
  if (patterns.length > 0) {
    parts.push(`Write-protected patterns (gitignore semantics; in read-only and workspace-write mode every DSH-enforced operation denies writes beneath matching paths, reads stay allowed; danger-full-access is unrestricted): ${JSON.stringify(patterns)}.`)
  }
  if (input.readonlyFileName.length > 0) {
    parts.push(`The workspace read-only rules file "${input.readonlyFileName}" contributes to those patterns; it is read from the session workspace root and cannot be modified by any tool or command.`)
  }
  // 有围栏条目才解释围栏的边界, 空配置时这句话没有指代对象.
  if (windows && (patterns.length > 0 || readDeny.length > 0 || input.writable.length > 0 || input.overrides.length > 0)) {
    parts.push(WINDOWS_NARROWING)
  }
  if (readDeny.length > 0) {
    parts.push(windows
      ? `Read-denied patterns (same gitignore semantics; the read tools refuse to read these paths, and grep / glob results never contain them; sandboxed commands can still read them on Windows; danger-full-access is unrestricted): ${JSON.stringify(input.readDeny)}.`
      : `Read-denied patterns (same gitignore semantics; the read tools and every sandboxed command refuse to read these paths, and grep / glob results never contain them; danger-full-access is unrestricted): ${JSON.stringify(input.readDeny)}.`)
  }
  if (input.writable.length > 0) {
    parts.push(windows
      ? `Additional writable roots under workspace-write (the write and edit tools may write here; write-protected paths still win; does not apply in read-only): ${JSON.stringify(input.writable)}.`
      : `Additional writable roots under workspace-write (sandboxed commands and write/edit tools may write here; write-protected paths still win; does not apply in read-only): ${JSON.stringify(input.writable)}.`)
  }
  if (input.overrides.length > 0) {
    parts.push(windows
      ? `Session grants that bypass write protection for the write and edit tools: ${JSON.stringify(input.overrides)}.`
      : `Session grants that bypass write protection for the write/edit tools and for sandboxed commands: ${JSON.stringify(input.overrides)}.`)
  }
  if (input.sessionGrants.length > 0 && readDeny.length > 0) {
    parts.push(windows
      ? `A session grant also unlocks reading its path and everything under it for the read tools: ${JSON.stringify(input.sessionGrants)}.`
      : `A session grant also unlocks reading its path and everything under it: ${JSON.stringify(input.sessionGrants)}.`)
  }
  if (input.allowWritableRequests) {
    parts.push(`Extra write access is not granted by default. Call ${JSON.stringify(REQUEST_WRITABLE_PATH_TOOL)} when the task will keep writing the same protected path or area (a directory of files to generate, a build output tree, a path outside the workspace that several writes depend on); a single file is written with the ordinary write/edit tools, and if that write is denied, leave it at that. The same grant is what unlocks a read-denied path, so use it there too. The user decides in an approval prompt, and the grant lasts only for this session. The user can also withdraw a grant at any time from the session's write-access panel; a withdrawn grant disappears from the lists above and you receive a notice naming the path.`)
  } else {
    parts.push('Extra write access is not granted by this deployment: do not ask for it.')
  }
  if (input.hardenWsl) {
    parts.push('WSL interop hardening is active for sandboxed commands: the Windows drives under /mnt and the /run/WSL interop sockets are hidden, so Windows executables (cmd.exe and the like) cannot be launched from inside the sandbox. This is the Linux analog of the macOS broker hardening. Turn off WSL interop hardening in plugin settings if a task must use Windows interop from inside the sandbox.')
  }
  return parts
}

/**
 * `request_writable_path` 的工具描述. Windows 上补一句授权只到 write / edit,
 * 免得模型以为批过之后命令也能写.
 * @param platform - 宿主平台, 缺省取 `process.platform`.
 * @returns 工具描述全文.
 */
export function requestWritableDescription(platform: NodeJS.Platform = process.platform): string {
  const base = 'Ask the user to grant access to one path for this session, for work that will keep writing the same protected path '
    + 'or area (a directory of files to generate, a build output tree, a path outside the workspace that several writes depend on), '
    + 'or that genuinely needs to read a read-denied path. '
    + 'A single file is written with the ordinary write/edit tools. The user decides in an approval prompt, and a granted path stays '
    + 'writable and readable only until the session ends.'
  return platform === 'win32'
    ? `${base} On Windows a granted path reaches only the write and edit tools; sandboxed commands are not extended.`
    : base
}

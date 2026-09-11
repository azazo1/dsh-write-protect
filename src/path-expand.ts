/**
 * 额外可写根的 `~` 与环境变量展开. 保护路径保持 gitignore 语义, 不走这里.
 * 顺序对齐常见 shell: 先展开行首 `~` / `~/...` 为当前用户家目录, 再展开
 * `$NAME` / `${NAME}`. `~user` 不支持. 未设置或空值的变量整行失败, 由调用
 * 方告警跳过, 避免空串把路径拼成文件系统根.
 *
 * 平台差异: `\` 只在不把反斜杠当路径分隔符的平台 (POSIX) 上作转义符; Windows
 * 上它是分隔符, 一律按字面保留 —— 否则 `C:\Users\me\caches` 会被吃成
 * `C:Usermecaches`, 从盘符绝对路径变成落点取决于进程当前目录的盘符相对路径.
 * Windows 上 `~\...` 与 `~/...` 同样展开为家目录.
 * @module dsh-write-protect/path-expand
 */

import { homedir } from 'node:os'
import { posix, win32, type PlatformPath } from 'node:path'

/** 展开成功得到路径, 或带一句可直接拼进告警的失败原因. */
export type PathExpandResult =
  | { readonly ok: string }
  | { readonly error: string }

/** 展开参数: 缺省用当前进程的平台与当前用户家目录. */
export interface PathExpandOptions {
  /** 目标平台: 决定 `\` 是分隔符还是转义符, 也让测试能按平台断言. */
  readonly platform?: NodeJS.Platform
  /** 家目录 (`~` 展开目标), 缺省 `os.homedir()`. */
  readonly home?: string
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*/

const TILDE_ERROR = 'only ~ and ~/... expand to the current user home (~\\... is accepted on Windows)'

/** 平台路径 API: Windows 用 win32 语义, 其余用 POSIX 语义. */
export function pathApiOf(platform: NodeJS.Platform = process.platform): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

/** 该平台是否把 `\` 当转义符 (Windows 上它是路径分隔符). */
export function escapesWithBackslash(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/**
 * 展开一行额外可写配置: 行首 `~`, 然后 `$NAME` / `${NAME}`.
 * POSIX 上 `\` 转义下一字符 (`\$` 保留字面 `$`, `\~` 保留字面 `~`);
 * Windows 上 `\` 是分隔符, 不做转义.
 */
export function expandTildeAndEnv(line: string, options: PathExpandOptions = {}): PathExpandResult {
  const platform = options.platform ?? process.platform
  const withTilde = expandLeadingTilde(line, pathApiOf(platform), options.home ?? homedir())
  if ('error' in withTilde) return withTilde
  return expandEnvVars(withTilde.ok, escapesWithBackslash(platform))
}

/** 只认当前用户: 裸 `~` 与 `~/...` (Windows 上还有 `~\...`); `~user` 拒绝. */
function expandLeadingTilde(line: string, api: PlatformPath, home: string): PathExpandResult {
  if (!line.startsWith('~')) return { ok: line }
  if (home.length === 0) return { error: 'current user home directory is empty' }
  if (line === '~') return { ok: home }
  const rest = line.slice(1)
  if (rest.startsWith('/') || (api.sep === '\\' && rest.startsWith('\\'))) {
    return { ok: api.join(home, rest.slice(1)) }
  }
  return { error: TILDE_ERROR }
}

/** 展开 `$NAME` 与 `${NAME}`; 名字必须是 POSIX 标识符. */
function expandEnvVars(input: string, backslashEscapes: boolean): PathExpandResult {
  let out = ''
  let index = 0
  while (index < input.length) {
    const ch = input[index]!
    if (backslashEscapes && ch === '\\' && index + 1 < input.length) {
      out += input[index + 1]!
      index += 2
      continue
    }
    if (ch === '$') {
      const ref = readEnvName(input, index + 1)
      if (ref === undefined) return { error: 'has an invalid environment variable reference' }
      const value = process.env[ref.name]
      if (value === undefined || value.length === 0) {
        return { error: `references unset or empty environment variable "${ref.name}"` }
      }
      out += value
      index = ref.next
      continue
    }
    out += ch
    index += 1
  }
  return { ok: out }
}

function readEnvName(input: string, start: number): { name: string, next: number } | undefined {
  if (input[start] === '{') {
    const end = input.indexOf('}', start + 1)
    if (end === -1) return undefined
    const name = input.slice(start + 1, end)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined
    return { name, next: end + 1 }
  }
  const slice = input.slice(start)
  const match = ENV_NAME.exec(slice)
  if (match === null) return undefined
  return { name: match[0], next: start + match[0].length }
}

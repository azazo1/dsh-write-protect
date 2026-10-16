/**
 * 额外可写根的 `~` 与环境变量展开, 以及模式列表 (保护路径 / 读拒绝路径) 的同一套
 * 展开. 两者规则一致: 先展开行首 `~` / `~/...` 为当前用户家目录, 再展开
 * `$NAME` / `${NAME}`. `~user` 不支持. 未设置或空值的变量整行失败, 由调用方
 * 告警跳过, 避免空串把路径拼成文件系统根.
 *
 * 平台差异: `\` 只在不把反斜杠当路径分隔符的平台 (POSIX) 上作转义符; Windows
 * 上它是分隔符, 一律按字面保留 —— 否则 `C:\Users\me\caches` 会被吃成
 * `C:Usermecaches`, 从盘符绝对路径变成落点取决于进程当前目录的盘符相对路径.
 * Windows 上 `~\...` 与 `~/...` 同样展开为家目录.
 *
 * 模式列表走 {@link expandPatternLine} / {@link expandPatternText}: 产物仍是
 * gitignore 模式, 因此行首替换出来的绝对路径写成 `//` 形态, 替换进去的值按字面
 * 转义, 用户自己写的通配与转义原样保留.
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

/** 一份模式列表文本的展开结果: 展开后的文本与被丢弃的行 (逐条告警原文). */
export interface PatternTextExpansion {
  readonly text: string
  readonly warnings: readonly string[]
}

/**
 * 展开模式列表里的一行 (gitignore 语法的保护路径 / 读拒绝路径).
 *
 * 只替换行首 `~` 与行内 `$NAME` / `${NAME}`, 其余字符 (包括用户写的 `\` 转义与
 * 通配) 原样保留; 替换进来的值按 gitignore 字面转义, 免得家目录里的 `[` 一类
 * 字符被当成通配. 行首替换出的绝对路径写成 `//` 形态 —— 单个 `/` 在本插件的模式
 * 语义里是"锚定工作区根", 表达不了家目录.
 *
 * `!` 取反前缀保留: `!~/.ssh` 展开为 `!//Users/me/.ssh`.
 * @param line - 配置里的一行原文.
 * @param options - 平台与家目录覆盖 (缺省用当前进程).
 * @returns 展开后的模式行, 或可直接拼进告警的失败原因.
 */
export function expandPatternLine(line: string, options: PathExpandOptions = {}): PathExpandResult {
  const platform = options.platform ?? process.platform
  const api = pathApiOf(platform)
  const home = options.home ?? homedir()
  const backslashEscapes = escapesWithBackslash(platform)
  const negated = line.startsWith('!')
  // Windows 上 `~\...` 按路径处理: 反斜杠换成 gitignore 的分隔符, 免得 `\U`
  // 被当成转义序列吃掉.
  let body = negated ? line.slice(1) : line
  if (platform === 'win32' && body.startsWith('~\\')) body = body.replaceAll('\\', '/')

  let out = ''
  let atStart = true
  if (body.startsWith('~')) {
    const rest = body.slice(1)
    if (rest.length > 0 && !rest.startsWith('/')) return { error: TILDE_ERROR }
    if (home.length === 0) return { error: 'current user home directory is empty' }
    const substituted = substitutePatternValue(home, true, api)
    if ('error' in substituted) return substituted
    out = substituted.ok
    body = rest
    atStart = false
  }

  let index = 0
  while (index < body.length) {
    const ch = body[index]!
    if (backslashEscapes && ch === '\\' && index + 1 < body.length) {
      // 用户自己的转义序列留给 gitignore 解析, 这里不消费它.
      out += ch + body[index + 1]!
      index += 2
      atStart = false
      continue
    }
    if (ch === '$') {
      const ref = readEnvName(body, index + 1)
      if (ref === undefined) return { error: 'has an invalid environment variable reference' }
      const value = process.env[ref.name]
      if (value === undefined || value.length === 0) {
        return { error: `references unset or empty environment variable "${ref.name}"` }
      }
      const substituted = substitutePatternValue(value, atStart, api)
      if ('error' in substituted) return substituted
      out += substituted.ok
      index = ref.next
      atStart = false
      continue
    }
    out += ch
    index += 1
    atStart = false
  }
  return { ok: (negated ? '!' : '') + out }
}

/**
 * 展开一份模式列表文本: 逐行展开, 空行与 `#` 注释原样保留, 展开失败的行丢弃并把
 * 原因记进 warnings (调用方告警).
 * @param text - 模式列表原文.
 * @param options - 平台与家目录覆盖 (缺省用当前进程).
 */
export function expandPatternText(text: string, options: PathExpandOptions = {}): PatternTextExpansion {
  if (text.length === 0) return { text, warnings: [] }
  const kept: string[] = []
  const warnings: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0 || line.startsWith('#')) {
      kept.push(line)
      continue
    }
    const expanded = expandPatternLine(line, options)
    if ('error' in expanded) {
      warnings.push(`pattern line ${JSON.stringify(line)} ${expanded.error}; the line is dropped`)
      continue
    }
    kept.push(expanded.ok)
  }
  return { text: kept.join('\n'), warnings }
}

/** gitignore 里有特殊含义的字符: 替换进来的值按字面处理, 因此逐个转义. */
function escapePatternLiteral(value: string): string {
  return value.replaceAll('\\', '\\\\').replace(/[*?[\]]/gu, '\\$&')
}

/**
 * 一个替换值写进模式里的形态: 绝对路径写成 `//` 形态 (单个 `/` 在本插件的模式
 * 语义里是锚定工作区根), 值本身按字面转义; 行首若替换出文件系统根本身则报错 ——
 * `//` 表达不了根, 那也几乎必然是一处误配.
 */
function substitutePatternValue(value: string, atStart: boolean, api: PlatformPath): PathExpandResult {
  const posixValue = api.sep === '\\' ? value.replaceAll('\\', '/') : value
  if (!atStart || !api.isAbsolute(value)) {
    return { ok: escapePatternLiteral(posixValue).replace(/^([#!])/u, '\\$1') }
  }
  if (posixValue.replace(/^\/+/u, '').length === 0) {
    return { error: 'expands to the filesystem root, which this pattern syntax cannot express' }
  }
  // 后面前缀的 `//` 自己承担开头分隔符, 值里那个就不要重复写.
  const body = escapePatternLiteral(posixValue.replace(/^\/+/u, ''))
  return { ok: `//${body.replace(/^([#!])/u, '\\$1')}` }
}

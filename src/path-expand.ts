/**
 * 额外可写根的 `~` 与环境变量展开. 保护路径保持 gitignore 语义, 不走这里.
 * 顺序对齐常见 shell: 先展开行首 `~` / `~/...` 为当前用户家目录, 再展开
 * `$NAME` / `${NAME}`. `~user` 不支持. 未设置或空值的变量整行失败, 由调用
 * 方告警跳过, 避免空串把路径拼成文件系统根.
 * @module dsh-write-protect/path-expand
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 展开成功得到路径, 或带一句可直接拼进告警的失败原因. */
export type PathExpandResult =
  | { readonly ok: string }
  | { readonly error: string }

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*/

/**
 * 展开一行额外可写配置: 行首 `~`, 然后 `$NAME` / `${NAME}`.
 * `\` 转义下一字符 (`\$` 保留字面 `$`, `\~` 保留字面 `~`).
 */
export function expandTildeAndEnv(line: string): PathExpandResult {
  const withTilde = expandLeadingTilde(line)
  if ('error' in withTilde) return withTilde
  return expandEnvVars(withTilde.ok)
}

/** 只认当前用户: 裸 `~` 与 `~/...`; `~user` 拒绝. */
function expandLeadingTilde(line: string): PathExpandResult {
  if (!line.startsWith('~')) return { ok: line }
  const home = homedir()
  if (home.length === 0) return { error: 'current user home directory is empty' }
  if (line === '~') return { ok: home }
  if (line.startsWith('~/')) return { ok: join(home, line.slice(2)) }
  return { error: 'only ~ and ~/... expand to the current user home' }
}

/** 展开 `$NAME` 与 `${NAME}`; 名字必须是 POSIX 标识符. */
function expandEnvVars(input: string): PathExpandResult {
  let out = ''
  let index = 0
  while (index < input.length) {
    const ch = input[index]!
    if (ch === '\\' && index + 1 < input.length) {
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

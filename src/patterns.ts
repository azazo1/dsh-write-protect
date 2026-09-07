/**
 * gitignore 风格的保护路径配置解析: 多行文本, 每行一条, `#` 注释, 空行忽略,
 * `!` 取反, 每条支持词法 glob (`*`, `?`, `**`). 相对条目锚定到工作区根
 * (每个会话的工作区各自解析), 绝对条目原样使用.
 *
 * 展开语义: 字面条目直接保留 (路径尚不存在时保留词法形态, fs 围栏与
 * Seatbelt 对不存在路径同样有效); glob 条目枚举匹配的现有路径 (受限节点
 * 预算, 超限停止并告警). 取反条目从展开结果中剔除匹配项 — 语义是
 * "剔除一条展开结果", 不能在仍受保护的目录内部重新放行后代.
 * @module dsh-write-protect/patterns
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { EXPAND_NODE_BUDGET } from './constants.ts'

/** 一条解析后的配置行. */
export interface PatternEntry {
  /** `!` 前缀的取反条目: 从展开结果中剔除匹配项. */
  readonly negated: boolean
  /** 去掉前导 `/` 与尾部 `/` 之后的条目文本 (以 `/` 分段). */
  readonly pattern: string
}

/** 展开结果: canonical 保护路径与展开过程中的告警. */
export interface ExpandResult {
  readonly paths: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * 解析配置文本为条目列表: 跳过空行与 `#` 注释, 处理 `!` 前缀与尾部 `/`.
 * 前导 `/` 原样保留 — 以 `/` 开头的条目按绝对路径解释 (相对条目本就锚定
 * 工作区根, 无需前导斜杠锚定).
 */
export function parsePatternLines(text: string): PatternEntry[] {
  const entries: PatternEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    let pattern = negated ? line.slice(1).trim() : line
    if (pattern.endsWith('/')) pattern = pattern.slice(0, -1)
    if (pattern.length === 0) continue
    entries.push({ negated, pattern })
  }
  return entries
}

/** 是否为字面条目 (不含 glob 元字符), 无需文件系统枚举. */
export function isLiteralPattern(pattern: string): boolean {
  return !/[*?]/.test(pattern)
}

/** 把一个 glob 段序列编译为 POSIX 形态路径的全匹配正则 (空段滤除). */
function globToRegExp(pattern: string, caseSensitive: boolean): RegExp {
  const source = pattern.split('/').filter(segment => segment.length > 0).map(segment => {
    if (segment === '**') return '.+'
    let out = ''
    for (const ch of segment) {
      if (ch === '*') out += '[^/]*'
      else if (ch === '?') out += '[^/]'
      else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    return out
  }).join('/')
  return new RegExp(`^${source}$`, caseSensitive ? '' : 'i')
}

const GLOB_MATCH_CASE_SENSITIVE = process.platform !== 'win32'

/** 预算耗尽信号: 展开中途停止, 已收集的路径仍然有效. */
class BudgetExceeded extends Error {}

/** 共享的遍历预算: readdir 与存在性检查都消耗. */
class NodeBudget {
  private remaining: number

  constructor(limit: number) {
    this.remaining = limit
  }

  spend(): void {
    this.remaining -= 1
    if (this.remaining < 0) throw new BudgetExceeded('node budget exhausted')
  }
}

/**
 * 枚举一个 glob 条目在 `basePosix` 下匹配的现有路径 (POSIX 形态词法路径).
 * `**` 递归枚举后代目录, 含 glob 的段用 readdir 过滤, 字面段直接拼接并
 * 以存在性剪枝.
 */
function collectGlobMatches(
  segments: readonly string[],
  basePosix: string,
  budget: NodeBudget,
): { paths: string[], exhausted: boolean } {
  const caseSensitive = GLOB_MATCH_CASE_SENSITIVE
  const matches: string[] = []
  let exhausted = false

  const walk = (current: string, index: number): void => {
    if (index >= segments.length) {
      matches.push(current)
      return
    }
    const segment = segments[index]!
    if (segment === '**') {
      // `**` 先按匹配零段处理, 再递归每个现存子目录.
      walk(current, index + 1)
      budget.spend()
      let names: string[]
      try {
        names = readdirSync(current)
      } catch {
        return
      }
      for (const name of names) {
        const child = `${current}/${name}`
        budget.spend()
        let isDir = false
        try {
          isDir = statSync(child).isDirectory()
        } catch {
          continue
        }
        if (isDir) walk(child, index)
      }
      return
    }
    const last = index === segments.length - 1
    if (isLiteralPattern(segment)) {
      const next = `${current}/${segment}`
      budget.spend()
      if (!existsSync(next)) return
      if (last) matches.push(next)
      else walk(next, index + 1)
      return
    }
    const regex = globToRegExp(segment, caseSensitive)
    budget.spend()
    let names: string[]
    try {
      names = readdirSync(current)
    } catch {
      return
    }
    for (const name of names) {
      if (!regex.test(name)) continue
      const next = `${current}/${name}`
      if (last) {
        matches.push(next)
        continue
      }
      budget.spend()
      let isDir = false
      try {
        isDir = statSync(next).isDirectory()
      } catch {
        continue
      }
      if (isDir) walk(next, index + 1)
    }
  }

  try {
    walk(basePosix, 0)
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error
    // 预算耗尽: 停止枚举, 已收集的部分仍然有效, 由调用方补充告警.
    exhausted = true
  }
  return { paths: matches, exhausted }
}

function toPosix(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/**
 * 把配置文本针对一次调用的工作区根展开为 canonical 保护路径. glob 条目只
 * 收集展开时刻已存在的路径 (之后新建的路径不受保护); 预算耗尽时保留已收集
 * 的部分并附带告警.
 * @param text - gitignore 风格的配置文本.
 * @param workspaceRoot - 本次调用的工作区根.
 * @returns canonical 保护路径 (去重) 与告警列表.
 */
export function expandReadOnlyPaths(text: string, workspaceRoot: string): ExpandResult {
  const warnings: string[] = []
  const entries = parsePatternLines(text)
  const positive: { pattern: string, paths: string[] }[] = []
  const negativeRegexps: RegExp[] = []
  const budget = new NodeBudget(EXPAND_NODE_BUDGET)

  for (const { negated, pattern } of entries) {
    if (negated) {
      // 取反按原始条目编译: 相对条目匹配工作区相对形态, 绝对条目匹配绝对形态.
      negativeRegexps.push(globToRegExp(pattern, GLOB_MATCH_CASE_SENSITIVE))
      continue
    }
    if (isLiteralPattern(pattern)) {
      positive.push({ pattern, paths: [resolvePath(workspaceRoot, pattern)] })
      continue
    }
    // glob 条目: 段序列只含 pattern 自身, 从起始根 (绝对条目为文件系统根,
    // 相对条目为工作区根) 向下受限枚举.
    const segments = pattern.split('/').filter(segment => segment.length > 0)
    const start = isAbsolute(pattern) ? '/' : toPosix(workspaceRoot)
    const collected = collectGlobMatches(segments, start, budget)
    if (collected.exhausted) {
      warnings.push(`glob "${pattern}" reached the traversal budget (${EXPAND_NODE_BUDGET} nodes), the expansion may be incomplete`)
    }
    positive.push({ pattern, paths: collected.paths.map(path => resolvePath(path)) })
  }

  const paths: string[] = []
  const seen = new Set<string>()
  for (const { paths: collected } of positive) {
    for (const path of collected) {
      if (isNegated(path, workspaceRoot, negativeRegexps)) continue
      const canonical = canonicalPath(path)
      if (seen.has(canonical)) continue
      seen.add(canonical)
      paths.push(canonical)
    }
  }
  return { paths, warnings }
}

/** 是否命中任一取反条目 (按工作区相对路径或绝对路径匹配). */
function isNegated(path: string, workspaceRoot: string, negatives: readonly RegExp[]): boolean {
  if (negatives.length === 0) return false
  const rel = relative(workspaceRoot, path)
  const candidates = rel === '' || rel.startsWith('..') ? [toPosix(path)] : [toPosix(rel), toPosix(path)]
  return negatives.some(regex => candidates.some(candidate => regex.test(candidate)))
}

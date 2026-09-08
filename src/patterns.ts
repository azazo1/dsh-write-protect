/**
 * 保护路径配置解析, 完全对齐 gitignore(5) 的模式语义: 多行文本, 每行一条,
 * `#` 注释, 空行忽略, `\` 转义 (`\#`, `\!`, 尾部空格用 `\ ` 保留), 尾部 `/`
 * 只匹配目录, 含开头或中间分隔符的条目锚定到工作区根 (每个会话各自解析),
 * 其余条目在任意层级匹配. 通配: `*` 与 `?` 不跨 `/`, `[...]` 字符类 (含
 * `[:alpha:]` 等 POSIX 类), `**` 仅在独立成段时递归 (开头 = 任意层级, 中间 =
 * 零或多层目录); 段内连续星号按普通 `*` 处理. `!` 取反按 gitignore 的
 * last-match-wins 顺序解释, 但前缀围栏模型与 gitignore 的目录剪枝一致:
 * 无法在仍受保护的目录内部重新放行后代.
 *
 * 展开语义: 锚定字面条目是单一显式路径, 不存在也保留 (fs 围栏与 Seatbelt
 * 对不存在路径同样有效); 其余条目枚举展开时刻已存在的路径 (受限节点预算,
 * 超限停止并告警, 新建路径要等下次重新展开才纳入). 执法扩展: `//` 前缀
 * 表示文件系统绝对路径 (gitignore 没有这个形态, 部署配置需要); 以 `/**`
 * 结尾的条目按前缀围栏等价性保护其命名目录本身, 而不是枚举全部后代.
 * @module dsh-write-protect/patterns
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, parse as parsePath, relative, resolve as resolvePath, sep } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { EXPAND_NODE_BUDGET } from './constants.ts'
import { expandTildeAndEnv } from './path-expand.ts'

/** 一条解析后的配置行. */
export interface PatternEntry {
  /** `!` 前缀的取反条目: last-match-wins 顺序下剔除匹配的展开结果. */
  readonly negated: boolean
  /** 尾部 `/`: 只匹配目录. */
  readonly dirOnly: boolean
  /** 含开头或中间分隔符: 锚定到工作区根, 不做任意层级匹配. */
  readonly anchored: boolean
  /** `//` 前缀: 文件系统绝对路径 (本插件的执法扩展). */
  readonly fsAbsolute: boolean
  /** 以 `/` 分段后的原始模式段 (未去转义, `**` 保留为独立段). */
  readonly segments: readonly string[]
  /** 解析后的条目原文 (去除 `!` 前缀与目录标记), 用于告警定位. */
  readonly source: string
}

/** 候选保护路径: `isDir` 为 null 表示路径尚不存在 (无法判定目录性). */
interface Candidate {
  readonly path: string
  readonly isDir: boolean | null
}

/** 展开结果: canonical 保护路径与展开过程中的告警. */
export interface ExpandResult {
  readonly paths: readonly string[]
  readonly warnings: readonly string[]
}

/** 解析前的行预处理: 移除未转义的尾部空格 (gitignore 只忽略尾部空格). */
function stripTrailingSpaces(line: string): string {
  let end = line.length
  while (end > 0 && line[end - 1] === ' ' && !isEscapedAt(line, end - 1)) end -= 1
  return line.slice(0, end)
}

/** 位置 index 的字符是否被奇数个连续 `\` 转义. */
function isEscapedAt(line: string, index: number): boolean {
  let slashes = 0
  for (let i = index - 1; i >= 0 && line[i] === '\\'; i -= 1) slashes += 1
  return slashes % 2 === 1
}

/** 按未转义的 `/` 分段, 转义序列原样保留在段内. */
function splitUnescaped(line: string): string[] {
  const segments: string[] = []
  let current = ''
  let i = 0
  while (i < line.length) {
    const ch = line[i]!
    if (ch === '\\' && i + 1 < line.length) {
      current += ch + line[i + 1]!
      i += 2
      continue
    }
    if (ch === '/') {
      segments.push(current)
      current = ''
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  segments.push(current)
  return segments
}

/**
 * 解析配置文本为条目列表: 跳过空行与 `#` 注释, 处理 `!` 前缀, 尾部 `/` 与
 * `//` 绝对扩展; 前导与中间的 `/` 使条目锚定到工作区根.
 */
export function parsePatternLines(text: string): PatternEntry[] {
  const entries: PatternEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    let line = stripTrailingSpaces(rawLine)
    if (line.length === 0 || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    if (negated) line = line.slice(1)
    let dirOnly = false
    while (line.length > 0 && line.endsWith('/') && !isEscapedAt(line, line.length - 1)) {
      line = line.slice(0, -1)
      dirOnly = true
    }
    let fsAbsolute = false
    let anchored = false
    if (line.startsWith('//')) {
      fsAbsolute = true
      anchored = true
      line = line.slice(2)
    } else if (line.startsWith('/')) {
      anchored = true
      line = line.slice(1)
    }
    const rawSegments = splitUnescaped(line)
    if (!anchored && rawSegments.length > 1) anchored = true
    const segments = rawSegments.filter(segment => segment.length > 0)
    if (segments.length === 0) continue
    entries.push({ negated, dirOnly, anchored, fsAbsolute, segments, source: line })
  }
  return entries
}

/** 段是否为字面段 (不含 glob 元字符与转义), 可直接按文本拼接. */
function isLiteralSegment(segment: string): boolean {
  return !/[*?[\]\\]/.test(segment)
}

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'A-Za-z',
  alnum: '0-9A-Za-z',
  digit: '0-9',
  xdigit: '0-9A-Fa-f',
  lower: 'a-z',
  upper: 'A-Z',
  space: '\\t\\n\\v\\f\\r ',
  blank: ' \\t',
  cntrl: '\\u0000-\\u001f\\u007f',
  punct: '!-/:-@\\[-`{-~',
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
}

function escapeClassChar(ch: string): string {
  return /[\\\]^[]/.test(ch) ? `\\${ch}` : ch
}

/** 把 `[...]` 类编译为正则类片段; 未闭合时返回 undefined (按字面 `[` 处理). */
function parseCharClass(pattern: string, start: number): { source: string, next: number } | undefined {
  let i = start + 1
  let negated = false
  if (pattern[i] === '!' || pattern[i] === '^') {
    negated = true
    i += 1
  }
  let body = ''
  let first = true
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === ']' && !first) return { source: charClassSource(body, negated), next: i + 1 }
    first = false
    if (ch === '[' && pattern[i + 1] === ':') {
      const end = pattern.indexOf(':]', i + 2)
      if (end !== -1) {
        body += pattern.slice(i, end + 2)
        i = end + 2
        continue
      }
    }
    body += ch
    i += 1
  }
  return undefined
}

/** 类体到正则片段: `/` 永不匹配 (FNM_PATHNAME), POSIX 类展开为显式范围. */
function charClassSource(body: string, negated: boolean): string {
  let inner = ''
  let i = 0
  while (i < body.length) {
    if (body.startsWith('[:', i)) {
      const end = body.indexOf(':]', i + 2)
      const name = end === -1 ? undefined : body.slice(i + 2, end)
      const range = name === undefined ? undefined : POSIX_CLASSES[name]
      if (range !== undefined) {
        inner += range
        i = end! + 2
        continue
      }
    }
    inner += escapeClassChar(body[i]!)
    i += 1
  }
  return `[${negated ? '^/' : ''}${inner}]`
}

/**
 * 把一个模式段编译为对单段路径名的全匹配正则 (段内不含真正的 `/`).
 * `\x` 转义为字面 x; `*` 为 `[^/]*`, `?` 为 `[^/]`, `[...]` 为字符类.
 */
function segmentToRegExp(pattern: string, caseSensitive: boolean): RegExp {
  let source = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '\\' && i + 1 < pattern.length) {
      source += escapeRegExpChar(pattern[i + 1]!)
      i += 2
      continue
    }
    if (ch === '*') {
      source += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      source += '[^/]'
      i += 1
      continue
    }
    if (ch === '[') {
      const cls = parseCharClass(pattern, i)
      if (cls !== undefined) {
        source += cls.source
        i = cls.next
        continue
      }
      source += '\\['
      i += 1
      continue
    }
    source += escapeRegExpChar(ch)
    i += 1
  }
  return new RegExp(`^${source}$`, caseSensitive ? '' : 'i')
}

const GLOB_MATCH_CASE_SENSITIVE = process.platform !== 'win32'

/** 一条编译后的条目: effective 已为非锚定条目补上虚拟 `**` 前缀. */
interface CompiledEntry {
  readonly entry: PatternEntry
  readonly effective: readonly string[]
  /** 与 effective 对齐的段匹配器, null 表示 `**` 段. */
  readonly matchers: readonly (RegExp | null)[]
}

function compileEntry(entry: PatternEntry): CompiledEntry {
  const effective = entry.anchored || entry.fsAbsolute ? entry.segments : ['**', ...entry.segments]
  const matchers = effective.map(segment => segment === '**' ? null : segmentToRegExp(segment, GLOB_MATCH_CASE_SENSITIVE))
  return { entry, effective, matchers }
}

/** 预算耗尽信号: 展开中途停止, 已收集的路径仍然有效. */
class BudgetExceeded extends Error {}

/** 共享的遍历预算: readdir 与 stat 都消耗. */
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

/** 带预算的目录性检查: 路径不存在时返回 null. */
function statIsDirBudgeted(path: string, budget: NodeBudget): boolean | null {
  budget.spend()
  try {
    return statSync(path).isDirectory()
  } catch {
    return null
  }
}

/**
 * 枚举一个条目在 `start` 下匹配的现有路径 (POSIX 形态词法路径). `**` 段按
 * 零或多层目录递归, 字面段直接拼接并以存在性剪枝, 其余段用 readdir 过滤
 * (非末段要求目录), 末段按 `dirOnly` 过滤.
 */
function collectGlobMatches(
  effective: readonly string[],
  matchers: readonly (RegExp | null)[],
  dirOnly: boolean,
  start: string,
  budget: NodeBudget,
): { paths: Candidate[], exhausted: boolean } {
  const matches: Candidate[] = []
  let exhausted = false

  const walk = (current: string, index: number): void => {
    const segment = effective[index]!
    const matcher = matchers[index]!
    const last = index === effective.length - 1
    if (matcher === null) {
      // `**` 段: 先按匹配零段处理, 再递归每个现存子目录.
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
        if (statIsDirBudgeted(child, budget) !== true) continue
        walk(child, index)
      }
      return
    }
    if (isLiteralSegment(segment)) {
      const next = `${current}/${segment}`
      if (!last) {
        budget.spend()
        if (existsSync(next)) walk(next, index + 1)
        return
      }
      const isDir = statIsDirBudgeted(next, budget)
      if (isDir === null || (dirOnly && !isDir)) return
      matches.push({ path: next, isDir })
      return
    }
    budget.spend()
    let names: string[]
    try {
      names = readdirSync(current)
    } catch {
      return
    }
    for (const name of names) {
      if (!matcher.test(name)) continue
      const next = `${current}/${name}`
      if (!last) {
        budget.spend()
        if (statIsDirBudgeted(next, budget) !== true) continue
        walk(next, index + 1)
        continue
      }
      const isDir = statIsDirBudgeted(next, budget)
      if (isDir === null || (dirOnly && !isDir)) continue
      matches.push({ path: next, isDir })
    }
  }

  try {
    walk(start, 0)
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

function splitPosix(path: string): string[] {
  return path.split('/').filter(segment => segment.length > 0)
}

/** 单条目对候选路径的匹配: 目录标记, 锚定形态与 `**` 递归全部生效. */
function entryMatches(compiled: CompiledEntry, candidate: Candidate, workspaceRoot: string): boolean {
  if (compiled.entry.dirOnly && candidate.isDir === false) return false
  let segments: readonly string[]
  if (compiled.entry.fsAbsolute) {
    segments = splitPosix(toPosix(candidate.path))
  } else {
    const rel = relative(workspaceRoot, candidate.path)
    if (rel.startsWith('..')) {
      // 工作区外的候选只可能来自绝对条目, 相对锚定条目不再匹配.
      if (compiled.entry.anchored && !compiled.entry.fsAbsolute) return false
      segments = splitPosix(toPosix(candidate.path))
    } else {
      // 候选即工作区根本身时为空段序列, 让 `**` 类条目得以命中.
      segments = rel === '' ? [] : splitPosix(toPosix(rel))
    }
  }
  return matchSegments(compiled.effective, compiled.matchers, segments)
}

/** 段序列匹配: `**` 匹配零或多层, 其余段逐段全匹配 (带记忆化避免指数回溯). */
function matchSegments(
  effective: readonly string[],
  matchers: readonly (RegExp | null)[],
  segments: readonly string[],
): boolean {
  const failed = new Set<string>()
  const walk = (pi: number, si: number): boolean => {
    if (pi >= effective.length) return si === segments.length
    const key = `${pi}:${si}`
    if (failed.has(key)) return false
    const matcher = matchers[pi]!
    let ok: boolean
    if (matcher === null) {
      ok = walk(pi + 1, si) || (si < segments.length && walk(pi, si + 1))
    } else if (si >= segments.length) {
      ok = false
    } else {
      ok = matcher.test(segments[si]!) && walk(pi + 1, si + 1)
    }
    if (!ok) failed.add(key)
    return ok
  }
  return walk(0, 0)
}

/** last-match-wins: 候选路径由顺序上最后命中的条目裁决去留. */
function lastMatchKeeps(
  candidate: Candidate,
  compiledEntries: readonly CompiledEntry[],
  workspaceRoot: string,
): boolean {
  let keeps = false
  for (const compiled of compiledEntries) {
    if (entryMatches(compiled, candidate, workspaceRoot)) keeps = !compiled.entry.negated
  }
  return keeps
}

/**
 * 把配置文本针对一次调用的工作区根展开为 canonical 保护路径, 语义对齐
 * gitignore(5): 锚定字面条目不存在也保留; 其余条目只收集展开时刻已存在的
 * 路径 (之后新建的路径要等下次展开才纳入); 预算耗尽时保留已收集的部分并
 * 附带告警.
 * @param text - gitignore 语义的配置文本.
 * @param workspaceRoot - 本次调用的工作区根.
 * @returns canonical 保护路径 (去重) 与告警列表.
 */
export function expandReadOnlyPaths(text: string, workspaceRoot: string): ExpandResult {
  const warnings: string[] = []
  const entries = parsePatternLines(text)
  const compiledEntries = entries.map(compileEntry)
  const budget = new NodeBudget(EXPAND_NODE_BUDGET)
  const candidates: Candidate[] = []

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.negated) continue
    const compiled = compiledEntries[index]!
    const start = entry.fsAbsolute ? '/' : toPosix(workspaceRoot)
    let end = compiled.effective.length
    while (end > 0 && compiled.effective[end - 1] === '**') end -= 1
    if (end === 0) {
      // `/**` (含裸 `**`): 前缀围栏下保护起始根本身.
      candidates.push({ path: start, isDir: true })
      continue
    }
    if (
      (entry.anchored || entry.fsAbsolute)
      && compiled.effective.every(segment => isLiteralSegment(segment))
    ) {
      // 锚定字面条目: 单一显式路径, 不存在也保留词法形态.
      const path = resolvePath(entry.fsAbsolute ? '/' : workspaceRoot, entry.fsAbsolute ? `/${compiled.effective.join('/')}` : compiled.effective.join('/'))
      candidates.push({ path, isDir: statIsDirBudgeted(path, budget) })
      continue
    }
    const collected = collectGlobMatches(
      compiled.effective.slice(0, end),
      compiled.matchers.slice(0, end),
      entry.dirOnly || end < compiled.effective.length,
      start,
      budget,
    )
    if (collected.exhausted) {
      warnings.push(`glob "${entry.source}" reached the traversal budget (${EXPAND_NODE_BUDGET} nodes), the expansion may be incomplete`)
    }
    candidates.push(...collected.paths)
  }

  const paths: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!lastMatchKeeps(candidate, compiledEntries, workspaceRoot)) continue
    const canonical = canonicalPath(candidate.path)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    paths.push(canonical)
  }
  return { paths, warnings }
}

/** 未转义的 glob 元字符: 额外可写根是字面路径, 命中则拒绝该行. */
function hasUnescapedGlobMeta(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '\\') {
      index += 1
      continue
    }
    const ch = line[index]
    if (ch === '*' || ch === '?' || ch === '[') return true
  }
  return false
}

/** canonical 路径是否就是文件系统根 (POSIX `/` 或 Windows 盘符根). */
function isFilesystemRoot(path: string): boolean {
  const canonical = canonicalPath(path)
  return canonical === parsePath(canonical).root
}

/** 词法包含: extra 可写根若已落在工作区内则没有放宽效果. */
function isLexicallyUnderRoot(path: string, root: string): boolean {
  const caseSensitive = process.platform !== 'win32'
  const comparablePath = caseSensitive ? path : path.toLowerCase()
  const comparableRoot = caseSensitive ? root : root.toLowerCase()
  if (comparablePath === comparableRoot) return true
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep
  return comparablePath.startsWith(prefix)
}

/**
 * 把额外可写配置文本展开为 canonical 根. 与保护路径不同, 这里是字面路径
 * 列表而不是 gitignore glob: 行首 `~` / `~/...` 展开为当前用户家目录,
 * `$NAME` / `${NAME}` 展开为环境变量; `//` 或宿主绝对路径按文件系统解析,
 * 其余相对当前工作区 (含 `..`). 工作区内的条目没有放宽效果, 文件系统根
 * 拒绝; 不存在的路径仍保留词法形态 (fs / Seatbelt 可按前缀放行, bwrap /
 * Landlock 在叠加时跳过).
 * @param text - 逐行一条字面路径的配置文本.
 * @param workspaceRoot - 本次调用的工作区根.
 * @returns canonical 额外可写根 (去重) 与告警列表.
 */
export function expandWritablePaths(text: string, workspaceRoot: string): ExpandResult {
  const warnings: string[] = []
  const paths: string[] = []
  const seen = new Set<string>()
  const workspaceCanonical = canonicalPath(workspaceRoot)

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTrailingSpaces(rawLine)
    if (line.length === 0 || line.startsWith('#')) continue
    if (line.startsWith('!')) {
      warnings.push(`writable path "${line}" uses ! negation; extra writable roots are a literal list`)
      continue
    }
    const expanded = expandTildeAndEnv(line)
    if ('error' in expanded) {
      warnings.push(`writable path "${line}" ${expanded.error}`)
      continue
    }
    if (hasUnescapedGlobMeta(expanded.ok)) {
      warnings.push(`writable path "${line}" contains glob metacharacters; extra writable roots must be literal paths`)
      continue
    }

    let resolved: string
    if (expanded.ok.startsWith('//')) {
      resolved = resolvePath('/', expanded.ok.slice(2))
    } else if (isAbsolute(expanded.ok)) {
      resolved = resolvePath(expanded.ok)
    } else {
      resolved = resolvePath(workspaceRoot, expanded.ok)
    }

    if (isFilesystemRoot(resolved)) {
      warnings.push(`writable path "${line}" resolves to the filesystem root and is rejected`)
      continue
    }
    const canonical = canonicalPath(resolved)
    if (isLexicallyUnderRoot(canonical, workspaceCanonical)) {
      warnings.push(`writable path "${line}" is already inside the workspace and is ignored`)
      continue
    }
    if (seen.has(canonical)) continue
    seen.add(canonical)
    paths.push(canonical)
  }
  return { paths, warnings }
}

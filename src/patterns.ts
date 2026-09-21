/**
 * 保护路径的**枚举展开**: 把 `gitignore.ts` 解析出的模式针对某个工作区根枚举成
 * 具体存在的路径, 供进程沙箱 (bwrap `--ro-bind` / Seatbelt `subpath`) 与 fs 围栏
 * 的前缀比较使用 —— 它们都得拿到真实路径.
 *
 * gitignore(5) 的模式语义与逐路径匹配都在 `gitignore.ts` (纯逻辑, 零运行时依赖),
 * 本模块只负责把模式落到磁盘上: 多行文本, `#` 注释, 空行忽略, `\` 转义, 尾部 `/`
 * 只匹配目录, 锚定判定, `!` 取反的 last-match-wins 顺序, 以及前缀围栏模型
 * (无法在仍受保护的目录内部重新放行后代) 全部沿用那份实现.
 *
 * 展开语义: 锚定字面条目是单一显式路径, 不存在也保留 (fs 围栏与 Seatbelt
 * 对不存在路径同样有效); 其余条目枚举展开时刻已存在的路径 (新建路径要等
 * 下次重新展开才纳入). 执法扩展: `//` 前缀表示文件系统绝对路径
 * (gitignore 没有这种形态, 部署配置需要); 以 `/**` 结尾的条目按前缀围栏
 * 等价性保护其命名目录本身, 而不是枚举全部后代. 展开遍历用 lstat, 不走进
 * 目录符号链接, 避免链到工作区外的大树 (如 `Applications -> /Applications`).
 * @module dsh-write-protect/patterns
 */

import { lstatSync, readdirSync } from 'node:fs'
import { isAbsolute, parse as parsePath, resolve as resolvePath, sep, type PlatformPath } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { compileEntry, isLiteralSegment, lastMatchKeeps, parsePatternLines, stripTrailingSpaces, toPosix } from './gitignore.ts'
import type { Candidate, CompiledEntry } from './gitignore.ts'
import { escapesWithBackslash, expandTildeAndEnv, pathApiOf, type PathExpandOptions } from './path-expand.ts'

// 解析与匹配的公共契约仍从本模块转出: 既有消费方按 './patterns.ts' 引用它们.
export { compileGitignore, parsePatternLines, stripTrailingSpaces, toPosix } from './gitignore.ts'
export type { Candidate, CompiledEntry, PatternEntry, PatternSet } from './gitignore.ts'

/** 展开结果: canonical 保护路径与展开过程中的告警. */
export interface ExpandResult {
  readonly paths: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * 目录性检查: 用 lstat, 不跟随符号链接. 路径不存在时返回 null; 指向目录的
 * 链接视为非目录, 展开时不走进去.
 */
function statIsDir(path: string): boolean | null {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return null
  }
}

/**
 * 枚举一个条目在 `start` 下匹配的现有路径 (POSIX 形态词法路径). 按队列
 * 广度优先展开: `**` 段按零或多层目录展开, 字面段直接拼接并以存在性剪枝,
 * 其余段用 readdir 过滤 (非末段要求目录), 末段按 `dirOnly` 过滤.
 * 已经会被保护的目录不再往里走 (里面的后代本来也写不了); 被取反放行的
 * 目录还会继续找. 目录符号链接不进入.
 */
function collectGlobMatches(
  effective: readonly string[],
  matchers: readonly (RegExp | null)[],
  dirOnly: boolean,
  start: string,
  compiledEntries: readonly CompiledEntry[],
  workspaceRoot: string,
): Candidate[] {
  const isKeptDir = (path: string): boolean => lastMatchKeeps({ path, isDir: true }, compiledEntries, workspaceRoot)
  const matches: Candidate[] = []
  const queue: { current: string, index: number }[] = [{ current: start, index: 0 }]
  let head = 0

  while (head < queue.length) {
    const { current, index } = queue[head]!
    head += 1
    const segment = effective[index]!
    const matcher = matchers[index]!
    const last = index === effective.length - 1
    if (matcher === null) {
      // `**` 段: 先把 "匹配零段" 入队, 再把现存子目录入队.
      queue.push({ current, index: index + 1 })
      if (isKeptDir(current)) continue
      let names: string[]
      try {
        names = readdirSync(current)
      } catch {
        continue
      }
      for (const name of names) {
        const child = `${current}/${name}`
        if (statIsDir(child) !== true) continue
        if (isKeptDir(child)) continue
        queue.push({ current: child, index })
      }
      continue
    }
    if (isLiteralSegment(segment)) {
      const next = `${current}/${segment}`
      if (!last) {
        if (statIsDir(next) === true && !isKeptDir(next)) queue.push({ current: next, index: index + 1 })
        continue
      }
      const isDir = statIsDir(next)
      if (isDir === null || (dirOnly && !isDir)) continue
      matches.push({ path: next, isDir })
      continue
    }
    if (isKeptDir(current)) continue
    let names: string[]
    try {
      names = readdirSync(current)
    } catch {
      continue
    }
    for (const name of names) {
      if (!matcher.test(name)) continue
      const next = `${current}/${name}`
      if (!last) {
        if (statIsDir(next) !== true) continue
        if (isKeptDir(next)) continue
        queue.push({ current: next, index: index + 1 })
        continue
      }
      const isDir = statIsDir(next)
      if (isDir === null || (dirOnly && !isDir)) continue
      matches.push({ path: next, isDir })
    }
  }
  return matches
}

function splitPosix(path: string): string[] {
  return path.split('/').filter(segment => segment.length > 0)
}

/**
 * 把配置文本针对一次调用的工作区根展开为 canonical 保护路径, 语义对齐
 * gitignore(5): 锚定字面条目不存在也保留; 其余条目只收集展开时刻已存在的
 * 路径 (之后新建的路径要等下次展开才纳入). 已经会被保护的目录不往里走;
 * 命中工作区根本身的条目 (如 `.`, 裸 `**`) 会把根自己作为围栏起点列出来.
 * @param text - gitignore 语义的配置文本.
 * @param workspaceRoot - 本次调用的工作区根.
 * @returns canonical 保护路径 (去重) 与告警列表.
 */
export function expandReadOnlyPaths(text: string, workspaceRoot: string): ExpandResult {
  const warnings: string[] = []
  const entries = parsePatternLines(text)
  const compiledEntries = entries.map(entry => compileEntry(entry))
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
      candidates.push({ path, isDir: statIsDir(path) })
      continue
    }
    candidates.push(...collectGlobMatches(
      compiled.effective.slice(0, end),
      compiled.matchers.slice(0, end),
      entry.dirOnly || end < compiled.effective.length,
      start,
      compiledEntries,
      workspaceRoot,
    ))
  }

  // 工作区根本身单独看一次: 上面枚举的是"条目命中的候选", 而 `.` 与 `**` 这类
  // 条目命中的正是根本身 (其段序列为空, 只有 `**` 能匹配), 这里把它显式并进来,
  // 让"整个工作区被保护"在枚举清单上也有对应的围栏起点.
  const canonicalRoot = canonicalPath(workspaceRoot)
  if (lastMatchKeeps({ path: canonicalRoot, isDir: true }, compiledEntries, workspaceRoot)) {
    candidates.push({ path: canonicalRoot, isDir: true })
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

/**
 * 未转义的 glob 元字符: 额外可写根是字面路径, 命中则拒绝该行.
 * `\` 只在把它当转义符的平台 (POSIX) 上跳过下一字符; Windows 上它是分隔符,
 * 其后的 `*` / `?` / `[` 同样算元字符.
 */
function hasUnescapedGlobMeta(line: string, backslashEscapes: boolean): boolean {
  for (let index = 0; index < line.length; index += 1) {
    if (backslashEscapes && line[index] === '\\') {
      index += 1
      continue
    }
    const ch = line[index]
    if (ch === '*' || ch === '?' || ch === '[') return true
  }
  return false
}

/** canonical 路径是否就是文件系统根 (POSIX `/` 或 Windows 盘符根). */
function isFilesystemRoot(path: string, api: PlatformPath): boolean {
  const canonical = canonicalPath(path)
  return canonical === api.parse(canonical).root
}

/** 词法包含: extra 可写根若已落在工作区内则没有放宽效果. */
function isLexicallyUnderRoot(path: string, root: string, separator: string, caseSensitive: boolean): boolean {
  const comparablePath = caseSensitive ? path : path.toLowerCase()
  const comparableRoot = caseSensitive ? root : root.toLowerCase()
  if (comparablePath === comparableRoot) return true
  const prefix = comparableRoot.endsWith(separator) ? comparableRoot : comparableRoot + separator
  return comparablePath.startsWith(prefix)
}

/** 盘符相对路径 (`C:foo`): Windows 上按"该盘当时的当前目录"解析, 落点不可预期. */
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/

/**
 * 把额外可写配置文本展开为 canonical 根. 与保护路径不同, 这里是字面路径
 * 列表而不是 gitignore glob: 行首 `~` / `~/...` 展开为当前用户家目录,
 * `$NAME` / `${NAME}` 展开为环境变量; `//` 或宿主绝对路径按文件系统解析,
 * 其余相对当前工作区 (含 `..`). 工作区内的条目没有放宽效果, 文件系统根
 * 拒绝; 不存在的路径仍保留词法形态 (fs / Seatbelt 可按前缀放行, bwrap /
 * Landlock 在叠加时跳过). Windows 上盘符相对路径 (`C:caches`) 拒绝 —— 它的
 * 落点取决于进程当前目录, 会静默给出调用方从未指定的可写根.
 * @param text - 逐行一条字面路径的配置文本.
 * @param workspaceRoot - 本次调用的工作区根.
 * @param options - 平台与家目录覆盖, 缺省按当前进程与当前用户.
 * @returns canonical 额外可写根 (去重) 与告警列表.
 */
export function expandWritablePaths(
  text: string,
  workspaceRoot: string,
  options: PathExpandOptions = {},
): ExpandResult {
  const platform = options.platform ?? process.platform
  const api = pathApiOf(platform)
  const backslashEscapes = escapesWithBackslash(platform)
  const caseSensitive = platform !== 'win32'
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
    const expanded = expandTildeAndEnv(line, options)
    if ('error' in expanded) {
      warnings.push(`writable path "${line}" ${expanded.error}`)
      continue
    }
    if (platform === 'win32' && DRIVE_RELATIVE.test(expanded.ok)) {
      warnings.push(`writable path "${line}" is drive-relative and has no fixed target; write the drive root explicitly, e.g. "${expanded.ok.slice(0, 2)}\\${expanded.ok.slice(2)}"`)
      continue
    }
    if (hasUnescapedGlobMeta(expanded.ok, backslashEscapes)) {
      warnings.push(`writable path "${line}" contains glob metacharacters; extra writable roots must be literal paths`)
      continue
    }

    let resolved: string
    if (expanded.ok.startsWith('//')) {
      resolved = api.resolve('/', expanded.ok.slice(2))
    } else if (api.isAbsolute(expanded.ok)) {
      resolved = api.resolve(expanded.ok)
    } else {
      resolved = api.resolve(workspaceRoot, expanded.ok)
    }

    if (isFilesystemRoot(resolved, api)) {
      warnings.push(`writable path "${line}" resolves to the filesystem root and is rejected`)
      continue
    }
    const canonical = canonicalPath(resolved)
    if (isLexicallyUnderRoot(canonical, workspaceCanonical, api.sep, caseSensitive)) {
      warnings.push(`writable path "${line}" is already inside the workspace and is ignored`)
      continue
    }
    if (seen.has(canonical)) continue
    seen.add(canonical)
    paths.push(canonical)
  }
  return { paths, warnings }
}

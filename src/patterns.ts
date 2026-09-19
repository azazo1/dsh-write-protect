/**
 * 保护路径的**枚举展开**: 把 `gitignore.ts` 解析出的模式针对某个工作区根枚举成
 * 具体存在的路径, 供进程沙箱 (bwrap `--ro-bind` / Seatbelt `subpath`) 与提示词
 * 使用 —— 它们必须拿到真实路径. write / edit 围栏不走这里, 而是直接按模式逐路径
 * 判定 (`gitignore.ts` 的 `PatternSet.match`).
 *
 * 展开语义: 锚定字面条目是单一显式路径, 不存在也保留 (Seatbelt 对不存在路径同样
 * 有效); 其余条目枚举展开时刻已存在的路径 (新建路径要等下次重新展开才纳入);
 * 以 `/**` 结尾的条目按前缀围栏等价性保护其命名目录本身, 而不是枚举全部后代.
 * 遍历用 lstat, 不走进目录符号链接, 避免链到工作区外的大树
 * (如 `Applications -> /Applications`).
 * @module dsh-write-protect/patterns
 */

import { lstatSync, readdirSync, type Dirent } from 'node:fs'
import { resolve as resolvePath, type PlatformPath } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { compileEntry, isLiteralSegment, lastMatchKeeps, parsePatternLines, stripTrailingSpaces, toPosix, type Candidate, type CompiledEntry, type PatternEntry } from './gitignore.ts'
import { escapesWithBackslash, expandTildeAndEnv, pathApiOf, type PathExpandOptions } from './path-expand.ts'

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
 * 读取一个目录的条目 (含类型). readdir 已经带回条目类型, 绝大多数情况下不必
 * 再逐项 lstat. 读取失败按空目录处理.
 */
function readDirents(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 条目是否为目录 (lstat 语义: 指向目录的符号链接不算). readdir 在个别文件
 * 系统上返回未知类型, 此时回退到 lstat, 保证不因省 lstat 而漏掉目录.
 */
function direntIsDirectory(dirent: Dirent, path: string): boolean {
  if (dirent.isDirectory()) return true
  if (
    dirent.isFile() || dirent.isSymbolicLink() || dirent.isFIFO()
    || dirent.isSocket() || dirent.isBlockDevice() || dirent.isCharacterDevice()
  ) return false
  return statIsDir(path) === true
}

/**
 * 枚举一个条目在 `start` 下匹配的现有路径 (POSIX 形态词法路径). 按队列
 * 广度优先展开: `**` 段按零或多层目录展开, 字面段直接拼接并以存在性剪枝,
 * 其余段用 readdir 过滤 (非末段要求目录), 末段按 `dirOnly` 过滤.
 * 已经会被保护的目录不再往里走 (里面的后代本来也写不了); 被取反放行的
 * 目录还会继续找. 目录符号链接不进入.
 */
function walkGlobMatches(
  effective: readonly string[],
  matchers: readonly (RegExp | null)[],
  dirOnly: boolean,
  start: string,
  compiledEntries: readonly CompiledEntry[],
  workspaceRoot: string,
  push: (candidate: Candidate) => void,
): void {
  const isKeptDir = (path: string): boolean => lastMatchKeeps({ path, isDir: true }, compiledEntries, workspaceRoot)
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
      if (!isKeptDir(current)) {
        for (const dirent of readDirents(current)) {
          const child = `${current}/${dirent.name}`
          if (!direntIsDirectory(dirent, child)) continue
          if (isKeptDir(child)) continue
          queue.push({ current: child, index })
        }
      }
    } else if (isLiteralSegment(segment)) {
      const next = `${current}/${segment}`
      if (!last) {
        if (statIsDir(next) === true && !isKeptDir(next)) queue.push({ current: next, index: index + 1 })
      } else {
        const isDir = statIsDir(next)
        if (isDir !== null && (!dirOnly || isDir)) push({ path: next, isDir })
      }
    } else if (!isKeptDir(current)) {
      for (const dirent of readDirents(current)) {
        if (!matcher.test(dirent.name)) continue
        const next = `${current}/${dirent.name}`
        if (!last) {
          if (!direntIsDirectory(dirent, next)) continue
          if (isKeptDir(next)) continue
          queue.push({ current: next, index: index + 1 })
        } else {
          const isDir = statIsDir(next)
          if (isDir !== null && (!dirOnly || isDir)) push({ path: next, isDir })
        }
      }
    }
  }
}

/** 一次展开里, 一个非取反条目的执行计划: 直接候选或一次广度优先遍历. */
type EntryPlan =
  | { readonly kind: 'direct', readonly candidate: Candidate }
  | { readonly kind: 'walk', readonly run: (push: (candidate: Candidate) => void) => void }

/** 把非取反条目编译为执行计划, 顺序与配置文本一致 (last-match-wins 依赖它). */
function planEntries(
  entries: readonly PatternEntry[],
  compiledEntries: readonly CompiledEntry[],
  workspaceRoot: string,
): EntryPlan[] {
  const plans: EntryPlan[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.negated) continue
    const compiled = compiledEntries[index]!
    const start = entry.fsAbsolute ? '/' : toPosix(workspaceRoot)
    let end = compiled.effective.length
    while (end > 0 && compiled.effective[end - 1] === '**') end -= 1
    if (end === 0) {
      // `/**` (含裸 `**`): 前缀围栏下保护起始根本身.
      plans.push({ kind: 'direct', candidate: { path: start, isDir: true } })
      continue
    }
    if (
      (entry.anchored || entry.fsAbsolute)
      && compiled.effective.every(segment => isLiteralSegment(segment))
    ) {
      // 锚定字面条目: 单一显式路径, 不存在也保留词法形态.
      const path = resolvePath(entry.fsAbsolute ? '/' : workspaceRoot, entry.fsAbsolute ? `/${compiled.effective.join('/')}` : compiled.effective.join('/'))
      plans.push({ kind: 'direct', candidate: { path, isDir: statIsDir(path) } })
      continue
    }
    const effective = compiled.effective.slice(0, end)
    const matchers = compiled.matchers.slice(0, end)
    const dirOnly = entry.dirOnly || end < compiled.effective.length
    plans.push({
      kind: 'walk',
      run: push => walkGlobMatches(effective, matchers, dirOnly, start, compiledEntries, workspaceRoot, push),
    })
  }
  return plans
}

/** 候选去重 + canonical 化, 再按 last-match-wins 裁决去留. */
function finalizeExpansion(
  candidates: readonly Candidate[],
  compiledEntries: readonly CompiledEntry[],
  workspaceRoot: string,
): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!lastMatchKeeps(candidate, compiledEntries, workspaceRoot)) continue
    const canonical = canonicalPath(candidate.path)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    paths.push(canonical)
  }
  return paths
}

/**
 * 把配置文本针对一次调用的工作区根展开为 canonical 保护路径, 语义对齐
 * gitignore(5): 锚定字面条目不存在也保留; 其余条目只收集展开时刻已存在的
 * 路径 (之后新建的路径要等下次展开才纳入). 已经会被保护的目录不往里走.
 * @param text - gitignore 语义的配置文本.
 * @param workspaceRoot - 本次调用的工作区根.
 * @returns canonical 保护路径 (去重) 与告警列表.
 */
export function expandReadOnlyPaths(text: string, workspaceRoot: string): ExpandResult {
  const warnings: string[] = []
  const entries = parsePatternLines(text)
  const compiledEntries = entries.map(entry => compileEntry(entry))
  const plans = planEntries(entries, compiledEntries, workspaceRoot)
  const candidates: Candidate[] = []

  for (const plan of plans) {
    if (plan.kind === 'direct') {
      candidates.push(plan.candidate)
      continue
    }
    plan.run(candidate => candidates.push(candidate))
  }

  return { paths: finalizeExpansion(candidates, compiledEntries, workspaceRoot), warnings }
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

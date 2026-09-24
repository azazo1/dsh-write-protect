/**
 * 保护路径的**枚举展开**: 把 `gitignore.ts` 解析出的模式针对某个工作区根枚举成
 * 具体存在的路径, 供进程沙箱 (bwrap `--ro-bind` / Seatbelt `subpath`) 与设置页
 * 预览使用 —— 它们必须拿到真实路径. write / edit 围栏和提示词不走这里: 前者按
 * 模式逐路径判定 (`gitignore.ts` 的 `PatternSet.match`), 后者直接给出模式原文.
 *
 * 展开语义: 锚定字面条目是单一显式路径, 不存在也保留 (Seatbelt 对不存在路径同样
 * 有效); 其余条目枚举展开时刻已存在的路径 (新建路径要等下次重新展开才纳入);
 * 以 `/**` 结尾的条目按前缀围栏等价性保护其命名目录本身, 而不是枚举全部后代.
 * 遍历用 lstat, 不走进目录符号链接, 避免链到工作区外的大树
 * (如 `Applications -> /Applications`).
 *
 * 遍历是异步的 (`fs.promises`), 每次 readdir / lstat 都会把事件循环让出去.
 * `policy.resolve()` 是同步契约, 不能在这里等完整结果; 由 `materialize()` /
 * 预览 / `confine()` 这些已经是 async 的入口来 await. 额外可写根与可写申请
 * 共用的单条字面路径解析在 `resolveLiteralPath()`.
 * @module dsh-write-protect/patterns
 */

import { type Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { resolve as resolvePath, type PlatformPath } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { compileEntry, isLiteralSegment, lastMatchKeeps, parsePatternLines, stripTrailingSpaces, toPosix, type Candidate, type CompiledEntry, type PatternEntry } from './gitignore.ts'
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
async function statIsDir(path: string): Promise<boolean | null> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return null
  }
}

/**
 * 读取一个目录的条目 (含类型). readdir 已经带回条目类型, 绝大多数情况下不必
 * 再逐项 lstat. 读取失败按空目录处理.
 */
async function readDirents(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 条目是否为目录 (lstat 语义: 指向目录的符号链接不算). readdir 在个别文件
 * 系统上返回未知类型, 此时回退到 lstat, 保证不因省 lstat 而漏掉目录.
 */
async function direntIsDirectory(dirent: Dirent, path: string): Promise<boolean> {
  if (dirent.isDirectory()) return true
  if (
    dirent.isFile() || dirent.isSymbolicLink() || dirent.isFIFO()
    || dirent.isSocket() || dirent.isBlockDevice() || dirent.isCharacterDevice()
  ) return false
  return await statIsDir(path) === true
}

/**
 * 枚举一个条目在 `start` 下匹配的现有路径 (POSIX 形态词法路径). 按队列
 * 广度优先展开: `**` 段按零或多层目录展开, 字面段直接拼接并以存在性剪枝,
 * 其余段用 readdir 过滤 (非末段要求目录), 末段按 `dirOnly` 过滤.
 * 已经会被保护的目录不再往里走 (里面的后代本来也写不了); 被取反放行的
 * 目录还会继续找. 目录符号链接不进入.
 */
async function walkGlobMatches(
  effective: readonly string[],
  matchers: readonly (RegExp | null)[],
  dirOnly: boolean,
  start: string,
  compiledEntries: readonly CompiledEntry[],
  workspaceRoot: string,
  push: (candidate: Candidate) => void,
): Promise<void> {
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
        for (const dirent of await readDirents(current)) {
          const child = `${current}/${dirent.name}`
          if (!await direntIsDirectory(dirent, child)) continue
          if (isKeptDir(child)) continue
          queue.push({ current: child, index })
        }
      }
    } else if (isLiteralSegment(segment)) {
      const next = `${current}/${segment}`
      if (!last) {
        if ((await statIsDir(next)) === true && !isKeptDir(next)) queue.push({ current: next, index: index + 1 })
      } else {
        const isDir = await statIsDir(next)
        if (isDir !== null && (!dirOnly || isDir)) push({ path: next, isDir })
      }
    } else if (!isKeptDir(current)) {
      for (const dirent of await readDirents(current)) {
        if (!matcher.test(dirent.name)) continue
        const next = `${current}/${dirent.name}`
        if (!last) {
          if (!await direntIsDirectory(dirent, next)) continue
          if (isKeptDir(next)) continue
          queue.push({ current: next, index: index + 1 })
        } else {
          const isDir = await statIsDir(next)
          if (isDir !== null && (!dirOnly || isDir)) push({ path: next, isDir })
        }
      }
    }
  }
}

/** 一次展开里, 一个非取反条目的执行计划: 直接候选或一次广度优先遍历. */
type EntryPlan =
  | { readonly kind: 'direct', readonly candidate: Candidate }
  | { readonly kind: 'walk', readonly run: (push: (candidate: Candidate) => void) => Promise<void> }

/** 把非取反条目编译为执行计划, 顺序与配置文本一致 (last-match-wins 依赖它). */
async function planEntries(
  entries: readonly PatternEntry[],
  compiledEntries: readonly CompiledEntry[],
  workspaceRoot: string,
): Promise<EntryPlan[]> {
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
      plans.push({ kind: 'direct', candidate: { path, isDir: await statIsDir(path) } })
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
 * 路径 (之后新建的路径要等下次展开才纳入). 已经会被保护的目录不往里走;
 * 命中工作区根本身的条目 (如 `.`, 裸 `**`) 会把根自己作为围栏起点列出来.
 * @param text - gitignore 语义的配置文本.
 * @param workspaceRoot - 本次调用的工作区根.
 * @returns canonical 保护路径 (去重) 与告警列表.
 */
export async function expandReadOnlyPaths(text: string, workspaceRoot: string): Promise<ExpandResult> {
  const warnings: string[] = []
  const entries = parsePatternLines(text)
  const compiledEntries = entries.map(entry => compileEntry(entry))
  const plans = await planEntries(entries, compiledEntries, workspaceRoot)
  const candidates: Candidate[] = []

  for (const plan of plans) {
    if (plan.kind === 'direct') {
      candidates.push(plan.candidate)
      continue
    }
    await plan.run(candidate => candidates.push(candidate))
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

/** 单条字面路径的解析结果. */
export interface LiteralPathResolution {
  /**
   * canonical 目标路径 (一定是绝对形态); 行本身非法 (空行, 注释, 通配符, 家目录或
   * 环境变量展开失败, 盘符相对路径, 文件系统根) 时为 undefined.
   */
  readonly path?: string
  /** 行级告警: 非法原因, 或"该条目已经落在工作区内". */
  readonly warnings: readonly string[]
  /** 目标是否落在工作区内 (作为额外可写根时没有放宽效果). */
  readonly insideWorkspace: boolean
}

/**
 * 解析一行字面路径 (额外可写根与可写申请共用同一套规则): 展开 `~` / `~/...` 与
 * `$NAME` / `${NAME}`, `//` 与宿主绝对路径按文件系统解析, 其余 (含 `..`) 相对
 * 工作区根解析, 最后 canonical 化.
 *
 * 工作区内的条目也会给出绝对目标 (外加一条告警), 由调用方决定是当成"没有放宽效果"
 * 忽略掉 (额外可写根), 还是当成受保护路径继续受理 (可写申请). 相对条目必须在这里
 * 就按工作区根定死: canonical 化对相对且不存在的路径会原样返回相对形态, 拿它做
 * 包含判定会一路判错.
 * @param line - 一行字面路径 (允许前后空白).
 * @param workspaceRoot - 相对条目与工作区判定的基准.
 * @param options - 平台与家目录覆盖, 缺省按当前进程与当前用户.
 * @returns 目标路径 (或 undefined), 告警, 以及是否落在工作区内.
 */
export function resolveLiteralPath(
  line: string,
  workspaceRoot: string,
  options: PathExpandOptions = {},
): LiteralPathResolution {
  const platform = options.platform ?? process.platform
  const api = pathApiOf(platform)
  const backslashEscapes = escapesWithBackslash(platform)
  const caseSensitive = platform !== 'win32'
  const reject = (warning: string): LiteralPathResolution => ({ warnings: [warning], insideWorkspace: false })
  const trimmed = stripTrailingSpaces(line)
  if (trimmed.length === 0 || trimmed.startsWith('#')) return { warnings: [], insideWorkspace: false }
  if (trimmed.startsWith('!')) {
    return reject(`writable path "${trimmed}" uses ! negation; extra writable roots are a literal list`)
  }
  const expanded = expandTildeAndEnv(trimmed, options)
  if ('error' in expanded) return reject(`writable path "${trimmed}" ${expanded.error}`)
  if (platform === 'win32' && DRIVE_RELATIVE.test(expanded.ok)) {
    return reject(`writable path "${trimmed}" is drive-relative and has no fixed target; write the drive root explicitly, e.g. "${expanded.ok.slice(0, 2)}\\${expanded.ok.slice(2)}"`)
  }
  if (hasUnescapedGlobMeta(expanded.ok, backslashEscapes)) {
    return reject(`writable path "${trimmed}" contains glob metacharacters; extra writable roots must be literal paths`)
  }
  const resolved = expanded.ok.startsWith('//')
    ? api.resolve('/', expanded.ok.slice(2))
    : api.isAbsolute(expanded.ok) ? api.resolve(expanded.ok) : api.resolve(workspaceRoot, expanded.ok)
  if (isFilesystemRoot(resolved, api)) {
    return reject(`writable path "${trimmed}" resolves to the filesystem root and is rejected`)
  }
  const canonical = canonicalPath(resolved)
  const insideWorkspace = isLexicallyUnderRoot(canonical, canonicalPath(workspaceRoot), api.sep, caseSensitive)
  return {
    path: canonical,
    warnings: insideWorkspace ? [`writable path "${trimmed}" is already inside the workspace and is ignored`] : [],
    insideWorkspace,
  }
}

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
  const warnings: string[] = []
  const paths: string[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const resolution = resolveLiteralPath(rawLine, workspaceRoot, options)
    warnings.push(...resolution.warnings)
    // 工作区内的条目没有放宽效果: 路径照旧在 resolution 里给出, 这里只收外部的.
    if (resolution.path === undefined || resolution.insideWorkspace) continue
    if (seen.has(resolution.path)) continue
    seen.add(resolution.path)
    paths.push(resolution.path)
  }
  return { paths, warnings }
}

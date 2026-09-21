/**
 * 工作区只读规则文件: 在工作区根读一份 gitignore 语义的规则文件 (默认名
 * `.readonly`, 名字由配置决定), 校验后合并进生效的保护路径文本.
 *
 * 与设置页文本的区别只有来源: 内容是同一套语义 (`gitignore.ts` 解析), 逐行
 * 追加在设置页文本之后, 因此规则文件既可以用 `!` 放行设置页里的条目, 也可以
 * 自己新增条目. 规则文件只在工作区根一份, 不做逐目录嵌套.
 *
 * 安全约束:
 *   - 只接受普通文件: 符号链接一律拒绝, 否则规则来源可以被链到工作区外由他人
 *     改写; 打开后按文件描述符再确认一次类型, 消掉 open 与判定之间的替换窗口.
 *   - `//` 绝对路径条目拒绝: 规则文件是工作区里的内容, 不允许它去声明工作区外
 *     的宿主路径 (那是设置页与部署配置的职责).
 *   - 解析结果越出工作区的条目拒绝.
 *   - 条目数上限截断, 避免一份异常大的文件拖慢每次写入判定.
 *
 * 读取是同步的 (与 protections 的既有展开同一形态: `policy.resolve()` 是同步
 * 契约, 设置页预览与 write/edit 围栏都在同步路径上). 按 (工作区根, 文件名) 缓存,
 * 缓存不在 TTL 内时由下一次读取刷新, 因此规则文件改完的下一步判定就按新内容走.
 * @module dsh-write-protect/readonly-file
 */

import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { parsePatternLines, type PatternEntry } from './gitignore.ts'
/** 规则文件缓存的有效时长: 同步读取放在判定路径上, 不能每次都碰磁盘. */
const FILE_TTL_MS = 1000

/** 规则文件的解析结果: 可直接拼接的原文, 逐条模式, 以及未生效原因. */
export interface ReadOnlyFile {
  /** 规则文件是否存在 (不存在不是错误). */
  readonly present: boolean
  /** canonical 文件路径; 文件不存在时为预期的路径, 仅供提示. */
  readonly path: string
  /** 通过校验的条目原文, 逐行 (可直接拼接进生效文本). */
  readonly text: string
  /** 解析出来的条目 (原文形态, 用于预览与日志). */
  readonly entries: readonly string[]
  /** 被拒绝或截断的条目说明. */
  readonly warnings: readonly string[]
}

/** 关闭识别或还没读到时的空结果. */
export const EMPTY_READ_ONLY_FILE: ReadOnlyFile = {
  present: false,
  path: '',
  text: '',
  entries: [],
  warnings: [],
}

/**
 * 同步读一次规则文件并校验.
 * @param workspaceRoot - 工作区根, 条目相对它解析.
 * @param fileName - 规则文件名 (调用方已按 `isValidReadonlyFileName` 校验).
 * @param maxEntries - 条目数上限, 超出的条目丢弃并告警.
 */
export function readReadOnlyFile(
  workspaceRoot: string,
  fileName: string,
  maxEntries: number,
): ReadOnlyFile {
  const target = resolvePath(workspaceRoot, fileName)
  const warnings: string[] = []
  const notRegular = {
    present: false,
    path: target,
    text: '',
    entries: [],
    warnings: [`read-only rules file "${target}" is not a regular file (symbolic links are refused); ignored`],
  }
  let fd: number
  try {
    // 先按 lstat 看这条路径本身: `open` 会跟随符号链接, 拿到的会是链接目标的
    // 类型, 于是"把规则文件链到工作区外"就能绕过普通文件检查.
    if (!lstatSync(target).isFile()) return notRegular
    fd = openSync(target, 'r')
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { present: false, path: target, text: '', entries: [], warnings }
    return {
      present: false,
      path: target,
      text: '',
      entries: [],
      warnings: [`read-only rules file "${target}" cannot be read (${code ?? String(error)}); ignored`],
    }
  }
  try {
    // 再确认一次描述符指向的确实是普通文件: lstat 与 open 之间被换成符号链接的
    // 窗口就此消掉.
    if (!fstatSync(fd).isFile()) return notRegular
    const content = readFileSync(fd, { encoding: 'utf8' })
    return parseReadOnlyFile(content, target, workspaceRoot, maxEntries, warnings)
  } catch (error: unknown) {
    return {
      present: false,
      path: target,
      text: '',
      entries: [],
      warnings: [`read-only rules file "${target}" cannot be read (${error instanceof Error ? error.message : String(error)}); ignored`],
    }
  } finally {
    try {
      closeSync(fd)
    } catch {
      // 关闭失败不影响读取结果.
    }
  }
}

/**
 * 解析规则文件正文: 逐行复用 gitignore 解析器, 逐条做绝对路径与越界校验.
 * @param content - 文件正文.
 * @param target - 规范化的文件路径 (告警定位用).
 * @param workspaceRoot - 工作区根.
 * @param maxEntries - 条目数上限.
 * @param warnings - 追加告警的数组 (调用方持有).
 */
function parseReadOnlyFile(
  content: string,
  target: string,
  workspaceRoot: string,
  maxEntries: number,
  warnings: string[],
): ReadOnlyFile {
  const entries: string[] = []
  let truncated = 0
  for (const parsed of parsePatternLines(content)) {
    if (parsed.fsAbsolute) {
      warnings.push(`read-only rules file "${target}": ${JSON.stringify(parsed.source)} is a filesystem-absolute entry; only workspace-relative entries are accepted`)
      continue
    }
    if (escapesWorkspace(parsed.segments)) {
      warnings.push(`read-only rules file "${target}": ${JSON.stringify(parsed.source)} escapes the workspace; ignored`)
      continue
    }
    if (entries.length >= maxEntries) {
      truncated += 1
      continue
    }
    entries.push(formatEntry(parsed))
  }
  if (truncated > 0) {
    warnings.push(`read-only rules file "${target}": ${String(truncated)} entries beyond the limit of ${String(maxEntries)} were ignored`)
  }
  return { present: true, path: target, text: entries.join('\n'), entries, warnings }
}

/**
 * 条目是否指向工作区之外: 只看 `..` 段 (纯词法), 因此通配条目不会被误判 ——
 * 通配由匹配器与展开各自保证不越界, 而 `..` 会让模式落到工作区外的宿主路径上.
 */
function escapesWorkspace(segments: readonly string[]): boolean {
  return segments.some(segment => segment === '..')
}

/**
 * 把一条已解析的规则文件条目还原为配置行原文: `//` 绝对条目在解析阶段就被拒,
 * 因此这里只需处理 `!` 前缀, 锚定 `/` 与尾部 `/`. 还原出来的文本交给
 * `parsePatternLines` 会得到同一条条目, 因此逐条校验 / 过滤 / 拼接可以放心往返.
 * 锚定条目统一写成前导 `/` 形态 —— 对含中间 `/` 的条目而言这与原文等价但更明确.
 */
function formatEntry(entry: PatternEntry): string {
  const prefix = entry.negated ? '!' : ''
  return `${prefix}${entry.anchored ? '/' : ''}${entry.segments.join('/')}${entry.dirOnly ? '/' : ''}`
}

/** 缓存里一个工作区的规则文件结果 (文件名是 key 的一部分). */
interface CacheEntry {
  readonly at: number
  readonly fileName: string
  readonly file: ReadOnlyFile
}

/**
 * 按 (工作区根, 文件名) 缓存的规则文件读取器. 判定路径上是同步读取, 因此结果
 * 带一个短 TTL: TTL 内复用缓存, 过期后由下一次读取刷新, 并发请求天然合并.
 */
export class ReadOnlyFileCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly warned = new Set<string>()

  /**
   * @param maxEntries - 条目数上限.
   * @param onWarning - 告警回调 (每条告警只回调一次, 跨刷新去重).
   */
  constructor(
    private readonly maxEntries: number,
    private readonly onWarning: (message: string) => void = () => {},
  ) {}

  /** 缓存里仍然新鲜的规则文件; 没读过、换了文件名或已过期时返回 undefined. */
  peek(workspaceRoot: string, fileName: string): ReadOnlyFile | undefined {
    const entry = this.entries.get(workspaceRoot)
    if (entry === undefined || entry.fileName !== fileName) return undefined
    if (Date.now() - entry.at >= FILE_TTL_MS) return undefined
    return entry.file
  }

  /**
   * 取规则文件: 缓存新鲜就用缓存, 否则同步重读一次.
   * @param workspaceRoot - 工作区根.
   * @param fileName - 规则文件名.
   */
  read(workspaceRoot: string, fileName: string): ReadOnlyFile {
    const cached = this.peek(workspaceRoot, fileName)
    if (cached !== undefined) return cached
    const file = readReadOnlyFile(workspaceRoot, fileName, this.maxEntries)
    this.entries.set(workspaceRoot, { at: Date.now(), fileName, file })
    this.report(file)
    return file
  }

  /** 无条件重读一次 (设置页预览要看到刚写入磁盘的内容). */
  refresh(workspaceRoot: string, fileName: string): ReadOnlyFile {
    this.entries.delete(workspaceRoot)
    return this.read(workspaceRoot, fileName)
  }

  /** 工作区根上的缓存作废. */
  forget(workspaceRoot: string): void {
    this.entries.delete(workspaceRoot)
  }

  /** 告警按内容去重后转交回调, 避免每次刷新都重复刷屏. */
  private report(file: ReadOnlyFile): void {
    for (const warning of file.warnings) {
      if (this.warned.has(warning)) continue
      this.warned.add(warning)
      this.onWarning(warning)
    }
  }
}

/** 把规则文件原文与设置页文本合并为生效的保护路径文本. */
export function mergeReadOnlyText(settingsText: string, fileText: string): string {
  if (fileText.trim().length === 0) return settingsText
  if (settingsText.trim().length === 0) return fileText
  return `${settingsText}\n${fileText}`
}

/**
 * 保护路径拒绝所用的路径包含检查, 沿用官方 fs 围栏的两层策略
 * (`@deepseek-ai/dsh-fs-sandbox/containment`): canonical 拼写走词法快速路径;
 * 文件系统身份提供保守回退, 覆盖别名等价的根 (符号链接祖先, Windows 8.3
 * 短名与大小写). 官方模块未通过发布包的 exports 暴露, 故此处保留一份本地实现.
 * @module dsh-write-protect/containment
 */

import type { BigIntStats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, sep } from 'node:path'

const MISSING_CODES: ReadonlySet<NodeJS.ErrnoException['code']> = new Set(['ENOENT', 'ENOTDIR'])

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return MISSING_CODES.has(code)
}

function comparablePath(path: string, caseSensitive: boolean): string {
  return caseSensitive ? path : path.toLowerCase()
}

function isLexicallyUnder(path: string, root: string, caseSensitive: boolean): boolean {
  const comparableTarget = comparablePath(path, caseSensitive)
  const comparableRoot = comparablePath(root, caseSensitive)
  if (comparableTarget === comparableRoot) return true
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep
  return comparableTarget.startsWith(prefix)
}

async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true })
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * 判断 canonical 目标是否就是某个保护根或位于其下. 词法快速路径处理常规
 * canonical 拼写; 拼写不同时沿目标已存在的祖先向上比较文件系统身份, 因此
 * 指向保护目录内部的符号链接仍会被拒绝, 而指向外部的则不会.
 * @param path - canonical 目标键, 末尾可能带有尚不存在的后缀.
 * @param root - canonical 保护路径.
 * @param caseSensitive - 词法比较是否区分大小写; 默认按宿主文件系统惯例.
 * @returns 目标是否为该根本身或其后代.
 */
export async function isPathUnder(
  path: string,
  root: string,
  caseSensitive = process.platform !== 'win32',
): Promise<boolean> {
  if (isLexicallyUnder(path, root, caseSensitive)) return true

  const rootInfo = await statIfPresent(root)
  if (!rootInfo) return false

  let ancestor = path
  while (true) {
    const ancestorInfo = await statIfPresent(ancestor)
    if (ancestorInfo && sameIdentity(ancestorInfo, rootInfo)) return true
    const parent = dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}

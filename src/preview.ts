/**
 * 把两份草稿文本展开为预览结果. 与 policy.resolve() 同一套解析器, 工作区根由
 * 调用方给出 (设置页预览优先用当前会话 cwd).
 *
 * 展开走异步完整版本: 预览的用途就是让用户看清"到底哪些路径生效", 用同步的
 * 短预算会把深层匹配悄悄截掉; HTTP handler 可以 await, 分片遍历也不会阻塞
 * Host (到异步预算 / 时间上限时截断, 并在 warnings 里说明).
 * @module dsh-write-protect/preview
 */

import type { PathPreview } from './constants.ts'
import { expandReadOnlyPathsAsync, expandWritablePaths } from './patterns.ts'

/**
 * 展开保护路径与额外可写根, 供设置页人工核对生效/未生效条目.
 * @param patterns - gitignore 语义的保护路径文本.
 * @param writablePatterns - 字面路径的额外可写根文本.
 * @param workspaceRoot - 本次展开使用的工作区根.
 */
export async function previewPaths(
  patterns: string,
  writablePatterns: string,
  workspaceRoot: string,
): Promise<PathPreview> {
  const readOnly = await expandReadOnlyPathsAsync(patterns, workspaceRoot)
  const writable = expandWritablePaths(writablePatterns, workspaceRoot)
  return {
    workspaceRoot,
    readOnly: readOnly.paths,
    writable: writable.paths,
    warnings: [...readOnly.warnings, ...writable.warnings],
  }
}

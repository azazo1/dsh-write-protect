/**
 * 把两份草稿文本展开为预览结果. 与 policy.resolve() 同一套解析器,
 * 工作区根由调用方给出 (设置页预览用部署回退根).
 * @module dsh-write-protect/preview
 */

import type { PathPreview } from './constants.ts'
import { expandReadOnlyPaths, expandWritablePaths } from './patterns.ts'

/**
 * 展开保护路径与额外可写根, 供设置页人工核对生效/未生效条目.
 * @param patterns - gitignore 语义的保护路径文本.
 * @param writablePatterns - 字面路径的额外可写根文本.
 * @param workspaceRoot - 本次展开使用的工作区根.
 */
export function previewPaths(
  patterns: string,
  writablePatterns: string,
  workspaceRoot: string,
): PathPreview {
  const readOnly = expandReadOnlyPaths(patterns, workspaceRoot)
  const writable = expandWritablePaths(writablePatterns, workspaceRoot)
  return {
    workspaceRoot,
    readOnly: readOnly.paths,
    writable: writable.paths,
    warnings: [...readOnly.warnings, ...writable.warnings],
  }
}

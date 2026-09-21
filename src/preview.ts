/**
 * 把两份草稿文本展开为预览结果. 与 policy.resolve() 同一套解析器,
 * 工作区根由调用方给出 (设置页预览优先用当前会话 cwd).
 *
 * 预览还带上工作区只读规则文件的原文与本会话已批准的可写授权: 前者是生效保护
 * 路径的一部分来源, 后者解释了某条被保护的路径为什么现在写得进去.
 * @module dsh-write-protect/preview
 */

import type { PathPreview, ReadOnlyFilePreview } from './constants.ts'
import { expandReadOnlyPaths, expandWritablePaths } from './patterns.ts'
import { EMPTY_READ_ONLY_FILE, mergeReadOnlyText, type ReadOnlyFile } from './readonly-file.ts'
import type { Grant } from './request-writable-path.ts'

/**
 * 展开保护路径与额外可写根, 供设置页人工核对生效/未生效条目.
 * @param patterns - gitignore 语义的保护路径文本 (设置页草稿).
 * @param writablePatterns - 字面路径的额外可写根文本 (设置页草稿).
 * @param workspaceRoot - 本次展开使用的工作区根.
 * @param file - 工作区只读规则文件的读取结果.
 * @param grants - 本会话已批准的可写授权.
 */
export function previewPaths(
  patterns: string,
  writablePatterns: string,
  workspaceRoot: string,
  file: ReadOnlyFile = EMPTY_READ_ONLY_FILE,
  grants: readonly Grant[] = [],
): PathPreview {
  const readOnly = expandReadOnlyPaths(mergeReadOnlyText(patterns, file.text), workspaceRoot)
  const writable = expandWritablePaths(writablePatterns, workspaceRoot)
  const readOnlyFile: ReadOnlyFilePreview = {
    ...file.present ? { path: file.path } : {},
    patterns: file.text,
    warnings: file.warnings,
  }
  return {
    workspaceRoot,
    readOnly: readOnly.paths,
    writable: writable.paths,
    warnings: [...readOnly.warnings, ...writable.warnings],
    readOnlyFile,
    grants: grants.map(grant => ({ path: grant.path, kind: grant.kind })),
  }
}

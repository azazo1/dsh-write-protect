/**
 * 写保护的共享契约: 配置字段, 默认值, 以及把 `readOnlyPaths` 配置项解析为
 * canonical 绝对路径的推导. 三个执法半区 (policy, fs 围栏, 进程沙箱 provider)
 * 都从逐次调用的 policy 上读取同一份解析结果, 因此 CLI 沙箱与 write/edit
 * 工具的保护范围不会漂移.
 * @module dsh-write-protect/shared
 */

import { resolve as resolvePath } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'

/** 默认保护项: 仓库的 `.git` 目录. */
export const DEFAULT_READ_ONLY_PATHS: readonly string[] = ['.git']

/**
 * systemPrompt 中写保护提示的位置: 紧跟官方 sandbox-policy context (110),
 * 位于 approval context (115) 之前.
 */
export const PROMPT_CONTEXT_ORDER = 112

/**
 * 为逐次调用的沙箱 policy 追加解析后的保护路径. 官方 policy 类型不做改动,
 * 这个接口合并让每个消费方都能直接读 `policy.readOnlyPaths`, 无需再引入
 * 插件私有的 service.
 */
declare module '@deepseek-ai/dsh-sandbox' {
  interface SandboxExecutionPolicy {
    readOnlyPaths?: readonly string[]
  }
}

/**
 * 针对一次 policy 调用解析配置项. 相对路径锚定到本次调用的工作区根
 * (每个会话的工作区各自解析, `.git` 即该会话工作区下的 `.git`), 绝对路径
 * 原样使用; 所有结果都经过 `canonicalPath`, 与 writableRoots 推导交给
 * Seatbelt 过滤器和 fs 围栏比较的路径身份保持一致.
 * @param entries - 配置项, 相对或绝对; 空白项在此跳过 (policy 在加载时已拒绝).
 * @param workspaceRoot - 本次调用的工作区根.
 * @returns 去重后的 canonical 保护路径, 保持配置顺序.
 */
export function resolveReadOnlyPaths(entries: readonly string[], workspaceRoot: string): string[] {
  const resolved: string[] = []
  for (const entry of entries) {
    if (entry.trim().length === 0) continue
    resolved.push(canonicalPath(resolvePath(workspaceRoot, entry)))
  }
  return [...new Set(resolved)]
}

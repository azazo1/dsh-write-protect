/**
 * Client 半区入口: 在 Web Settings 注册独立的 "写入保护" 配置页. 通过
 * `settingsScope` 绑定 Host 的 {@link PLUGIN_ID} namespace (patterns 与
 * writablePatterns 字段), 页面保存的文本经 Host settings 持久化并实时生效;
 * base 层是 patch 配置的 `readOnlyPaths` / `writablePaths` 数组, 用户未保存
 * 过文本时页面展示 base.
 *
 * 构建产物是 CJS 形态的 loader 模块: tsdown 以 banner/footer 包裹为
 * `window.__ModuleLoader__.load({ id, factory: (require) => ... })`,
 * `require` 由 banner 注入, react 等外部模块经它解析.
 * @module dsh-write-protect/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PATTERNS_FIELD, PLUGIN_ID, WRITABLE_FIELD } from '../constants.ts'
import { mountWriteProtectSection, type WriteProtectScope } from './section.ts'

/** banner 注入的 loader require: react 等外部模块的唯一解析通道. */
declare const require: (id: string) => unknown

const React = require('react') as typeof import('react')

/** Host settings namespace 解码后的形状. 缺省字段不出现, 让 Host 走 base. */
export interface WriteProtectSettings {
  patterns?: string
  writablePatterns?: string
}

/** 未知 section 结构到类型化配置的解码; 异常结构回退 undefined (走 base 展示). */
export function decodeWriteProtectSettings(section: unknown): WriteProtectSettings | undefined {
  if (typeof section !== 'object' || section === null) return undefined
  const record = section as Record<string, unknown>
  const patterns = record[PATTERNS_FIELD]
  const writable = record[WRITABLE_FIELD]
  const decoded: WriteProtectSettings = {}
  if (typeof patterns === 'string') decoded.patterns = patterns
  if (typeof writable === 'string') decoded.writablePatterns = writable
  return decoded.patterns === undefined && decoded.writablePatterns === undefined ? undefined : decoded
}

/** 页面依赖的服务: settingsScope 提供配置通道, slots 提供注册面. */
export const inject = ['settingsScope', 'slots']

/** 注册独立配置页. */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<WriteProtectSettings>({
    namespace: PLUGIN_ID,
    decode: decodeWriteProtectSettings,
  }) as unknown as WriteProtectScope

  mountWriteProtectSection(ctx, React, scope)
}

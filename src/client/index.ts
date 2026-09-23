/**
 * Client 半区入口: 在 Web Settings 注册独立的 "写入保护" 配置页. 通过
 * `settingsScope` 绑定 Host 的 {@link PLUGIN_ID} namespace (patterns,
 * writablePatterns, hardenBroker, readonlyFileName, maxReadOnlyEntries 与
 * maxGrants 字段), 页面保存的值经 Host settings 持久化并实时生效; base 层是
 * patch 配置的 `readOnlyPaths` / `writablePaths` / `hardenBroker` /
 * `readonlyFileName` / `maxReadOnlyEntries` / `maxGrants`, 用户未保存过时页面
 * 展示 base.
 *
 * 构建产物是 CJS 形态的 loader 模块: tsdown 以 banner/footer 包裹为
 * `window.__ModuleLoader__.load({ id, factory: (require) => ... })`,
 * `require` 由 banner 注入, react 等外部模块经它解析.
 * @module dsh-write-protect/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ALLOW_REQUESTS_FIELD, HARDEN_BROKER_FIELD, MAX_GRANTS_FIELD, MAX_READONLY_ENTRIES_FIELD, PATTERNS_FIELD, PLUGIN_ID, READONLY_FILE_FIELD, WRITABLE_FIELD } from '../constants.ts'
import { mountWriteProtectSection, type WriteProtectScope } from './section.ts'
import { sessionCwdOf, type SessionsLike } from './session-cwd.ts'

/** banner 注入的 loader require: react 等外部模块的唯一解析通道. */
declare const require: (id: string) => unknown

const React = require('react') as typeof import('react')

/** Host settings namespace 解码后的形状. 缺省字段不出现, 让 Host 走 base. */
export interface WriteProtectSettings {
  readOnlyPaths?: string[]
  writablePaths?: string[]
  patterns?: string
  writablePatterns?: string
  hardenBroker?: boolean
  readonlyFileName?: string
  maxReadOnlyEntries?: number
  maxGrants?: number
  allowWritableRequests?: boolean
}

/** 未知 section 结构到类型化配置的解码; 异常结构回退 undefined (走 base 展示). */
export function decodeWriteProtectSettings(section: unknown): WriteProtectSettings | undefined {
  if (typeof section !== 'object' || section === null) return undefined
  const record = section as Record<string, unknown>
  const patterns = record[PATTERNS_FIELD]
  const writable = record[WRITABLE_FIELD]
  const readOnlyPaths = record.readOnlyPaths
  const writablePaths = record.writablePaths
  const hardenBroker = record[HARDEN_BROKER_FIELD]
  const readonlyFileName = record[READONLY_FILE_FIELD]
  const maxReadOnlyEntries = record[MAX_READONLY_ENTRIES_FIELD]
  const maxGrants = record[MAX_GRANTS_FIELD]
  const allowRequests = record[ALLOW_REQUESTS_FIELD]
  const decoded: WriteProtectSettings = {}
  if (Array.isArray(readOnlyPaths) && readOnlyPaths.every(item => typeof item === 'string')) {
    decoded.readOnlyPaths = readOnlyPaths
  }
  if (Array.isArray(writablePaths) && writablePaths.every(item => typeof item === 'string')) {
    decoded.writablePaths = writablePaths
  }
  if (typeof patterns === 'string') decoded.patterns = patterns
  if (typeof writable === 'string') decoded.writablePatterns = writable
  if (typeof hardenBroker === 'boolean') decoded.hardenBroker = hardenBroker
  if (typeof readonlyFileName === 'string') decoded.readonlyFileName = readonlyFileName
  if (typeof maxReadOnlyEntries === 'number') decoded.maxReadOnlyEntries = maxReadOnlyEntries
  if (typeof maxGrants === 'number') decoded.maxGrants = maxGrants
  if (typeof allowRequests === 'boolean') decoded.allowWritableRequests = allowRequests
  const empty = decoded.readOnlyPaths === undefined && decoded.writablePaths === undefined
    && decoded.patterns === undefined && decoded.writablePatterns === undefined && decoded.hardenBroker === undefined
    && decoded.readonlyFileName === undefined && decoded.maxReadOnlyEntries === undefined && decoded.maxGrants === undefined
    && decoded.allowWritableRequests === undefined
  return empty ? undefined : decoded
}

/** 页面依赖的服务: configForms 提供配置通道, slots 提供注册面, sessions 提供当前 cwd. */
export const inject = ['configForms', 'slots', 'sessions']

/** Policy host row id; ConfigForms is keyed by Loader entry id. */
const CONFIG_ENTRY_ID = 'dsh-write-protect-policy'

function sessionsOf(ctx: ClientContext): SessionsLike | undefined {
  return (ctx as ClientContext & { sessions?: SessionsLike }).sessions
}

/** 注册独立配置页. */
export function apply(ctx: ClientContext): void {
  const scope = ctx.configForms.get<WriteProtectSettings>(CONFIG_ENTRY_ID) as unknown as WriteProtectScope

  mountWriteProtectSection(ctx, React, scope, () => sessionCwdOf(sessionsOf(ctx)))
}

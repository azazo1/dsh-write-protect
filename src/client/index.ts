/**
 * Client 半区入口: 在插件页的 dsh-write-protect 卡片上注册写入保护配置.
 *
 * 表单绑定 Host 的 policy 条目 (`dsh-write-protect-policy`), 它承载 patterns,
 * writablePatterns, hardenBroker, readonlyFileName, maxReadOnlyEntries, maxGrants,
 * allowWritableRequests, watchProtectedPaths 与 watch 的两个间隔字段; 保存的值写进 profile
 * 的 patch 层并实时生效. `mode` 与 `workspaceRoot` 属于部署级字段, 仍只在 patch 层配置.
 *
 * 构建产物是 CJS 形态的 loader 模块: tsdown 以 banner/footer 包裹为
 * `window.__ModuleLoader__.load({ id, factory: (require) => ... })`,
 * `require` 由 banner 注入, react 等外部模块经它解析.
 * @module dsh-write-protect/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PLUGIN_ID } from '../constants.ts'
import { WriteProtectSettingsCard } from './card.tsx'
import { sessionCwdOf, type SessionsLike } from './session-cwd.ts'
import { WriteProtectSettingsForm, type WriteProtectSettings } from './settings-form.ts'
import { installStyles } from './styles.ts'

export type { WriteProtectSettings } from './settings-form.ts'

/** 页面依赖的服务: configForms 提供配置通道, slots 提供注册面, sessions 提供当前 cwd. */
export const inject = ['configForms', 'slots', 'sessions']

/** Policy host row id; ConfigForms is keyed by Loader entry id. */
const CONFIG_ENTRY_ID = 'dsh-write-protect-policy'

/** 取 sessions 服务 (可能缺席, 缺席时预览走部署回退根). */
function sessionsOf(ctx: ClientContext): SessionsLike | undefined {
  return (ctx as ClientContext & { sessions?: SessionsLike }).sessions
}

/** 注册插件页的配置卡片. */
export function apply(ctx: ClientContext): void {
  installStyles()
  const scope = ctx.configForms.get<WriteProtectSettings>(CONFIG_ENTRY_ID)
  const form = new WriteProtectSettingsForm(scope)

  ctx.effect(() => () => { form.dispose() }, 'dsh-write-protect: settings form')
  ctx.effect(() => ctx.configForms.whileServed([CONFIG_ENTRY_ID], () => ctx.slots.inject(
    'plugins.bundle.config',
    () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: PLUGIN_ID,
      inject: () => ({ ...form.inject(), workspaceRootOf: () => sessionCwdOf(sessionsOf(ctx)) }),
    }, WriteProtectSettingsCard),
  )), 'dsh-write-protect: plugins page card')
}

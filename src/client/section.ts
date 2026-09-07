/**
 * "写入保护" 独立配置页: gitignore 风格的多行文本编辑, 保存到 Host settings
 * namespace 并实时生效. 组件只负责自身内容, 导航与关闭由 settings shell 提供;
 * 样式使用 DSH 主题 token, 与 Settings 页面结构保持一致.
 * @module dsh-write-protect/client/section
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PATTERNS_FIELD, PLUGIN_ID } from '../constants.ts'

/** 组件对 settings scope 的最小结构视图 (避免耦合具体包的类型导出). */
export interface WriteProtectScope {
  subscribe(listener: () => void): () => void
  getSnapshot(): { value?: { patterns?: string } }
  set(field: string, value: string): unknown
}

/** 客户端注入的 React runtime 形状 (module loader 的预载模块). */
export interface ReactRuntime {
  createElement: typeof import('react').createElement
  useState: typeof import('react').useState
  useSyncExternalStore: typeof import('react').useSyncExternalStore
}

/** 页面收到的 props: settings shell 的 close 回调加上注入的 scope. */
export interface WriteProtectSectionProps {
  close?: () => void
  scope: WriteProtectScope
}

const STYLE_ID = 'dsh-write-protect-section'

const CSS_TEXT = `
.dsh-wp-section { max-width: 760px; display: flex; flex-direction: column; gap: 12px; }
.dsh-wp-title { margin: 0; font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-wp-desc { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.dsh-wp-card { display: flex; flex-direction: column; gap: 8px; background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 12px; }
.dsh-wp-textarea { width: 100%; min-height: 200px; box-sizing: border-box; resize: vertical; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.55; }
.dsh-wp-textarea:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-wp-hint { margin: 0; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-tertiary); }
.dsh-wp-hint code { font-family: inherit; color: var(--dsw-alias-label-primary); }
.dsh-wp-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l2); padding: 12px 0 4px; }
.dsh-wp-btn { height: 30px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; }
.dsh-wp-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dsh-wp-btn:disabled { opacity: 0.45; cursor: default; }
.dsh-wp-status { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
`

/** 注入页面样式 (data-plugin-css 标记防止重复插入). */
function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS_TEXT
  document.head.appendChild(tag)
}

/** 配置页组件: 订阅 scope 展示当前生效文本, 保存写回 Host. */
export function WriteProtectSection(
  React: ReactRuntime,
  props: WriteProtectSectionProps,
): ReturnType<ReactRuntime['createElement']> {
  const { scope } = props
  const { createElement, useState, useSyncExternalStore } = React
  const saved = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot().value?.patterns ?? '',
  )
  // null 表示没有本地编辑: 输入框展示 Host 侧的当前值.
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const value = draft ?? saved
  const dirty = draft !== null && draft !== saved

  const onSave = (): void => {
    if (draft === null) return
    setSaving(true)
    void Promise.resolve(scope.set(PATTERNS_FIELD, draft)).then(() => {
      setSaving(false)
      setDraft(null)
    })
  }

  return createElement(
    'section',
    { className: 'dsh-wp-section' },
    createElement('h2', { className: 'dsh-wp-title' }, '写入保护'),
    createElement(
      'p',
      { className: 'dsh-wp-desc' },
      '声明的路径对沙箱内的命令与 write/edit 工具只读, 读取不受影响. 相对路径按当前会话的工作区解析, 绝对路径原样生效; 保存后实时应用, 无需重启.',
    ),
    createElement(
      'div',
      { className: 'dsh-wp-card' },
      createElement('textarea', {
        className: 'dsh-wp-textarea',
        spellCheck: false,
        value,
        onChange: (event: { currentTarget: { value: string } }) => setDraft(event.currentTarget.value),
      }),
      createElement(
        'p',
        { className: 'dsh-wp-hint' },
        '每行一条路径, ', createElement('code', null, '#'), ' 开头是注释, ',
        createElement('code', null, '!'), ' 开头表示从保护中排除, 支持 ',
        createElement('code', null, '*'), ' 和 ', createElement('code', null, '**'),
        ' 通配 (通配只匹配已存在的路径). 示例: ',
        createElement('code', null, 'vendor'), ', ', createElement('code', null, 'secrets/*'),
        '. 清空全部条目即停用保护.',
      ),
      createElement(
        'div',
        { className: 'dsh-wp-actions' },
        createElement(
          'button',
          { className: 'dsh-wp-btn', disabled: !dirty || saving, onClick: onSave },
          saving ? '保存中...' : '保存',
        ),
        createElement(
          'button',
          {
            className: 'dsh-wp-btn',
            disabled: !dirty || saving,
            onClick: () => setDraft(null),
          },
          '放弃更改',
        ),
        createElement('span', { className: 'dsh-wp-status' }, dirty ? '有未保存的更改' : ''),
      ),
    ),
  )
}

/** 注册 settings.section slot, 把页面挂进 Web Settings 导航. */
export function mountWriteProtectSection(
  ctx: ClientContext,
  React: ReactRuntime,
  scope: WriteProtectScope,
): void {
  installStyles()
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: PLUGIN_ID,
      order: 100,
      label: '写入保护',
      inject: () => ({ scope }),
    },
    (props: WriteProtectSectionProps) => WriteProtectSection(React, props),
  ))
}

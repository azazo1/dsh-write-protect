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
import { HARDEN_BROKER_FIELD, PATTERNS_FIELD, PLUGIN_ID, PREVIEW_PATH, WRITABLE_FIELD, type PathPreview } from '../constants.ts'
import { WriteProtectPreviewPanel } from './preview-panel.ts'

/** 组件对 settings scope 的最小结构视图 (避免耦合具体包的类型导出). */
export interface WriteProtectScope {
  subscribe(listener: () => void): () => void
  getSnapshot(): { value?: { patterns?: string, writablePatterns?: string, hardenBroker?: boolean } }
  set(field: string, value: string | boolean): unknown
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
  /** 当前选中会话的 cwd; 没有选中会话时返回 undefined, 预览走部署回退根. */
  workspaceRootOf?: () => string | undefined
}

const STYLE_ID = 'dsh-write-protect-section'

const CSS_TEXT = `
.dsh-wp-section, .dsh-wp-edit { max-width: 760px; display: flex; flex-direction: column; gap: 12px; }
.dsh-wp-edit { max-width: none; }
.dsh-wp-title { margin: 0; font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-wp-desc { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.dsh-wp-card { display: flex; flex-direction: column; gap: 8px; background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 12px; }
.dsh-wp-card-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-wp-textarea { width: 100%; min-height: 200px; box-sizing: border-box; resize: vertical; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.55; }
.dsh-wp-textarea-sm { min-height: 120px; }
.dsh-wp-textarea:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-wp-hint { margin: 0; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-tertiary); }
.dsh-wp-hint code { font-family: inherit; color: var(--dsw-alias-label-primary); }
.dsh-wp-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l2); padding: 12px 0 4px; }
.dsh-wp-btn { height: 30px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; }
.dsh-wp-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dsh-wp-btn:disabled { opacity: 0.45; cursor: default; }
.dsh-wp-status { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-wp-list { margin: 0; padding: 0 0 0 18px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-primary); }
.dsh-wp-empty { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-wp-preview-label { margin: 8px 0 4px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-wp-toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dsh-wp-toggle input { width: 15px; height: 15px; margin: 0; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
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
  const { scope, workspaceRootOf } = props
  const { createElement, useState, useSyncExternalStore } = React
  const savedPatterns = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot().value?.patterns ?? '',
  )
  const savedWritable = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot().value?.writablePatterns ?? '',
  )
  const savedHarden = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot().value?.hardenBroker ?? true,
  )
  // null 表示没有本地编辑: 输入框展示 Host 侧的当前值.
  const [patternsDraft, setPatternsDraft] = useState<string | null>(null)
  const [writableDraft, setWritableDraft] = useState<string | null>(null)
  const [hardenDraft, setHardenDraft] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<'edit' | 'preview'>('edit')
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<PathPreview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const patternsValue = patternsDraft ?? savedPatterns
  const writableValue = writableDraft ?? savedWritable
  const hardenValue = hardenDraft ?? savedHarden
  const dirty = (patternsDraft !== null && patternsDraft !== savedPatterns)
    || (writableDraft !== null && writableDraft !== savedWritable)
    || (hardenDraft !== null && hardenDraft !== savedHarden)

  const onPreview = (): void => {
    setPreviewing(true)
    setPreviewError('')
    const workspaceRoot = workspaceRootOf?.()
    void fetch(PREVIEW_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        patterns: patternsValue,
        writablePatterns: writableValue,
        ...workspaceRoot === undefined ? {} : { workspaceRoot },
      }),
    }).then(async (response) => {
      const text = await response.text()
      if (text.length === 0) throw new Error(`preview failed (${String(response.status)}, empty body)`)
      let payload: { error?: string } & Partial<PathPreview>
      try {
        payload = JSON.parse(text) as { error?: string } & Partial<PathPreview>
      } catch {
        throw new Error(`preview failed (${String(response.status)}): ${text.slice(0, 180)}`)
      }
      if (!response.ok) throw new Error(payload.error ?? `preview failed (${String(response.status)})`)
      if (typeof payload.workspaceRoot !== 'string' || !Array.isArray(payload.readOnly) || !Array.isArray(payload.writable) || !Array.isArray(payload.warnings)) {
        throw new Error('preview response is malformed')
      }
      const workspaceSource = payload.workspaceSource === 'session' || payload.workspaceSource === 'fallback'
        ? payload.workspaceSource
        : undefined
      setPreview({
        workspaceRoot: payload.workspaceRoot,
        workspaceSource,
        readOnly: payload.readOnly.filter(item => typeof item === 'string'),
        writable: payload.writable.filter(item => typeof item === 'string'),
        warnings: payload.warnings.filter(item => typeof item === 'string'),
      })
      setView('preview')
    }).catch((error: unknown) => {
      setPreviewError(error instanceof Error ? error.message : String(error))
    }).then(() => {
      setPreviewing(false)
    })
  }

  const onSave = (): void => {
    if (!dirty) return
    setSaving(true)
    const writes: Promise<unknown>[] = []
    if (patternsDraft !== null) writes.push(Promise.resolve(scope.set(PATTERNS_FIELD, patternsDraft)))
    if (writableDraft !== null) writes.push(Promise.resolve(scope.set(WRITABLE_FIELD, writableDraft)))
    if (hardenDraft !== null) writes.push(Promise.resolve(scope.set(HARDEN_BROKER_FIELD, hardenDraft)))
    void Promise.all(writes).then(() => {
      setSaving(false)
      setPatternsDraft(null)
      setWritableDraft(null)
      setHardenDraft(null)
    })
  }

  const editors = createElement(
    'div',
    { className: 'dsh-wp-edit' },
    createElement(
      'div',
      { className: 'dsh-wp-card' },
      createElement('h3', { className: 'dsh-wp-card-title' }, '保护路径'),
      createElement('textarea', {
        className: 'dsh-wp-textarea',
        spellCheck: false,
        value: patternsValue,
        onChange: (event: { currentTarget: { value: string } }) => setPatternsDraft(event.currentTarget.value),
      }),
      createElement(
        'p',
        { className: 'dsh-wp-hint' },
        '每行一条, ', createElement('code', null, '#'), ' 注释, 空行忽略; ',
        createElement('code', null, '!'), ' 排除 (按最后匹配生效, 受保护目录内部无法重新放行后代); 含 ',
        createElement('code', null, '/'), ' 的条目锚定工作区根, 其余匹配任意层级, ',
        createElement('code', null, '//'), ' 开头为文件系统绝对路径; 支持 ',
        createElement('code', null, '*'), ', ', createElement('code', null, '?'), ', ',
        createElement('code', null, '[...]'), ' 与独立成段的 ', createElement('code', null, '**'),
        ' 通配, 尾部 ', createElement('code', null, '/'), ' 仅匹配目录, ',
        createElement('code', null, '\\'), ' 转义下一字符. 通配只匹配已存在的路径. 示例: ',
        createElement('code', null, 'vendor'), ', ', createElement('code', null, 'secrets/*.pem'),
        ', ', createElement('code', null, '!secrets/example.pem'),
        '. 清空全部条目即停用保护.',
      ),
    ),
    createElement(
      'div',
      { className: 'dsh-wp-card' },
      createElement('h3', { className: 'dsh-wp-card-title' }, '额外可写根'),
      createElement('textarea', {
        className: 'dsh-wp-textarea dsh-wp-textarea-sm',
        spellCheck: false,
        value: writableValue,
        onChange: (event: { currentTarget: { value: string } }) => setWritableDraft(event.currentTarget.value),
      }),
      createElement(
        'p',
        { className: 'dsh-wp-hint' },
        '每行一条字面路径, 不要通配. ',
        createElement('code', null, '~'), ' / ', createElement('code', null, '~/...'),
        ' 为当前用户家目录, ', createElement('code', null, '$NAME'), ' / ', createElement('code', null, '${NAME}'),
        ' 为环境变量. 绝对路径按文件系统解析 (',
        createElement('code', null, '/tmp/extra'), ' 或 ', createElement('code', null, '//tmp/extra'),
        '), 相对路径 (含 ', createElement('code', null, '..'),
        ') 相对当前会话工作区. 工作区内的路径本来就可写, 会被忽略; 文件系统根会被拒绝. 保护路径仍然优先. 清空即不额外放行. Windows 上仅 write/edit 工具生效, bash 仍受官方 ACL 限制.',
      ),
    ),
    createElement(
      'div',
      { className: 'dsh-wp-card' },
      createElement('h3', { className: 'dsh-wp-card-title' }, 'macOS broker 逃逸加固'),
      createElement(
        'label',
        { className: 'dsh-wp-toggle' },
        createElement('input', {
          type: 'checkbox',
          checked: hardenValue,
          onChange: (event: { currentTarget: { checked: boolean } }) => setHardenDraft(event.currentTarget.checked),
        }),
        createElement('span', null, hardenValue ? '已启用' : '已关闭'),
      ),
      createElement(
        'p',
        { className: 'dsh-wp-hint' },
        'macOS 的 Seatbelt profile 是 ',
        createElement('code', null, '(allow default)'),
        ', 而在 launchd 代理下启动的进程不继承它 —— 沙箱内一条 ',
        createElement('code', null, 'open x.app'),
        ' 就能让命令在沙箱外任意读写, 绕开 ',
        createElement('code', null, 'deny file-write*'),
        ' (read-only 同样如此). 启用后在 profile 末尾追加拒绝 ',
        createElement('code', null, 'com.apple.coreservices'),
        ' / ',
        createElement('code', null, 'appleevent-send'),
        ' / ',
        createElement('code', null, 'mach-priv-task-port'),
        ', 只收紧不放宽; 常规命令 (node, git, pnpm 等) 不受影响. 关闭后按官方 profile 运行, 只在确需从沙箱内驱动宿主 GUI 时才关. 仅 macOS 生效.',
      ),
    ),
  )

  const status = previewError !== ''
    ? previewError
    : previewing
      ? '正在展开...'
      : dirty
        ? '有未保存的更改'
        : ''

  return createElement(
    'section',
    { className: 'dsh-wp-section' },
    createElement('h2', { className: 'dsh-wp-title' }, '写入保护'),
    createElement(
      'p',
      { className: 'dsh-wp-desc' },
      '保护路径对沙箱内的命令与 write/edit 工具只读; 额外可写根只在 workspace-write 下把工作区外的目录并进 allow-list, 不打穿 read-only. 保护路径优先. 保存后实时应用, 无需重启. 预览按当前会话 cwd 展开当前草稿, 不必先保存.',
    ),
    view === 'preview' && preview !== null ? WriteProtectPreviewPanel(React, preview) : editors,
    createElement(
      'div',
      { className: 'dsh-wp-actions' },
      view === 'preview'
        ? createElement(
          'button',
          { className: 'dsh-wp-btn', disabled: previewing, onClick: () => setView('edit') },
          '返回编辑',
        )
        : createElement(
          'button',
          { className: 'dsh-wp-btn', disabled: previewing || saving, onClick: onPreview },
          previewing ? '展开中...' : '预览',
        ),
      createElement(
        'button',
        { className: 'dsh-wp-btn', disabled: !dirty || saving || previewing, onClick: onSave },
        saving ? '保存中...' : '保存',
      ),
      createElement(
        'button',
        {
          className: 'dsh-wp-btn',
          disabled: !dirty || saving || previewing || view === 'preview',
          onClick: () => {
            setPatternsDraft(null)
            setWritableDraft(null)
            setHardenDraft(null)
          },
        },
        '放弃更改',
      ),
      createElement('span', { className: 'dsh-wp-status' }, status),
    ),
  )
}

/** 注册 settings.section slot, 把页面挂进 Web Settings 导航. */
export function mountWriteProtectSection(
  ctx: ClientContext,
  React: ReactRuntime,
  scope: WriteProtectScope,
  workspaceRootOf: () => string | undefined,
): void {
  installStyles()
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: PLUGIN_ID,
      order: 100,
      label: '写入保护',
      inject: () => ({ scope, workspaceRootOf }),
    },
    (props: WriteProtectSectionProps) => WriteProtectSection(React, props),
  ))
}

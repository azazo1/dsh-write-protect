/**
 * 配置卡片的样式: 字段行对齐官方 fields.module.css, 预览面板沿用原来的卡片语言.
 * 只用 --dsw-alias-* 语义 token, 由 data-plugin-css 标记防止重复插入.
 */

const STYLE_ID = 'dsh-write-protect-card'

const CSS_TEXT = `
.dsh-wp-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.dsh-wp-field + .dsh-wp-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-wp-head { display: flex; align-items: center; gap: 8px; }
.dsh-wp-label { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsh-wp-badges { display: inline-flex; align-items: center; gap: 8px; }
.dsh-wp-reset { padding: 0; border: none; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1.5; cursor: pointer; }
.dsh-wp-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dsh-wp-reset:disabled { cursor: default; }
.dsh-wp-hint { margin: 0; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-tertiary); }
.dsh-wp-invalid { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.dsh-wp-textarea { width: 100%; min-height: 96px; box-sizing: border-box; resize: vertical; padding: 10px 12px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.55; }
.dsh-wp-textarea:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-wp-textarea:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dsh-wp-textarea[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary); }
.dsh-wp-preview { display: flex; flex-direction: column; gap: 8px; padding: 12px 0 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-wp-preview-head { display: flex; align-items: center; gap: 8px; }
.dsh-wp-preview-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-wp-preview-button { height: 30px; padding: 0 14px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; }
.dsh-wp-preview-button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dsh-wp-preview-button:disabled { opacity: 0.45; cursor: default; }
.dsh-wp-card { display: flex; flex-direction: column; gap: 8px; background: var(--dsw-alias-bg-layer-3); border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 12px; }
.dsh-wp-card-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-wp-list { margin: 0; padding: 0 0 0 18px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-primary); }
.dsh-wp-empty { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-wp-preview-label { margin: 8px 0 4px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-wp-tab { display: flex; flex-direction: column; gap: 10px; box-sizing: border-box; padding: 16px; overflow: auto; }
.dsh-wp-tab-head { display: flex; align-items: center; gap: 8px; }
.dsh-wp-tab-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsh-wp-button { flex: none; height: 30px; padding: 0 14px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; }
.dsh-wp-button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dsh-wp-button:disabled { opacity: 0.45; cursor: default; }
.dsh-wp-status { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-business-primary); }
.dsh-wp-warning { margin: 0; padding: 8px 10px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsh-wp-grants { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.dsh-wp-grant { display: flex; align-items: flex-start; gap: 8px; padding: 10px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-wp-grant-path { flex: 1; min-width: 0; overflow-wrap: anywhere; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsh-wp-grant-kind { flex: none; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsh-wp-grant-action { flex: none; padding: 0; border: none; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1.5; cursor: pointer; }
.dsh-wp-grant-action:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.dsh-wp-grant-action:disabled { opacity: 0.45; cursor: default; }
.dsh-wp-add { display: flex; align-items: center; gap: 8px; }
.dsh-wp-input { flex: 1; min-width: 0; height: 30px; box-sizing: border-box; padding: 0 10px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
.dsh-wp-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-wp-input:disabled { color: var(--dsw-alias-label-tertiary); }
`

/** 注入卡片样式一次; 重复调用为空操作. */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset['pluginCss'] = STYLE_ID
  style.textContent = CSS_TEXT
  document.head.appendChild(style)
}

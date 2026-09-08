/**
 * 设置页预览面板: 列出展开后的生效路径与未生效告警.
 * @module dsh-write-protect/client/preview-panel
 */

import type { PathPreview } from '../constants.ts'
import type { ReactRuntime } from './section.ts'

function pathList(
  React: ReactRuntime,
  items: readonly string[],
  empty: string,
): ReturnType<ReactRuntime['createElement']> {
  const { createElement } = React
  if (items.length === 0) return createElement('p', { className: 'dsh-wp-empty' }, empty)
  return createElement(
    'ul',
    { className: 'dsh-wp-list' },
    ...items.map((item, index) => createElement('li', { key: `${String(index)}:${item}` }, item)),
  )
}

/** 渲染一份预览结果. */
export function WriteProtectPreviewPanel(
  React: ReactRuntime,
  preview: PathPreview,
): ReturnType<ReactRuntime['createElement']> {
  const { createElement } = React
  return createElement(
    'div',
    { className: 'dsh-wp-card' },
    createElement('h3', { className: 'dsh-wp-card-title' }, '预览'),
    createElement(
      'p',
      { className: 'dsh-wp-hint' },
      '工作区根: ',
      createElement('code', null, preview.workspaceRoot),
      '. 相对条目按此根解析; 会话 cwd 不同时, 实际执法以该会话为准.',
    ),
    createElement('p', { className: 'dsh-wp-preview-label' }, `保护路径 (${String(preview.readOnly.length)})`),
    pathList(React, preview.readOnly, '无生效保护路径'),
    createElement('p', { className: 'dsh-wp-preview-label' }, `额外可写根 (${String(preview.writable.length)})`),
    pathList(React, preview.writable, '无额外可写根'),
    createElement('p', { className: 'dsh-wp-preview-label' }, `未生效 (${String(preview.warnings.length)})`),
    pathList(React, preview.warnings, '没有被忽略或拒绝的行'),
  )
}

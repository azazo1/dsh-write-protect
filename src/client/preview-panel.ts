/**
 * 设置页预览面板: 列出展开后的生效路径与未生效告警, 以及工作区只读规则文件与
 * 本会话已批准的可写授权.
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
  const rulesFile = preview.readOnlyFile
  const grants = preview.grants ?? []
  return createElement(
    'div',
    { className: 'dsh-wp-card' },
    createElement('h3', { className: 'dsh-wp-card-title' }, '预览'),
    createElement(
      'p',
      { className: 'dsh-wp-hint' },
      '工作区根: ',
      createElement('code', null, preview.workspaceRoot),
      preview.workspaceSource === 'session'
        ? '. 相对条目按当前会话 cwd 解析.'
        : '. 未选中会话, 按部署回退根解析; 打开会话后再预览会对该会话生效.',
    ),
    createElement('p', { className: 'dsh-wp-preview-label' }, `保护路径 (${String(preview.readOnly.length)})`),
    pathList(React, preview.readOnly, '无生效保护路径'),
    createElement(
      'p',
      { className: 'dsh-wp-preview-label' },
      rulesFile?.path === undefined ? '工作区只读规则文件 (不存在)' : `工作区只读规则文件 (${rulesFile.path})`,
    ),
    pathList(
      React,
      rulesFile?.patterns === undefined || rulesFile.patterns.trim().length === 0
        ? []
        : rulesFile.patterns.trim().split('\n'),
      '这份文件没有条目 (已并入上面的保护路径)',
    ),
    createElement('p', { className: 'dsh-wp-preview-label' }, `本会话可写授权 (${String(grants.length)})`),
    pathList(
      React,
      grants.map(grant => `${grant.path}  (${grant.kind === 'override' ? '放开保护, 仅 write/edit' : '额外可写根'})`),
      '本会话没有已批准的可写授权',
    ),
    createElement('p', { className: 'dsh-wp-preview-label' }, `未生效 (${String(preview.warnings.length)})`),
    pathList(React, preview.warnings, '没有被忽略或拒绝的行'),
  )
}

/**
 * 设置页预览面板: 列出展开后的生效路径与未生效告警, 以及工作区只读规则文件与
 * 本会话已批准的可写授权. 说明性的差异 (例如授权的两类性质) 放在条目的 hover
 * 提示里, 列表本身只给路径, 避免每行都挂一长串括号.
 * @module dsh-write-protect/client/preview-panel
 */

import type { PathPreview } from '../constants.ts'

/** 客户端注入的 React runtime 形状 (module loader 的预载模块). */
export interface ReactRuntime {
  createElement: typeof import('react').createElement
}

/**
 * 渲染一个路径列表.
 * @param items - 逐行展示的文本.
 * @param empty - 列表为空时的占位文本.
 * @param tips - 与 items 对齐的 hover 提示 (可选).
 */
function pathList(
  React: ReactRuntime,
  items: readonly string[],
  empty: string,
  tips: readonly string[] = [],
): ReturnType<ReactRuntime['createElement']> {
  const { createElement } = React
  if (items.length === 0) return createElement('p', { className: 'dsh-wp-empty' }, empty)
  return createElement(
    'ul',
    { className: 'dsh-wp-list' },
    ...items.map((item, index) => createElement(
      'li',
      {
        key: `${String(index)}:${item}`,
        ...tips[index] === undefined ? {} : { title: tips[index] },
      },
      item,
    )),
  )
}

/** 授权两类性质的 hover 说明. */
const GRANT_TIPS: Record<string, string> = {
  override: '放开被保护的子树: write/edit 与命令沙箱 (bwrap / Seatbelt) 都生效',
  'extra-root': '工作区外的额外可写根: bash 与 write/edit 都可以写',
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
      '. 相对条目按当前会话 cwd 解析.',
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
      grants.map(grant => grant.path),
      '本会话没有已批准的可写授权',
      grants.map(grant => GRANT_TIPS[grant.kind] ?? ''),
    ),
    createElement('p', { className: 'dsh-wp-preview-label' }, `未生效 (${String(preview.warnings.length)})`),
    pathList(React, preview.warnings, '没有被忽略或拒绝的行'),
  )
}

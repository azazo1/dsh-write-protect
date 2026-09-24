/**
 * 卡片里的写入保护预览: 按当前草稿请求 Host 的预览路由, 再渲染展开后的生效路径.
 *
 * 预览面板本身由 preview-panel.ts 渲染 (自绘, 保持原有信息结构), 这里只管按钮, 请求与错误.
 */
import { createElement, useState } from 'react'
import { PREVIEW_PATH, type PathPreview } from '../constants.ts'
import { WriteProtectPreviewPanel } from './preview-panel.ts'
import type { WriteProtectTexts } from './settings-form.ts'

/** 预览面板的 props. */
export interface WriteProtectPreviewProps {
  /** 当前草稿文本, 由卡片从表单快照里取. */
  texts: WriteProtectTexts
  /** 当前选中会话的 cwd; 没有选中会话时返回 undefined, Host 侧直接报没有工作区根. */
  workspaceRootOf?: (() => string | undefined) | undefined
  /** 表单正在保存时禁用预览按钮. */
  disabled: boolean
}

/**
 * 渲染预览按钮与结果面板.
 * @param props - 草稿文本, 工作区根读取函数与禁用状态.
 * @returns 预览区块.
 */
export function WriteProtectPreview({ texts, workspaceRootOf, disabled }: WriteProtectPreviewProps) {
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<PathPreview | null>(null)
  const [error, setError] = useState('')

  const onPreview = (): void => {
    setPreviewing(true)
    setError('')
    const workspaceRoot = workspaceRootOf?.()
    void fetch(PREVIEW_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        patterns: texts.patterns,
        writablePatterns: texts.writablePatterns,
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
      setPreview({
        workspaceRoot: payload.workspaceRoot,
        readOnly: payload.readOnly.filter(item => typeof item === 'string'),
        writable: payload.writable.filter(item => typeof item === 'string'),
        warnings: payload.warnings.filter(item => typeof item === 'string'),
        ...payload.readOnlyFile === undefined ? {} : {
          readOnlyFile: {
            ...typeof payload.readOnlyFile.path === 'string' ? { path: payload.readOnlyFile.path } : {},
            patterns: typeof payload.readOnlyFile.patterns === 'string' ? payload.readOnlyFile.patterns : '',
            warnings: Array.isArray(payload.readOnlyFile.warnings)
              ? payload.readOnlyFile.warnings.filter(item => typeof item === 'string')
              : [],
          },
        },
        ...Array.isArray(payload.grants) ? {
          grants: payload.grants.filter(
            (item): item is { path: string, kind: 'extra-root' | 'override' } =>
              typeof item === 'object' && item !== null && typeof (item as { path?: unknown }).path === 'string'
              && ((item as { kind?: unknown }).kind === 'extra-root' || (item as { kind?: unknown }).kind === 'override'),
          ),
        } : {},
      })
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught))
    }).then(() => {
      setPreviewing(false)
    })
  }

  return (
    <div className="dsh-wp-preview">
      <div className="dsh-wp-preview-head">
        <span className="dsh-wp-preview-title">预览</span>
        <button
          type="button"
          className="dsh-wp-preview-button"
          disabled={disabled || previewing}
          onClick={onPreview}
        >
          {previewing ? '展开中...' : '按当前草稿展开'}
        </button>
      </div>
      <p className="dsh-wp-hint">预览按草稿文本计算, 不改动已保存的配置.</p>
      {error === '' ? null : <p className="dsh-wp-invalid">{error}</p>}
      {preview === null ? null : <>{WriteProtectPreviewPanel({ createElement }, preview)}</>}
    </div>
  )
}

/**
 * 配置卡片里的自绘字段控件.
 *
 * 官方 SettingsForm 只覆盖单行文本与数字, 所以开关, 多行文本与行列表这三类字段在这里
 * 自绘, 尺寸与间距对齐官方 fields.module.css, 颜色只用 --dsw-alias-* 语义 token.
 */
import type { ReactNode } from 'react'
import { Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

/** 字段行共用的头部: 标签, 覆盖标记与重置. */
function FieldHead(props: {
  id: string
  label: string
  overridden: boolean
  disabled: boolean
  onReset: () => void
  children?: ReactNode
}) {
  return (
    <div className="dsh-wp-head">
      <label className="dsh-wp-label" htmlFor={props.id}>{props.label}</label>
      {props.overridden
        ? (
          <span className="dsh-wp-badges">
            <Tag tone="neutral">已覆盖</Tag>
            <button
              type="button"
              className="dsh-wp-reset"
              disabled={props.disabled}
              onClick={props.onReset}
            >
              恢复默认
            </button>
          </span>
        )
        : null}
      {props.children}
    </div>
  )
}

/** 开关字段行. */
export function SwitchField(props: {
  id: string
  label: string
  hint: string
  checked: boolean
  overridden: boolean
  disabled: boolean
  onToggle: (next: boolean) => void
  onReset: () => void
}) {
  return (
    <div className="dsh-wp-field">
      <FieldHead
        id={props.id}
        label={props.label}
        overridden={props.overridden}
        disabled={props.disabled}
        onReset={props.onReset}
      >
        <Switch
          checked={props.checked}
          label={props.label}
          disabled={props.disabled}
          onChange={props.onToggle}
        />
      </FieldHead>
      <p className="dsh-wp-hint">{props.hint}</p>
    </div>
  )
}

/** 多行文本字段行. */
export function TextAreaField(props: {
  id: string
  label: string
  hint: string
  text: string
  invalid: boolean
  invalidLabel: string
  overridden: boolean
  disabled: boolean
  rows: number
  onEdit: (text: string) => void
  onReset: () => void
}) {
  return (
    <div className="dsh-wp-field">
      <FieldHead
        id={props.id}
        label={props.label}
        overridden={props.overridden}
        disabled={props.disabled}
        onReset={props.onReset}
      />
      <textarea
        id={props.id}
        className="dsh-wp-textarea"
        rows={props.rows}
        spellCheck={false}
        value={props.text}
        disabled={props.disabled}
        aria-invalid={props.invalid ? true : undefined}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? 'dsh-wp-invalid' : 'dsh-wp-hint'}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/**
 * 插件页里 dsh-write-protect 卡片的配置页.
 *
 * 骨架用官方 SettingsForm (草稿, 已覆盖标记, 保存语义与其它插件一致), 多行文本与开关字段
 * 自绘并嵌在表单里, 底部的写入保护预览面板沿用原来的自绘实现.
 */
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ALLOW_REQUESTS_FIELD, HARDEN_BROKER_FIELD, MAX_GRANTS_FIELD, MAX_READONLY_ENTRIES_FIELD,
  PATTERNS_FIELD, READONLY_FILE_FIELD, WATCH_FIELD, WATCH_TTL_MAX_FIELD, WATCH_TTL_MIN_FIELD,
  WRITABLE_FIELD,
} from '../constants.ts'
import { SwitchField, TextAreaField } from './fields.tsx'
import { WriteProtectPreview } from './preview.tsx'
import type { WriteProtectCardFace } from './settings-form.ts'

/** 组件拿到的 props. */
export type WriteProtectSettingsCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & InjectFace<WriteProtectCardFace>
  & {
    /** 当前会话 cwd; 没有选中会话时返回 undefined. */
    workspaceRootOf?: (() => string | undefined) | undefined
  }

/** 表单框架要的文案: 本插件的界面语言一直是中文, 与旧页面保持一致. */
const FORM_LABELS = {
  unavailable: '该插件当前未加载, 暂时无法配置.',
  readOnly: '本部署的设置为只读.',
  saveFailed: '本部署没有接受这些值, 已保留供你修改.',
  save: '保存',
  saving: '保存中...',
}

/**
 * 渲染卡片的一行简介或配置表单, 由插件页的 view 决定.
 * @param props - 页面要的视图, 表单快照与动作.
 * @returns 简介文本或配置表单.
 */
export function WriteProtectSettingsCard(props: WriteProtectSettingsCardProps) {
  const state = props.useWriteProtectCard(snapshot => snapshot)
  if (props.view === 'summary') {
    return '保护工作区里不该被写入的路径: 保护路径, 可写根, 只读规则文件与会话授权.'
  }
  const disabled = !state.writable

  const switchField = (
    id: string,
    label: string,
    hint: string,
    fieldName: string,
    fieldState: { text: string, overridden: boolean },
  ) => (
    <SwitchField
      id={id}
      label={label}
      hint={hint}
      checked={fieldState.text === 'true'}
      overridden={fieldState.overridden}
      disabled={disabled}
      onToggle={(next) => { props.edit(fieldName, next ? 'true' : 'false') }}
      onReset={() => { props.resetField(fieldName) }}
    />
  )

  const numberField = (
    id: string,
    label: string,
    hint: string,
    fieldName: string,
    fieldState: { text: string, overridden: boolean, invalid: boolean },
  ) => (
    <SettingsValueField
      id={id}
      label={label}
      hint={hint}
      overriddenLabel="已覆盖"
      resetLabel="恢复默认"
      invalidLabel="请填整数; 留空表示使用默认值."
      numeric
      disabled={disabled}
      {...fieldState}
      onEdit={(text) => { props.edit(fieldName, text) }}
      onReset={() => { props.resetField(fieldName) }}
    />
  )

  return (
    <SettingsForm labels={FORM_LABELS} state={state} onSave={props.save} onDiscard={props.discard}>
      <TextAreaField
        id="plugin-config-write-protect-patterns"
        label="保护路径"
        hint="每行一条, 支持 .gitignore 语法与 ~ 展开; 相对条目按当前会话 cwd 解析."
        rows={6}
        text={state.patterns.text}
        invalid={state.patterns.invalid}
        invalidLabel="这一项不是合法的文本."
        overridden={state.patterns.overridden}
        disabled={disabled}
        onEdit={(text) => { props.edit(PATTERNS_FIELD, text) }}
        onReset={() => { props.resetField(PATTERNS_FIELD) }}
      />
      <TextAreaField
        id="plugin-config-write-protect-writable"
        label="额外可写根"
        hint="每行一条, 列在工作区之外仍然可写的目录, 例如 ~/Library/Caches."
        rows={6}
        text={state.writablePatterns.text}
        invalid={state.writablePatterns.invalid}
        invalidLabel="这一项不是合法的文本."
        overridden={state.writablePatterns.overridden}
        disabled={disabled}
        onEdit={(text) => { props.edit(WRITABLE_FIELD, text) }}
        onReset={() => { props.resetField(WRITABLE_FIELD) }}
      />
      <SettingsValueField
        id="plugin-config-write-protect-rules-file"
        label="工作区只读规则文件名"
        hint="工作区里承载额外保护规则的文件名, 默认 .readonly."
        overriddenLabel="已覆盖"
        resetLabel="恢复默认"
        invalidLabel="请填文件名."
        disabled={disabled}
        {...state.readonlyFileName}
        onEdit={(text) => { props.edit(READONLY_FILE_FIELD, text) }}
        onReset={() => { props.resetField(READONLY_FILE_FIELD) }}
      />
      {numberField(
        'plugin-config-write-protect-max-entries',
        '规则文件条目上限',
        '只读规则文件最多读入多少条, 防止超大文件拖慢启动.',
        MAX_READONLY_ENTRIES_FIELD,
        state.maxReadOnlyEntries,
      )}
      {numberField(
        'plugin-config-write-protect-max-grants',
        '会话授权条数上限',
        '单个会话里最多保留多少条已批准的可写授权.',
        MAX_GRANTS_FIELD,
        state.maxGrants,
      )}
      {switchField(
        'plugin-config-write-protect-harden',
        '加固 broker',
        '开启后对写保护的 broker 额外收紧权限.',
        HARDEN_BROKER_FIELD,
        state.hardenBroker,
      )}
      {switchField(
        'plugin-config-write-protect-requests',
        '允许申请可写授权',
        '允许模型通过 request_writable_path 向你申请工作区外的可写路径.',
        ALLOW_REQUESTS_FIELD,
        state.allowWritableRequests,
      )}
      {switchField(
        'plugin-config-write-protect-watch',
        '监视被保护路径',
        '监视被保护路径的改动, 命中时刷新保护规则.',
        WATCH_FIELD,
        state.watchProtectedPaths,
      )}
      {numberField(
        'plugin-config-write-protect-watch-min',
        '监视刷新最短间隔 (毫秒)',
        '两次刷新之间至少间隔多久.',
        WATCH_TTL_MIN_FIELD,
        state.watchTtlMinMs,
      )}
      {numberField(
        'plugin-config-write-protect-watch-max',
        '监视刷新最长间隔 (毫秒)',
        '两次刷新之间最多间隔多久.',
        WATCH_TTL_MAX_FIELD,
        state.watchTtlMaxMs,
      )}
      <WriteProtectPreview
        texts={{ patterns: state.patterns.text, writablePatterns: state.writablePatterns.text }}
        workspaceRootOf={props.workspaceRootOf}
        disabled={disabled}
      />
    </SettingsForm>
  )
}

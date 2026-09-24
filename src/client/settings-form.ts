/**
 * dsh-write-protect 配置卡片的暂存表单.
 *
 * 表单是 policy 条目 volatile Config 的投影: 草稿只留在卡片页, 保存才写回 profile 的
 * patch 层. `mode` 与 `workspaceRoot` 属于部署级字段, 不在卡片里暴露, 仍由 patch 层配置.
 */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions,
  type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ALLOW_REQUESTS_FIELD, HARDEN_BROKER_FIELD, MAX_GRANTS_FIELD, MAX_READONLY_ENTRIES_FIELD,
  PATTERNS_FIELD, READONLY_FILE_FIELD, WATCH_FIELD, WATCH_TTL_MAX_FIELD, WATCH_TTL_MIN_FIELD,
  WRITABLE_FIELD,
} from '../constants.ts'

/** 卡片读到的配置形状. */
export interface WriteProtectSettings {
  readOnlyPaths?: string[]
  writablePaths?: string[]
  patterns?: string
  writablePatterns?: string
  hardenBroker?: boolean
  readonlyFileName?: string
  maxReadOnlyEntries?: number
  maxGrants?: number
  allowWritableRequests?: boolean
  watchProtectedPaths?: boolean
  watchTtlMinMs?: number
  watchTtlMaxMs?: number
}

/**
 * 布尔字段的草稿编码: 官方模型只解析文本字段, 布尔值以 `true` / `false` 暂存.
 * @param field - 字段名.
 * @returns 该字段的转换描述.
 */
function settingsBooleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'boolean' ? String(value) : '',
    parse: text => text === 'true'
      ? { kind: 'set', value: true }
      : text === 'false'
        ? { kind: 'set', value: false }
        : undefined,
  }
}

/** 卡片读到的状态. */
export interface WriteProtectCardState extends SettingsFormShell {
  patterns: SettingsFieldState
  writablePatterns: SettingsFieldState
  readonlyFileName: SettingsFieldState
  maxReadOnlyEntries: SettingsFieldState
  maxGrants: SettingsFieldState
  hardenBroker: SettingsFieldState
  allowWritableRequests: SettingsFieldState
  watchProtectedPaths: SettingsFieldState
  watchTtlMinMs: SettingsFieldState
  watchTtlMaxMs: SettingsFieldState
}

/** 卡片注册时注入给组件的面. */
export interface WriteProtectCardFace extends SettingsFormActions {
  hooks: {
    /** 组件通过它读快照 (useWriteProtectCard). */
    writeProtectCard: SnapshotStore<WriteProtectCardState>
  }
}

/** 卡片暴露给预览面板的两个文本. */
export interface WriteProtectTexts {
  /** 保护路径文本, `patterns` 缺席时回落到 `readOnlyPaths`. */
  patterns: string
  /** 可写路径文本, `writablePatterns` 缺席时回落到 `writablePaths`. */
  writablePatterns: string
}

/** 把 policy 条目的配置表单桥接成配置卡片的暂存表单. */
export class WriteProtectSettingsForm {
  private readonly form: SettingsFormModel<WriteProtectSettings>
  private readonly store: SnapshotStore<WriteProtectCardState>

  /**
   * @param scope - policy 条目的共享配置表单 (ctx.configForms.get).
   */
  constructor(private readonly scope: SettingsFormScope<WriteProtectSettings>) {
    this.form = new SettingsFormModel(scope, [
      settingsTextField(PATTERNS_FIELD),
      settingsTextField(WRITABLE_FIELD),
      settingsTextField(READONLY_FILE_FIELD),
      settingsNumberField(MAX_READONLY_ENTRIES_FIELD),
      settingsNumberField(MAX_GRANTS_FIELD),
      settingsBooleanField(HARDEN_BROKER_FIELD),
      settingsBooleanField(ALLOW_REQUESTS_FIELD),
      settingsBooleanField(WATCH_FIELD),
      settingsNumberField(WATCH_TTL_MIN_FIELD),
      settingsNumberField(WATCH_TTL_MAX_FIELD),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  /**
   * 构造 slot 注册要注入的面.
   * @returns 快照 hook 与表单动作.
   */
  inject(): WriteProtectCardFace {
    return { hooks: { writeProtectCard: this.store }, ...this.form.actions() }
  }

  /**
   * 预览面板要的两个文本: 优先用已暂存的草稿, 否则用有效值, 再回落到数组字段.
   * @returns 保护路径与可写路径的文本.
   */
  texts(): WriteProtectTexts {
    const value = this.scope.getSnapshot().value
    const patterns = this.form.field(PATTERNS_FIELD).text
    const writable = this.form.field(WRITABLE_FIELD).text
    return {
      patterns: patterns !== '' ? patterns : (value?.readOnlyPaths ?? []).join('\n'),
      writablePatterns: writable !== '' ? writable : (value?.writablePaths ?? []).join('\n'),
    }
  }

  /** 释放对配置表单的订阅. */
  dispose(): void {
    this.form.dispose()
  }

  /** 组装卡片读到的整块状态, 并补上数组字段的回退展示. */
  private projection(): WriteProtectCardState {
    const value = this.scope.getSnapshot().value
    const patterns = this.form.field(PATTERNS_FIELD)
    const writablePatterns = this.form.field(WRITABLE_FIELD)
    const fallbackPatterns = (value?.readOnlyPaths ?? []).join('\n')
    const fallbackWritable = (value?.writablePaths ?? []).join('\n')
    return {
      ...this.form.shell(),
      patterns: patterns.text === '' && fallbackPatterns !== '' ? { ...patterns, text: fallbackPatterns } : patterns,
      writablePatterns: writablePatterns.text === '' && fallbackWritable !== '' ? { ...writablePatterns, text: fallbackWritable } : writablePatterns,
      readonlyFileName: this.form.field(READONLY_FILE_FIELD),
      maxReadOnlyEntries: this.form.field(MAX_READONLY_ENTRIES_FIELD),
      maxGrants: this.form.field(MAX_GRANTS_FIELD),
      hardenBroker: this.form.field(HARDEN_BROKER_FIELD),
      allowWritableRequests: this.form.field(ALLOW_REQUESTS_FIELD),
      watchProtectedPaths: this.form.field(WATCH_FIELD),
      watchTtlMinMs: this.form.field(WATCH_TTL_MIN_FIELD),
      watchTtlMaxMs: this.form.field(WATCH_TTL_MAX_FIELD),
    }
  }
}

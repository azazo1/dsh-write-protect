window.__ModuleLoader__.load({ id: "dsh-write-protect", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
let react_jsx_runtime = require("react/jsx-runtime");
let react = require("react");
//#region src/constants.ts
/**
* 共享契约: 纯常量与类型合并, Host 与 Client 两端共用. 不允许引入任何
* 运行时依赖 (Client bundle 的纯度要求双端共享的值必须是浏览器安全的字面量).
* @module dsh-write-protect/constants
*/
/** 插件标识: settings namespace, client 注册 id 与 package name 三者一致. */
const PLUGIN_ID = "dsh-write-protect";
/** settings namespace 的 patterns 字段名 (gitignore 风格的多行文本). */
const PATTERNS_FIELD = "patterns";
/** settings namespace 的额外可写根字段名 (字面路径的多行文本). */
const WRITABLE_FIELD = "writablePatterns";
/** settings namespace 的 macOS broker 加固开关字段名. */
const HARDEN_BROKER_FIELD = "hardenBroker";
/** settings namespace 的工作区只读规则文件名 (单值, 空串即关闭识别). */
const READONLY_FILE_FIELD = "readonlyFileName";
/** settings namespace 的规则文件条目上限字段名. */
const MAX_READONLY_ENTRIES_FIELD = "maxReadOnlyEntries";
/** settings namespace 的单会话可写授权上限字段名. */
const MAX_GRANTS_FIELD = "maxGrants";
/** settings namespace 的"是否允许模型申请可写路径"开关字段名. */
const ALLOW_REQUESTS_FIELD = "allowWritableRequests";
/** settings namespace 的"是否监听工作区变化"开关字段名. */
const WATCH_FIELD = "watchProtectedPaths";
/** settings namespace 的自适应刷新下界字段名 (毫秒). */
const WATCH_TTL_MIN_FIELD = "watchTtlMinMs";
/** settings namespace 的自适应刷新上界字段名 (毫秒). */
const WATCH_TTL_MAX_FIELD = "watchTtlMaxMs";
/** 设置页预览的 Host Fetch 路由, 走 `/api` 鉴权通道. POST JSON. */
const PREVIEW_PATH = "/api/dsh-write-protect.preview";
/** 会话写入权限面板的 Host Fetch 路由, 走同一个 `/api` 鉴权通道. POST JSON. */
const GRANTS_PATH = "/api/dsh-write-protect.grants";
//#endregion
//#region src/client/fields.tsx
/** 字段行共用的头部: 标签, 覆盖标记与重置. */
function FieldHead(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-wp-head",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
				className: "dsh-wp-label",
				htmlFor: props.id,
				children: props.label
			}),
			props.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dsh-wp-badges",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
					tone: "neutral",
					children: "已覆盖"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dsh-wp-reset",
					disabled: props.disabled,
					onClick: props.onReset,
					children: "恢复默认"
				})]
			}) : null,
			props.children
		]
	});
}
/** 开关字段行. */
function SwitchField(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-wp-field",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FieldHead, {
			id: props.id,
			label: props.label,
			overridden: props.overridden,
			disabled: props.disabled,
			onReset: props.onReset,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
				checked: props.checked,
				label: props.label,
				disabled: props.disabled,
				onChange: props.onToggle
			})
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: "dsh-wp-hint",
			children: props.hint
		})]
	});
}
/** 多行文本字段行. */
function TextAreaField(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-wp-field",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FieldHead, {
				id: props.id,
				label: props.label,
				overridden: props.overridden,
				disabled: props.disabled,
				onReset: props.onReset
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				id: props.id,
				className: "dsh-wp-textarea",
				rows: props.rows,
				spellCheck: false,
				value: props.text,
				disabled: props.disabled,
				"aria-invalid": props.invalid ? true : void 0,
				onChange: (event) => {
					props.onEdit(event.target.value);
				}
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: props.invalid ? "dsh-wp-invalid" : "dsh-wp-hint",
				children: props.invalid ? props.invalidLabel : props.hint
			})
		]
	});
}
//#endregion
//#region src/client/preview-panel.ts
/**
* 渲染一个路径列表.
* @param items - 逐行展示的文本.
* @param empty - 列表为空时的占位文本.
* @param tips - 与 items 对齐的 hover 提示 (可选).
*/
function pathList(React, items, empty, tips = []) {
	const { createElement } = React;
	if (items.length === 0) return createElement("p", { className: "dsh-wp-empty" }, empty);
	return createElement("ul", { className: "dsh-wp-list" }, ...items.map((item, index) => createElement("li", {
		key: `${String(index)}:${item}`,
		...tips[index] === void 0 ? {} : { title: tips[index] }
	}, item)));
}
/** 授权两类性质的 hover 说明. */
const GRANT_TIPS = {
	override: "放开被保护的子树: write/edit 与命令沙箱 (bwrap / Seatbelt) 都生效",
	"extra-root": "工作区外的额外可写根: bash 与 write/edit 都可以写"
};
/** 渲染一份预览结果. */
function WriteProtectPreviewPanel(React, preview) {
	const { createElement } = React;
	const rulesFile = preview.readOnlyFile;
	const grants = preview.grants ?? [];
	return createElement("div", { className: "dsh-wp-card" }, createElement("h3", { className: "dsh-wp-card-title" }, "预览"), createElement("p", { className: "dsh-wp-hint" }, "工作区根: ", createElement("code", null, preview.workspaceRoot), ". 相对条目按当前会话 cwd 解析."), createElement("p", { className: "dsh-wp-preview-label" }, `保护路径 (${String(preview.readOnly.length)})`), pathList(React, preview.readOnly, "无生效保护路径"), createElement("p", { className: "dsh-wp-preview-label" }, rulesFile?.path === void 0 ? "工作区只读规则文件 (不存在)" : `工作区只读规则文件 (${rulesFile.path})`), pathList(React, rulesFile?.patterns === void 0 || rulesFile.patterns.trim().length === 0 ? [] : rulesFile.patterns.trim().split("\n"), "这份文件没有条目 (已并入上面的保护路径)"), createElement("p", { className: "dsh-wp-preview-label" }, `本会话可写授权 (${String(grants.length)})`), pathList(React, grants.map((grant) => grant.path), "本会话没有已批准的可写授权", grants.map((grant) => GRANT_TIPS[grant.kind] ?? "")), grants.length === 0 ? null : createElement("p", { className: "dsh-wp-hint" }, "要加临时可写根或撤回某条授权, 到会话区 (与 \"对话\" / \"轨迹\" 并排) 的 \"写入权限\" tab 里操作."), createElement("p", { className: "dsh-wp-preview-label" }, `未生效 (${String(preview.warnings.length)})`), pathList(React, preview.warnings, "没有被忽略或拒绝的行"));
}
//#endregion
//#region src/client/preview.tsx
/**
* 卡片里的写入保护预览: 按当前草稿请求 Host 的预览路由, 再渲染展开后的生效路径.
*
* 预览面板本身由 preview-panel.ts 渲染 (自绘, 保持原有信息结构), 这里只管按钮, 请求与错误.
*/
/**
* 渲染预览按钮与结果面板.
* @param props - 草稿文本, 工作区根读取函数与禁用状态.
* @returns 预览区块.
*/
function WriteProtectPreview({ texts, workspaceRootOf, disabled }) {
	const [previewing, setPreviewing] = (0, react.useState)(false);
	const [preview, setPreview] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)("");
	const onPreview = () => {
		setPreviewing(true);
		setError("");
		const workspaceRoot = workspaceRootOf?.();
		fetch(PREVIEW_PATH, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json"
			},
			credentials: "same-origin",
			body: JSON.stringify({
				patterns: texts.patterns,
				writablePatterns: texts.writablePatterns,
				...workspaceRoot === void 0 ? {} : { workspaceRoot }
			})
		}).then(async (response) => {
			const text = await response.text();
			if (text.length === 0) throw new Error(`preview failed (${String(response.status)}, empty body)`);
			let payload;
			try {
				payload = JSON.parse(text);
			} catch {
				throw new Error(`preview failed (${String(response.status)}): ${text.slice(0, 180)}`);
			}
			if (!response.ok) throw new Error(payload.error ?? `preview failed (${String(response.status)})`);
			if (typeof payload.workspaceRoot !== "string" || !Array.isArray(payload.readOnly) || !Array.isArray(payload.writable) || !Array.isArray(payload.warnings)) throw new Error("preview response is malformed");
			setPreview({
				workspaceRoot: payload.workspaceRoot,
				readOnly: payload.readOnly.filter((item) => typeof item === "string"),
				writable: payload.writable.filter((item) => typeof item === "string"),
				warnings: payload.warnings.filter((item) => typeof item === "string"),
				...payload.readOnlyFile === void 0 ? {} : { readOnlyFile: {
					...typeof payload.readOnlyFile.path === "string" ? { path: payload.readOnlyFile.path } : {},
					patterns: typeof payload.readOnlyFile.patterns === "string" ? payload.readOnlyFile.patterns : "",
					warnings: Array.isArray(payload.readOnlyFile.warnings) ? payload.readOnlyFile.warnings.filter((item) => typeof item === "string") : []
				} },
				...Array.isArray(payload.grants) ? { grants: payload.grants.filter((item) => typeof item === "object" && item !== null && typeof item.path === "string" && (item.kind === "extra-root" || item.kind === "override")) } : {}
			});
		}).catch((caught) => {
			setError(caught instanceof Error ? caught.message : String(caught));
		}).then(() => {
			setPreviewing(false);
		});
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-wp-preview",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-wp-preview-head",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-wp-preview-title",
					children: "预览"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dsh-wp-preview-button",
					disabled: disabled || previewing,
					onClick: onPreview,
					children: previewing ? "展开中..." : "按当前草稿展开"
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-wp-hint",
				children: "预览按草稿文本计算, 不改动已保存的配置."
			}),
			error === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-wp-invalid",
				children: error
			}),
			preview === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: WriteProtectPreviewPanel({ createElement: react.createElement }, preview) })
		]
	});
}
//#endregion
//#region src/client/card.tsx
/** 表单框架要的文案: 本插件的界面语言一直是中文, 与旧页面保持一致. */
const FORM_LABELS = {
	unavailable: "该插件当前未加载, 暂时无法配置.",
	readOnly: "本部署的设置为只读.",
	saveFailed: "本部署没有接受这些值, 已保留供你修改.",
	save: "保存",
	saving: "保存中..."
};
/**
* 渲染卡片的一行简介或配置表单, 由插件页的 view 决定.
* @param props - 页面要的视图, 表单快照与动作.
* @returns 简介文本或配置表单.
*/
function WriteProtectSettingsCard(props) {
	const state = props.useWriteProtectCard((snapshot) => snapshot);
	if (props.view === "summary") return "保护工作区里不该被写入的路径: 保护路径, 可写根, 只读规则文件与会话授权.";
	const disabled = !state.writable;
	const switchField = (id, label, hint, fieldName, fieldState) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchField, {
		id,
		label,
		hint,
		checked: fieldState.text === "true",
		overridden: fieldState.overridden,
		disabled,
		onToggle: (next) => {
			props.edit(fieldName, next ? "true" : "false");
		},
		onReset: () => {
			props.resetField(fieldName);
		}
	});
	const numberField = (id, label, hint, fieldName, fieldState) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsValueField, {
		id,
		label,
		hint,
		overriddenLabel: "已覆盖",
		resetLabel: "恢复默认",
		invalidLabel: "请填整数; 留空表示使用默认值.",
		numeric: true,
		disabled,
		...fieldState,
		onEdit: (text) => {
			props.edit(fieldName, text);
		},
		onReset: () => {
			props.resetField(fieldName);
		}
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.SettingsForm, {
		labels: FORM_LABELS,
		state,
		onSave: props.save,
		onDiscard: props.discard,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextAreaField, {
				id: "plugin-config-write-protect-patterns",
				label: "保护路径",
				hint: "每行一条, 支持 .gitignore 语法与 ~ 展开; 相对条目按当前会话 cwd 解析.",
				rows: 6,
				text: state.patterns.text,
				invalid: state.patterns.invalid,
				invalidLabel: "这一项不是合法的文本.",
				overridden: state.patterns.overridden,
				disabled,
				onEdit: (text) => {
					props.edit(PATTERNS_FIELD, text);
				},
				onReset: () => {
					props.resetField(PATTERNS_FIELD);
				}
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TextAreaField, {
				id: "plugin-config-write-protect-writable",
				label: "额外可写根",
				hint: "每行一条, 列在工作区之外仍然可写的目录, 例如 ~/Library/Caches.",
				rows: 6,
				text: state.writablePatterns.text,
				invalid: state.writablePatterns.invalid,
				invalidLabel: "这一项不是合法的文本.",
				overridden: state.writablePatterns.overridden,
				disabled,
				onEdit: (text) => {
					props.edit(WRITABLE_FIELD, text);
				},
				onReset: () => {
					props.resetField(WRITABLE_FIELD);
				}
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsValueField, {
				id: "plugin-config-write-protect-rules-file",
				label: "工作区只读规则文件名",
				hint: "工作区里承载额外保护规则的文件名, 默认 .readonly.",
				overriddenLabel: "已覆盖",
				resetLabel: "恢复默认",
				invalidLabel: "请填文件名.",
				disabled,
				...state.readonlyFileName,
				onEdit: (text) => {
					props.edit(READONLY_FILE_FIELD, text);
				},
				onReset: () => {
					props.resetField(READONLY_FILE_FIELD);
				}
			}),
			numberField("plugin-config-write-protect-max-entries", "最多条目数", "只读规则文件最多读入多少条, 超过上限的部分丢弃并告警.", MAX_READONLY_ENTRIES_FIELD, state.maxReadOnlyEntries),
			numberField("plugin-config-write-protect-max-grants", "单会话可写授权上限", "本会话内存里的可写授权最多保留多少条.", MAX_GRANTS_FIELD, state.maxGrants),
			switchField("plugin-config-write-protect-harden", "macOS broker 逃逸加固", "在 Seatbelt profile 末尾追加拒绝 open, 只收紧不放宽; 仅 macOS 生效.", HARDEN_BROKER_FIELD, state.hardenBroker),
			switchField("plugin-config-write-protect-requests", "模型申请可写路径", "开启后提示词会引导模型在需要反复写受保护区域时调用 request_writable_path, 由你在审批弹窗里逐次决定.", ALLOW_REQUESTS_FIELD, state.allowWritableRequests),
			switchField("plugin-config-write-protect-watch", "监听工作区变化", "只给正在运行 agent 的会话装递归监听, 一变就重算命令侧清单; 装不上时退回纯时间兜底.", WATCH_FIELD, state.watchProtectedPaths),
			numberField("plugin-config-write-protect-watch-min", "刷新下界 (毫秒)", "没有事件时兜底重算的间隔下界.", WATCH_TTL_MIN_FIELD, state.watchTtlMinMs),
			numberField("plugin-config-write-protect-watch-max", "刷新上界 (毫秒)", "没有事件时兜底重算的间隔上界.", WATCH_TTL_MAX_FIELD, state.watchTtlMaxMs),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(WriteProtectPreview, {
				texts: {
					patterns: state.patterns.text,
					writablePatterns: state.writablePatterns.text
				},
				workspaceRootOf: props.workspaceRootOf,
				disabled
			})
		]
	});
}
//#endregion
//#region src/client/session-cwd.ts
/** 主视图持有来源的键名: 被它持有时就是当前选中的会话. */
const MAIN_VIEW_SOURCE = "mainView";
const PARENT_HOPS = 8;
/** 快照里主视图持有的会话 id; 没有选中会话时返回 undefined. */
function selectedSessionId(snap) {
	for (const [id, row] of Object.entries(snap.byId ?? {})) if ((row?.retainedBy?.[MAIN_VIEW_SOURCE] ?? 0) > 0) return id;
}
/**
* 当前选中会话的 cwd; 没有选中会话或整条祖先链都没有 cwd 时返回 undefined.
* @param sessions - client 的 sessions 服务, 缺省则无法识别.
*/
function sessionCwdOf(sessions) {
	const snap = sessions?.list?.getSnapshot?.();
	if (snap === void 0) return void 0;
	return walkToCwd(snap, selectedSessionId(snap));
}
/**
* 指定会话的 cwd; 该会话与其祖先链都没有 cwd 时返回 undefined.
*
* 会话区的写入权限面板拿到的是当前正在看的那条会话 id (槽位的标准 props), 它可
* 能不是主视图持有的那条 (例如从侧栏打开的子 agent 会话), 所以这里按 id 定位,
* 而不是复用 `sessionCwdOf` 的选中判定.
* @param sessions - client 的 sessions 服务, 缺省则无法识别.
* @param sessionId - 目标会话 id.
*/
function sessionCwdById(sessions, sessionId) {
	const snap = sessions?.list?.getSnapshot?.();
	if (snap === void 0 || sessionId === void 0 || sessionId.length === 0) return void 0;
	return walkToCwd(snap, sessionId);
}
/** 沿 `parentId` 向上找第一个带 cwd 的会话 (子 agent 的摘要不一定自带 cwd). */
function walkToCwd(snap, from) {
	let id = from;
	for (let hop = 0; id !== void 0 && hop < PARENT_HOPS; hop += 1) {
		const info = snap.byId?.[id];
		const cwd = typeof info?.cwd === "string" ? info.cwd.trim() : "";
		if (cwd.length > 0) return cwd;
		id = info?.parentId;
	}
}
//#endregion
//#region src/client/settings-form.ts
/**
* 布尔字段的草稿编码: 官方模型只解析文本字段, 布尔值以 `true` / `false` 暂存.
* @param field - 字段名.
* @returns 该字段的转换描述.
*/
function settingsBooleanField(field) {
	return {
		field,
		format: (value) => typeof value === "boolean" ? String(value) : "",
		parse: (text) => text === "true" ? {
			kind: "set",
			value: true
		} : text === "false" ? {
			kind: "set",
			value: false
		} : void 0
	};
}
/** 把 policy 条目的配置表单桥接成配置卡片的暂存表单. */
var WriteProtectSettingsForm = class {
	scope;
	form;
	store;
	/**
	* @param scope - policy 条目的共享配置表单 (ctx.configForms.get).
	*/
	constructor(scope) {
		this.scope = scope;
		this.form = new _deepseek_ai_dsh_client_ui_primitives.SettingsFormModel(scope, [
			(0, _deepseek_ai_dsh_client_ui_primitives.settingsTextField)(PATTERNS_FIELD),
			(0, _deepseek_ai_dsh_client_ui_primitives.settingsTextField)(WRITABLE_FIELD),
			(0, _deepseek_ai_dsh_client_ui_primitives.settingsTextField)(READONLY_FILE_FIELD),
			(0, _deepseek_ai_dsh_client_ui_primitives.settingsNumberField)(MAX_READONLY_ENTRIES_FIELD),
			(0, _deepseek_ai_dsh_client_ui_primitives.settingsNumberField)(MAX_GRANTS_FIELD),
			settingsBooleanField(HARDEN_BROKER_FIELD),
			settingsBooleanField(ALLOW_REQUESTS_FIELD),
			settingsBooleanField(WATCH_FIELD),
			(0, _deepseek_ai_dsh_client_ui_primitives.settingsNumberField)(WATCH_TTL_MIN_FIELD),
			(0, _deepseek_ai_dsh_client_ui_primitives.settingsNumberField)(WATCH_TTL_MAX_FIELD)
		]);
		this.store = this.form.bind(() => this.projection());
	}
	/**
	* 构造 slot 注册要注入的面.
	* @returns 快照 hook 与表单动作.
	*/
	inject() {
		return {
			hooks: { writeProtectCard: this.store },
			...this.form.actions()
		};
	}
	/**
	* 预览面板要的两个文本: 优先用已暂存的草稿, 否则用有效值, 再回落到数组字段.
	* @returns 保护路径与可写路径的文本.
	*/
	texts() {
		const value = this.scope.getSnapshot().value;
		const patterns = this.form.field(PATTERNS_FIELD).text;
		const writable = this.form.field(WRITABLE_FIELD).text;
		return {
			patterns: patterns !== "" ? patterns : (value?.readOnlyPaths ?? []).join("\n"),
			writablePatterns: writable !== "" ? writable : (value?.writablePaths ?? []).join("\n")
		};
	}
	/** 释放对配置表单的订阅. */
	dispose() {
		this.form.dispose();
	}
	/** 组装卡片读到的整块状态, 并补上数组字段的回退展示. */
	projection() {
		const value = this.scope.getSnapshot().value;
		const patterns = this.form.field(PATTERNS_FIELD);
		const writablePatterns = this.form.field(WRITABLE_FIELD);
		const fallbackPatterns = (value?.readOnlyPaths ?? []).join("\n");
		const fallbackWritable = (value?.writablePaths ?? []).join("\n");
		return {
			...this.form.shell(),
			patterns: patterns.text === "" && fallbackPatterns !== "" ? {
				...patterns,
				text: fallbackPatterns
			} : patterns,
			writablePatterns: writablePatterns.text === "" && fallbackWritable !== "" ? {
				...writablePatterns,
				text: fallbackWritable
			} : writablePatterns,
			readonlyFileName: this.form.field(READONLY_FILE_FIELD),
			maxReadOnlyEntries: this.form.field(MAX_READONLY_ENTRIES_FIELD),
			maxGrants: this.form.field(MAX_GRANTS_FIELD),
			hardenBroker: this.form.field(HARDEN_BROKER_FIELD),
			allowWritableRequests: this.form.field(ALLOW_REQUESTS_FIELD),
			watchProtectedPaths: this.form.field(WATCH_FIELD),
			watchTtlMinMs: this.form.field(WATCH_TTL_MIN_FIELD),
			watchTtlMaxMs: this.form.field(WATCH_TTL_MAX_FIELD)
		};
	}
};
//#endregion
//#region src/client/styles.ts
/**
* 配置卡片的样式: 字段行对齐官方 fields.module.css, 预览面板沿用原来的卡片语言.
* 只用 --dsw-alias-* 语义 token, 由 data-plugin-css 标记防止重复插入.
*/
const STYLE_ID = "dsh-write-protect-card";
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
`;
/** 注入卡片样式一次; 重复调用为空操作. */
function installStyles() {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return;
	const style = document.createElement("style");
	style.dataset["pluginCss"] = STYLE_ID;
	style.textContent = CSS_TEXT;
	document.head.appendChild(style);
}
//#endregion
//#region src/client/write-access.ts
/**
* 会话写入权限面板的数据面: 与 Host 的 `/api/dsh-write-protect.grants` 对话,
* 并校验回来的响应形状. 组件只持有"最近一次结果 + 进行中标记", 取数与写操作全在
* 这里 (与设置页预览同一个套路: 走 `/api` 鉴权通道, `credentials: same-origin`).
* @module dsh-write-protect/client/write-access
*/
/** 授权类型的中文名 (面板列表与添加结果都用它). */
function grantKindLabel(kind) {
	return kind === "override" ? "保护旁路" : "额外可写根";
}
function isGrantKind(value) {
	return value === "override" || value === "extra-root";
}
/** 校验一条授权条目. */
function decodeGrant(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (typeof record.path !== "string" || !isGrantKind(record.kind)) return void 0;
	return {
		path: record.path,
		kind: record.kind
	};
}
/**
* 校验一次响应: 面板只认形状完整的对象, 免得界面把半截数据画成"没有授权".
* @param payload - 已解析的 JSON.
* @param status - 用于错误文案的 HTTP 状态码.
*/
function decodeResponse(payload, status) {
	if (typeof payload !== "object" || payload === null) throw new Error(`grants request failed (${String(status)}): malformed response`);
	const record = payload;
	if (typeof record.error === "string") throw new Error(record.error);
	if (typeof record.workspaceRoot !== "string" || typeof record.mode !== "string" || !Array.isArray(record.grants)) throw new Error(`grants request failed (${String(status)}): malformed response`);
	const grants = record.grants.map(decodeGrant).filter((grant) => grant !== void 0);
	const notice = record.notice === "queued" || record.notice === "no-session" ? record.notice : void 0;
	const changed = record.changed;
	return {
		workspaceRoot: record.workspaceRoot,
		mode: record.mode,
		maxGrants: typeof record.maxGrants === "number" ? record.maxGrants : 0,
		grants,
		...typeof changed === "object" && changed !== null && typeof changed.path === "string" && isGrantKind(changed.kind) && (changed.action === "add" || changed.action === "revoke") ? { changed: {
			path: changed.path,
			kind: changed.kind,
			action: changed.action
		} } : {},
		...notice === void 0 ? {} : { notice }
	};
}
/** 发一次面板请求. */
async function requestGrants(sessionId, action, body) {
	const response = await fetch(GRANTS_PATH, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json"
		},
		credentials: "same-origin",
		body: JSON.stringify({
			sessionId,
			action,
			...body.cwd === void 0 ? {} : { cwd: body.cwd },
			...body.path === void 0 ? {} : { path: body.path }
		})
	});
	const text = await response.text();
	if (text.length === 0) throw new Error(`grants request failed (${String(response.status)}, empty body)`);
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`grants request failed (${String(response.status)}): ${text.slice(0, 180)}`);
	}
	if (!response.ok) throw new Error(String(payload.error ?? `grants request failed (${String(response.status)})`));
	return decodeResponse(payload, response.status);
}
/**
* 造一个绑定到某会话的面板数据面.
* @param sessionId - 目标会话 id.
* @param cwdOf - 该会话的 cwd 读取函数 (Host 侧靠它定位工作区根).
*/
function createWriteAccessFace(sessionId, cwdOf) {
	const scope = () => {
		const cwd = cwdOf();
		return cwd === void 0 ? {} : { cwd };
	};
	return {
		load: async () => await requestGrants(sessionId, "list", scope()),
		add: async (path) => await requestGrants(sessionId, "add", {
			path,
			...scope()
		}),
		revoke: async (path) => await requestGrants(sessionId, "revoke", {
			path,
			...scope()
		})
	};
}
//#endregion
//#region src/client/write-access-tab.tsx
/**
* 会话区的 "写入权限" tab: 列出本会话内存里的可写授权, 逐条撤回, 以及手动加临时
* 可写根. 与 "对话" / "轨迹" 并列, 由 `conversation.view` 槽挂上去.
*
* 这里只有界面: 取数与写操作走注入的 {@link WriteAccessFace} (Host 的 `/api` 路由),
* 组件自己只持有"最近一次结果 / 进行中 / 错误"三个本地状态. 撤回之后 Host 会把
* 这次撤回作为一条消息投进会话, 面板把投递结果如实写出来 —— 没投出去 (会话当前
* 没有活动的 agent) 就说没投出去, 不要让用户以为模型一定知道了.
* @module dsh-write-protect/client/write-access-tab
*/
/** 撤回之后的状态说明, 按通知是否真的投出去分开讲. */
function revokeStatus(view, path) {
	if (view.notice === "queued") return `已撤回 ${path}, 并把这次撤回作为一条消息排入本会话 (模型下一步会看到).`;
	if (view.notice === "no-session") return `已撤回 ${path}. 本会话当前没有活动的 agent, 因此没有投递通知.`;
	return `已撤回 ${path}.`;
}
/** 添加之后的状态说明. */
function addStatus(view, path) {
	return `已加入${view.changed?.kind === void 0 ? "" : ` (${grantKindLabel(view.changed.kind)})`}: ${view.changed?.path ?? path}. 只在本会话内存里, 重启 dsh 后失效.`;
}
/**
* 渲染写入权限面板.
* @param props - 会话槽位 props 与注入的数据面.
*/
function WriteAccessTab(props) {
	const [state, setState] = (0, react.useState)({
		loading: true,
		error: "",
		status: ""
	});
	const [draft, setDraft] = (0, react.useState)("");
	const apply = (pending, describe) => {
		setState((previous) => ({
			...previous,
			loading: true,
			error: ""
		}));
		pending.then((view) => {
			setState({
				loading: false,
				error: "",
				status: describe(view),
				view
			});
		}).catch((caught) => {
			const message = caught instanceof Error ? caught.message : String(caught);
			setState((previous) => ({
				...previous,
				loading: false,
				error: message,
				status: ""
			}));
		});
	};
	(0, react.useEffect)(() => {
		apply(props.load(), () => "");
	}, [props.sessionId]);
	const view = state.view;
	const grants = view?.grants ?? [];
	const onSubmit = (event) => {
		event.preventDefault();
		const path = draft.trim();
		if (path.length === 0 || state.loading) return;
		setDraft("");
		apply(props.add(path), (next) => addStatus(next, path));
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-wp-tab",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-wp-tab-head",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-wp-tab-title",
					children: "写入权限"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dsh-wp-button",
					disabled: state.loading,
					onClick: () => {
						apply(props.load(), () => "");
					},
					children: state.loading ? "读取中..." : "刷新"
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-wp-hint",
				children: "本会话内存里的可写授权: 模型申请并经你批准的, 以及你在下面手动加的. 会话结束或重启 dsh 后自动消失."
			}),
			view?.mode === "read-only" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-wp-warning",
				children: "当前是 read-only 模式: 这里加的授权要等会话切到 workspace-write 或 danger-full-access 之后才生效."
			}) : null,
			state.error === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-wp-invalid",
				children: state.error
			}),
			state.status === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-wp-status",
				children: state.status
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-wp-preview-label",
				children: `当前授权 (${String(grants.length)}${view === void 0 ? "" : ` / ${String(view.maxGrants)}`})`
			}),
			grants.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-wp-empty",
				children: view === void 0 ? "还没有读到本会话的授权." : "本会话没有可写授权."
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
				className: "dsh-wp-grants",
				children: grants.map((grant) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
					className: "dsh-wp-grant",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
							className: "dsh-wp-grant-path",
							children: grant.path
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-wp-grant-kind",
							children: grantKindLabel(grant.kind)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-wp-grant-action",
							disabled: state.loading,
							onClick: () => {
								apply(props.revoke(grant.path), (next) => revokeStatus(next, grant.path));
							},
							children: "撤回"
						})
					]
				}, grant.path))
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				className: "dsh-wp-add",
				onSubmit,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					className: "dsh-wp-input",
					type: "text",
					value: draft,
					disabled: state.loading,
					placeholder: "~/scratch 或 out/notes (相对会话工作区)",
					"aria-label": "要加为临时可写根的路径",
					onChange: (event) => {
						setDraft(event.target.value);
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "submit",
					className: "dsh-wp-button",
					disabled: state.loading || draft.trim().length === 0,
					children: "加为临时可写根"
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-wp-hint",
				children: "工作区内的路径记作保护旁路 (放开命中它的保护条目), 工作区外的记作额外可写根; 两者都只在本会话内存里, 不写配置."
			}),
			view === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: "dsh-wp-hint",
				children: ["工作区根: ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: view.workspaceRoot })]
			})
		]
	});
}
//#endregion
//#region src/client/index.ts
/** 页面依赖的服务: configForms 提供配置通道, slots 提供注册面, sessions 提供 cwd. */
const inject = [
	"configForms",
	"slots",
	"sessions"
];
/** Policy host row id; ConfigForms is keyed by Loader entry id. */
const CONFIG_ENTRY_ID = "dsh-write-protect-policy";
/** 会话区 tab 的条目 id (`conversation.view` 槽内唯一即可). */
const WRITE_ACCESS_VIEW_ID = "write-access";
/** 取 sessions 服务 (可能缺席, 缺席时预览报没有工作区根). */
function sessionsOf(ctx) {
	return ctx.sessions;
}
/** 注册插件页的配置卡片与会话区的写入权限 tab. */
function apply(ctx) {
	installStyles();
	const form = new WriteProtectSettingsForm(ctx.configForms.get(CONFIG_ENTRY_ID));
	ctx.effect(() => () => {
		form.dispose();
	}, "dsh-write-protect: settings form");
	ctx.effect(() => ctx.configForms.whileServed([CONFIG_ENTRY_ID], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
		name: "plugins.bundle.config",
		key: PLUGIN_ID,
		inject: () => ({
			...form.inject(),
			workspaceRootOf: () => sessionCwdOf(sessionsOf(ctx))
		})
	}, WriteProtectSettingsCard))), "dsh-write-protect: plugins page card");
	ctx.effect(() => ctx.slots.inject("conversation.view", () => ctx.slots.register({
		name: "conversation.view",
		id: WRITE_ACCESS_VIEW_ID,
		order: 20,
		label: "写入权限",
		inject: (sessionId) => createWriteAccessFace(String(sessionId), () => sessionCwdById(sessionsOf(ctx), String(sessionId)))
	}, WriteAccessTab)), "dsh-write-protect: write access tab");
}
//#endregion
exports.apply = apply;
exports.inject = inject;

return module.exports; } });
//# sourceMappingURL=client.js.map
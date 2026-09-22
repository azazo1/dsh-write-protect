window.__ModuleLoader__.load({ id: "dsh-write-protect", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
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
/** 设置页预览的 Host Fetch 路由, 走 `/api` 鉴权通道. POST JSON. */
const PREVIEW_PATH = "/api/dsh-write-protect.preview";
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
	return createElement("div", { className: "dsh-wp-card" }, createElement("h3", { className: "dsh-wp-card-title" }, "预览"), createElement("p", { className: "dsh-wp-hint" }, "工作区根: ", createElement("code", null, preview.workspaceRoot), ". 相对条目按当前会话 cwd 解析."), createElement("p", { className: "dsh-wp-preview-label" }, `保护路径 (${String(preview.readOnly.length)})`), pathList(React, preview.readOnly, "无生效保护路径"), createElement("p", { className: "dsh-wp-preview-label" }, rulesFile?.path === void 0 ? "工作区只读规则文件 (不存在)" : `工作区只读规则文件 (${rulesFile.path})`), pathList(React, rulesFile?.patterns === void 0 || rulesFile.patterns.trim().length === 0 ? [] : rulesFile.patterns.trim().split("\n"), "这份文件没有条目 (已并入上面的保护路径)"), createElement("p", { className: "dsh-wp-preview-label" }, `本会话可写授权 (${String(grants.length)})`), pathList(React, grants.map((grant) => grant.path), "本会话没有已批准的可写授权", grants.map((grant) => GRANT_TIPS[grant.kind] ?? "")), createElement("p", { className: "dsh-wp-preview-label" }, `未生效 (${String(preview.warnings.length)})`), pathList(React, preview.warnings, "没有被忽略或拒绝的行"));
}
//#endregion
//#region src/client/section.ts
const STYLE_ID = "dsh-write-protect-section";
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
.dsh-wp-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dsh-wp-row-label { font-size: 12.5px; color: var(--dsw-alias-label-tertiary); }
.dsh-wp-input { min-width: 160px; height: 30px; box-sizing: border-box; padding: 0 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.dsh-wp-input-sm { min-width: 72px; width: 72px; }
.dsh-wp-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
`;
/** 注入页面样式 (data-plugin-css 标记防止重复插入). */
function installStyles() {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return;
	const tag = document.createElement("style");
	tag.dataset.pluginCss = STYLE_ID;
	tag.textContent = CSS_TEXT;
	document.head.appendChild(tag);
}
/** 正整数输入的解析: 非法值回退到 Host 侧当前值 (Host 侧还会再校验一次). */
function parsePositive(draft, fallback) {
	const parsed = Number.parseInt(draft.trim(), 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
/** 配置页组件: 订阅 scope 展示当前生效文本, 保存写回 Host. */
function WriteProtectSection(React, props) {
	const { scope, workspaceRootOf } = props;
	const { createElement, useState, useSyncExternalStore } = React;
	const savedPatterns = useSyncExternalStore((listener) => scope.subscribe(listener), () => scope.getSnapshot().value?.patterns ?? "");
	const savedWritable = useSyncExternalStore((listener) => scope.subscribe(listener), () => scope.getSnapshot().value?.writablePatterns ?? "");
	const savedHarden = useSyncExternalStore((listener) => scope.subscribe(listener), () => scope.getSnapshot().value?.hardenBroker ?? true);
	const savedFileName = useSyncExternalStore((listener) => scope.subscribe(listener), () => scope.getSnapshot().value?.readonlyFileName ?? "");
	const savedMaxEntries = useSyncExternalStore((listener) => scope.subscribe(listener), () => scope.getSnapshot().value?.maxReadOnlyEntries ?? 200);
	const savedMaxGrants = useSyncExternalStore((listener) => scope.subscribe(listener), () => scope.getSnapshot().value?.maxGrants ?? 8);
	const savedAllowRequests = useSyncExternalStore((listener) => scope.subscribe(listener), () => scope.getSnapshot().value?.allowWritableRequests ?? true);
	const [patternsDraft, setPatternsDraft] = useState(null);
	const [writableDraft, setWritableDraft] = useState(null);
	const [hardenDraft, setHardenDraft] = useState(null);
	const [fileNameDraft, setFileNameDraft] = useState(null);
	const [maxEntriesDraft, setMaxEntriesDraft] = useState(null);
	const [maxGrantsDraft, setMaxGrantsDraft] = useState(null);
	const [allowRequestsDraft, setAllowRequestsDraft] = useState(null);
	const [saving, setSaving] = useState(false);
	const [view, setView] = useState("edit");
	const [previewing, setPreviewing] = useState(false);
	const [preview, setPreview] = useState(null);
	const [previewError, setPreviewError] = useState("");
	const patternsValue = patternsDraft ?? savedPatterns;
	const writableValue = writableDraft ?? savedWritable;
	const hardenValue = hardenDraft ?? savedHarden;
	const fileNameValue = fileNameDraft ?? savedFileName;
	const maxEntriesValue = maxEntriesDraft ?? String(savedMaxEntries);
	const maxGrantsValue = maxGrantsDraft ?? String(savedMaxGrants);
	const allowRequestsValue = allowRequestsDraft ?? savedAllowRequests;
	const dirty = patternsDraft !== null && patternsDraft !== savedPatterns || writableDraft !== null && writableDraft !== savedWritable || hardenDraft !== null && hardenDraft !== savedHarden || fileNameDraft !== null && fileNameDraft !== savedFileName || maxEntriesDraft !== null && maxEntriesDraft !== String(savedMaxEntries) || maxGrantsDraft !== null && maxGrantsDraft !== String(savedMaxGrants) || allowRequestsDraft !== null && allowRequestsDraft !== savedAllowRequests;
	const onPreview = () => {
		setPreviewing(true);
		setPreviewError("");
		const workspaceRoot = workspaceRootOf?.();
		fetch(PREVIEW_PATH, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json"
			},
			credentials: "same-origin",
			body: JSON.stringify({
				patterns: patternsValue,
				writablePatterns: writableValue,
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
			setView("preview");
		}).catch((error) => {
			setPreviewError(error instanceof Error ? error.message : String(error));
		}).then(() => {
			setPreviewing(false);
		});
	};
	const onSave = () => {
		if (!dirty) return;
		setSaving(true);
		const writes = [];
		if (patternsDraft !== null) writes.push(Promise.resolve(scope.set(PATTERNS_FIELD, patternsDraft)));
		if (writableDraft !== null) writes.push(Promise.resolve(scope.set(WRITABLE_FIELD, writableDraft)));
		if (hardenDraft !== null) writes.push(Promise.resolve(scope.set(HARDEN_BROKER_FIELD, hardenDraft)));
		if (fileNameDraft !== null) writes.push(Promise.resolve(scope.set(READONLY_FILE_FIELD, fileNameDraft)));
		if (maxEntriesDraft !== null) writes.push(Promise.resolve(scope.set(MAX_READONLY_ENTRIES_FIELD, parsePositive(maxEntriesDraft, savedMaxEntries))));
		if (maxGrantsDraft !== null) writes.push(Promise.resolve(scope.set(MAX_GRANTS_FIELD, parsePositive(maxGrantsDraft, savedMaxGrants))));
		if (allowRequestsDraft !== null) writes.push(Promise.resolve(scope.set(ALLOW_REQUESTS_FIELD, allowRequestsDraft)));
		Promise.all(writes).then(() => {
			setSaving(false);
			setPatternsDraft(null);
			setWritableDraft(null);
			setHardenDraft(null);
			setFileNameDraft(null);
			setMaxEntriesDraft(null);
			setMaxGrantsDraft(null);
			setAllowRequestsDraft(null);
		});
	};
	const editors = createElement("div", { className: "dsh-wp-edit" }, createElement("div", { className: "dsh-wp-card" }, createElement("h3", { className: "dsh-wp-card-title" }, "保护路径"), createElement("textarea", {
		className: "dsh-wp-textarea",
		spellCheck: false,
		value: patternsValue,
		onChange: (event) => setPatternsDraft(event.currentTarget.value)
	}), createElement("p", { className: "dsh-wp-hint" }, "每行一条, ", createElement("code", null, "#"), " 注释, 空行忽略; ", createElement("code", null, "!"), " 排除 (按最后匹配生效, 受保护目录内部无法重新放行后代); 含 ", createElement("code", null, "/"), " 的条目锚定工作区根, 其余匹配任意层级, ", createElement("code", null, "//"), " 开头为文件系统绝对路径; 支持 ", createElement("code", null, "*"), ", ", createElement("code", null, "?"), ", ", createElement("code", null, "[...]"), " 与独立成段的 ", createElement("code", null, "**"), " 通配, 尾部 ", createElement("code", null, "/"), " 仅匹配目录, ", createElement("code", null, "\\"), " 转义下一字符. 通配只匹配已存在的路径. 示例: ", createElement("code", null, "vendor"), ", ", createElement("code", null, "secrets/*.pem"), ", ", createElement("code", null, "!secrets/example.pem"), ". 清空全部条目即停用保护.")), createElement("div", { className: "dsh-wp-card" }, createElement("h3", { className: "dsh-wp-card-title" }, "额外可写根"), createElement("textarea", {
		className: "dsh-wp-textarea dsh-wp-textarea-sm",
		spellCheck: false,
		value: writableValue,
		onChange: (event) => setWritableDraft(event.currentTarget.value)
	}), createElement("p", { className: "dsh-wp-hint" }, "每行一条字面路径, 不要通配. ", createElement("code", null, "~"), " / ", createElement("code", null, "~/..."), " 为当前用户家目录, ", createElement("code", null, "$NAME"), " / ", createElement("code", null, "${NAME}"), " 为环境变量. Windows 上反斜杠是分隔符而不是转义符, ", createElement("code", null, "C:\\Users\\me\\caches"), " 原样生效, ", createElement("code", null, "~\\caches"), " 也算家目录, 盘符相对路径 ", createElement("code", null, "C:caches"), " 没有固定落点, 会被拒绝. 绝对路径按文件系统解析 (", createElement("code", null, "/tmp/extra"), " 或 ", createElement("code", null, "//tmp/extra"), "), 相对路径 (含 ", createElement("code", null, ".."), ") 相对当前会话工作区. 工作区内的路径本来就可写, 会被忽略; 文件系统根会被拒绝. 保护路径仍然优先. 清空即不额外放行. Windows 上仅 write/edit 工具生效, bash 仍受官方 ACL 限制.")), createElement("div", { className: "dsh-wp-card" }, createElement("h3", { className: "dsh-wp-card-title" }, "模型申请可写路径"), createElement("label", { className: "dsh-wp-toggle" }, createElement("input", {
		type: "checkbox",
		checked: allowRequestsValue,
		onChange: (event) => setAllowRequestsDraft(event.currentTarget.checked)
	}), createElement("span", null, allowRequestsValue ? "允许申请" : "不允许申请")), createElement("p", { className: "dsh-wp-hint" }, "开启后提示词会引导模型在\"任务要反复写同一片受保护区域\"时调用 ", createElement("code", null, "request_writable_path"), ", 由你在审批弹窗里逐次决定; 关掉后该工具的任何调用都被拒绝, 提示词也不再引导. 授权只在本会话内存里存在, 上限由上面的 \"单会话可写授权上限\" 决定.")), createElement("div", { className: "dsh-wp-card" }, createElement("h3", { className: "dsh-wp-card-title" }, "macOS broker 逃逸加固"), createElement("label", { className: "dsh-wp-toggle" }, createElement("input", {
		type: "checkbox",
		checked: hardenValue,
		onChange: (event) => setHardenDraft(event.currentTarget.checked)
	}), createElement("span", null, hardenValue ? "已启用" : "已关闭")), createElement("p", { className: "dsh-wp-hint" }, "macOS 的 Seatbelt profile 是 ", createElement("code", null, "(allow default)"), ", 而在 launchd 代理下启动的进程不继承它 —— 沙箱内一条 ", createElement("code", null, "open x.app"), " 就能让命令在沙箱外任意读写, 绕开 ", createElement("code", null, "deny file-write*"), " (read-only 同样如此). 启用后在 profile 末尾追加拒绝 ", createElement("code", null, "com.apple.coreservices"), " / ", createElement("code", null, "appleevent-send"), " / ", createElement("code", null, "mach-priv-task-port"), ", 只收紧不放宽; 常规命令 (node, git, pnpm 等) 不受影响. 关闭后按官方 profile 运行, 只在确需从沙箱内驱动宿主 GUI 时才关. 仅 macOS 生效.")), createElement("div", { className: "dsh-wp-card" }, createElement("h3", { className: "dsh-wp-card-title" }, "工作区只读规则文件"), createElement("div", { className: "dsh-wp-row" }, createElement("span", { className: "dsh-wp-row-label" }, "文件名"), createElement("input", {
		className: "dsh-wp-input",
		spellCheck: false,
		value: fileNameValue,
		placeholder: ".readonly",
		onChange: (event) => setFileNameDraft(event.currentTarget.value)
	})), createElement("div", { className: "dsh-wp-row" }, createElement("span", { className: "dsh-wp-row-label" }, "最多条目数"), createElement("input", {
		className: "dsh-wp-input dsh-wp-input-sm",
		inputMode: "numeric",
		value: maxEntriesValue,
		onChange: (event) => setMaxEntriesDraft(event.currentTarget.value)
	}), createElement("span", { className: "dsh-wp-row-label" }, "单会话可写授权上限"), createElement("input", {
		className: "dsh-wp-input dsh-wp-input-sm",
		inputMode: "numeric",
		value: maxGrantsValue,
		onChange: (event) => setMaxGrantsDraft(event.currentTarget.value)
	})), createElement("p", { className: "dsh-wp-hint" }, "工作区根下这份文件与上面的保护路径同语义, 逐行追加在其后, 因此规则文件既能新增条目也能用 ", createElement("code", null, "!"), " 放行上面的条目. 它只认普通文件 (符号链接被拒绝), ", createElement("code", null, "//"), " 绝对条目与越出工作区的条目会被拒绝, 超过条目上限的部分丢弃并告警. 文件名留空即关闭该识别; 名字里不能有路径分隔符, 也不能用 ", createElement("code", null, ".git"), " 一类元数据名. 这份文件本身永远不可写 (唯一的硬保护): 模型申请可写路径不会放开它, 任何授权都不放行它, 要改只能在这里换文件名或者由你在 DSH 之外编辑.")));
	const status = previewError !== "" ? previewError : previewing ? "正在展开..." : dirty ? "有未保存的更改" : "";
	return createElement("section", { className: "dsh-wp-section" }, createElement("h2", { className: "dsh-wp-title" }, "写入保护"), createElement("p", { className: "dsh-wp-desc" }, "保护路径对沙箱内的命令与 write/edit 工具只读; 额外可写根只在 workspace-write 下把工作区外的目录并进 allow-list, 不打穿 read-only. 保护路径优先. 保存后实时应用, 无需重启. 预览按当前会话 cwd 展开当前草稿, 不必先保存."), view === "preview" && preview !== null ? WriteProtectPreviewPanel(React, preview) : editors, createElement("div", { className: "dsh-wp-actions" }, view === "preview" ? createElement("button", {
		className: "dsh-wp-btn",
		disabled: previewing,
		onClick: () => setView("edit")
	}, "返回编辑") : createElement("button", {
		className: "dsh-wp-btn",
		disabled: previewing || saving,
		onClick: onPreview
	}, previewing ? "展开中..." : "预览"), createElement("button", {
		className: "dsh-wp-btn",
		disabled: !dirty || saving || previewing,
		onClick: onSave
	}, saving ? "保存中..." : "保存"), createElement("button", {
		className: "dsh-wp-btn",
		disabled: !dirty || saving || previewing || view === "preview",
		onClick: () => {
			setPatternsDraft(null);
			setWritableDraft(null);
			setHardenDraft(null);
			setFileNameDraft(null);
			setMaxEntriesDraft(null);
			setMaxGrantsDraft(null);
			setAllowRequestsDraft(null);
		}
	}, "放弃更改"), createElement("span", { className: "dsh-wp-status" }, status)));
}
/** 注册 settings.section slot, 把页面挂进 Web Settings 导航. */
function mountWriteProtectSection(ctx, React, scope, workspaceRootOf) {
	installStyles();
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: PLUGIN_ID,
		order: 100,
		label: "写入保护",
		inject: () => ({
			scope,
			workspaceRootOf
		})
	}, (props) => WriteProtectSection(React, props)));
}
//#endregion
//#region src/client/session-cwd.ts
const PARENT_HOPS = 8;
/**
* 当前选中会话的 cwd; 没有选中会话或整条祖先链都没有 cwd 时返回 undefined.
* @param sessions - client 的 sessions 服务, 缺省则无法识别.
*/
function sessionCwdOf(sessions) {
	const snap = sessions?.list?.getSnapshot?.();
	if (snap === void 0) return void 0;
	let id = snap.current;
	for (let hop = 0; id !== void 0 && hop < PARENT_HOPS; hop += 1) {
		const info = snap.byId?.[id];
		const cwd = typeof info?.cwd === "string" ? info.cwd.trim() : "";
		if (cwd.length > 0) return cwd;
		id = info?.parentId;
	}
}
//#endregion
//#region src/client/index.ts
const React = require("react");
/** 未知 section 结构到类型化配置的解码; 异常结构回退 undefined (走 base 展示). */
function decodeWriteProtectSettings(section) {
	if (typeof section !== "object" || section === null) return void 0;
	const record = section;
	const patterns = record[PATTERNS_FIELD];
	const writable = record[WRITABLE_FIELD];
	const hardenBroker = record[HARDEN_BROKER_FIELD];
	const readonlyFileName = record[READONLY_FILE_FIELD];
	const maxReadOnlyEntries = record[MAX_READONLY_ENTRIES_FIELD];
	const maxGrants = record[MAX_GRANTS_FIELD];
	const allowRequests = record[ALLOW_REQUESTS_FIELD];
	const decoded = {};
	if (typeof patterns === "string") decoded.patterns = patterns;
	if (typeof writable === "string") decoded.writablePatterns = writable;
	if (typeof hardenBroker === "boolean") decoded.hardenBroker = hardenBroker;
	if (typeof readonlyFileName === "string") decoded.readonlyFileName = readonlyFileName;
	if (typeof maxReadOnlyEntries === "number") decoded.maxReadOnlyEntries = maxReadOnlyEntries;
	if (typeof maxGrants === "number") decoded.maxGrants = maxGrants;
	if (typeof allowRequests === "boolean") decoded.allowWritableRequests = allowRequests;
	return decoded.patterns === void 0 && decoded.writablePatterns === void 0 && decoded.hardenBroker === void 0 && decoded.readonlyFileName === void 0 && decoded.maxReadOnlyEntries === void 0 && decoded.maxGrants === void 0 && decoded.allowWritableRequests === void 0 ? void 0 : decoded;
}
/** 页面依赖的服务: settingsScope 提供配置通道, slots 提供注册面, sessions 提供当前 cwd. */
const inject = [
	"settingsScope",
	"slots",
	"sessions"
];
function sessionsOf(ctx) {
	return ctx.sessions;
}
/** 注册独立配置页. */
function apply(ctx) {
	const scope = ctx.settingsScope.bind({
		namespace: PLUGIN_ID,
		decode: decodeWriteProtectSettings
	});
	mountWriteProtectSection(ctx, React, scope, () => sessionCwdOf(sessionsOf(ctx)));
}
//#endregion
exports.apply = apply;
exports.decodeWriteProtectSettings = decodeWriteProtectSettings;
exports.inject = inject;

return module.exports; } });
//# sourceMappingURL=client.js.map
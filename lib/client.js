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
//#endregion
//#region src/client/section.ts
const STYLE_ID = "dsh-write-protect-section";
const CSS_TEXT = `
.dsh-wp-section { max-width: 760px; display: flex; flex-direction: column; gap: 12px; }
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
/** 配置页组件: 订阅 scope 展示当前生效文本, 保存写回 Host. */
function WriteProtectSection(React, props) {
	const { scope } = props;
	const { createElement, useState, useSyncExternalStore } = React;
	const savedPatterns = useSyncExternalStore((listener) => scope.subscribe(listener), () => scope.getSnapshot().value?.patterns ?? "");
	const savedWritable = useSyncExternalStore((listener) => scope.subscribe(listener), () => scope.getSnapshot().value?.writablePatterns ?? "");
	const [patternsDraft, setPatternsDraft] = useState(null);
	const [writableDraft, setWritableDraft] = useState(null);
	const [saving, setSaving] = useState(false);
	const patternsValue = patternsDraft ?? savedPatterns;
	const writableValue = writableDraft ?? savedWritable;
	const dirty = patternsDraft !== null && patternsDraft !== savedPatterns || writableDraft !== null && writableDraft !== savedWritable;
	const onSave = () => {
		if (!dirty) return;
		setSaving(true);
		const writes = [];
		if (patternsDraft !== null) writes.push(Promise.resolve(scope.set(PATTERNS_FIELD, patternsDraft)));
		if (writableDraft !== null) writes.push(Promise.resolve(scope.set(WRITABLE_FIELD, writableDraft)));
		Promise.all(writes).then(() => {
			setSaving(false);
			setPatternsDraft(null);
			setWritableDraft(null);
		});
	};
	return createElement("section", { className: "dsh-wp-section" }, createElement("h2", { className: "dsh-wp-title" }, "写入保护"), createElement("p", { className: "dsh-wp-desc" }, "保护路径对沙箱内的命令与 write/edit 工具只读; 额外可写根只在 workspace-write 下把工作区外的目录并进 allow-list, 不打穿 read-only. 保护路径优先. 保存后实时应用, 无需重启."), createElement("div", { className: "dsh-wp-card" }, createElement("h3", { className: "dsh-wp-card-title" }, "保护路径"), createElement("textarea", {
		className: "dsh-wp-textarea",
		spellCheck: false,
		value: patternsValue,
		onChange: (event) => setPatternsDraft(event.currentTarget.value)
	}), createElement("p", { className: "dsh-wp-hint" }, "每行一条, ", createElement("code", null, "#"), " 注释, 空行忽略; ", createElement("code", null, "!"), " 排除 (按最后匹配生效, 受保护目录内部无法重新放行后代); 含 ", createElement("code", null, "/"), " 的条目锚定工作区根, 其余匹配任意层级, ", createElement("code", null, "//"), " 开头为文件系统绝对路径; 支持 ", createElement("code", null, "*"), ", ", createElement("code", null, "?"), ", ", createElement("code", null, "[...]"), " 与独立成段的 ", createElement("code", null, "**"), " 通配, 尾部 ", createElement("code", null, "/"), " 仅匹配目录, ", createElement("code", null, "\\"), " 转义下一字符. 通配只匹配已存在的路径. 示例: ", createElement("code", null, "vendor"), ", ", createElement("code", null, "secrets/*.pem"), ", ", createElement("code", null, "!secrets/example.pem"), ". 清空全部条目即停用保护.")), createElement("div", { className: "dsh-wp-card" }, createElement("h3", { className: "dsh-wp-card-title" }, "额外可写根"), createElement("textarea", {
		className: "dsh-wp-textarea dsh-wp-textarea-sm",
		spellCheck: false,
		value: writableValue,
		onChange: (event) => setWritableDraft(event.currentTarget.value)
	}), createElement("p", { className: "dsh-wp-hint" }, "每行一条字面路径, 不要通配. 绝对路径按文件系统解析 (", createElement("code", null, "/tmp/extra"), " 或 ", createElement("code", null, "//tmp/extra"), "), 相对路径 (含 ", createElement("code", null, ".."), ") 相对当前会话工作区. 工作区内的路径本来就可写, 会被忽略; 文件系统根会被拒绝. 保护路径仍然优先. 清空即不额外放行. Windows 上仅 write/edit 工具生效, bash 仍受官方 ACL 限制.")), createElement("div", { className: "dsh-wp-actions" }, createElement("button", {
		className: "dsh-wp-btn",
		disabled: !dirty || saving,
		onClick: onSave
	}, saving ? "保存中..." : "保存"), createElement("button", {
		className: "dsh-wp-btn",
		disabled: !dirty || saving,
		onClick: () => {
			setPatternsDraft(null);
			setWritableDraft(null);
		}
	}, "放弃更改"), createElement("span", { className: "dsh-wp-status" }, dirty ? "有未保存的更改" : "")));
}
/** 注册 settings.section slot, 把页面挂进 Web Settings 导航. */
function mountWriteProtectSection(ctx, React, scope) {
	installStyles();
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: PLUGIN_ID,
		order: 100,
		label: "写入保护",
		inject: () => ({ scope })
	}, (props) => WriteProtectSection(React, props)));
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
	const decoded = {};
	if (typeof patterns === "string") decoded.patterns = patterns;
	if (typeof writable === "string") decoded.writablePatterns = writable;
	return decoded.patterns === void 0 && decoded.writablePatterns === void 0 ? void 0 : decoded;
}
/** 页面依赖的服务: settingsScope 提供配置通道, slots 提供注册面. */
const inject = ["settingsScope", "slots"];
/** 注册独立配置页. */
function apply(ctx) {
	const scope = ctx.settingsScope.bind({
		namespace: PLUGIN_ID,
		decode: decodeWriteProtectSettings
	});
	mountWriteProtectSection(ctx, React, scope);
}
//#endregion
exports.apply = apply;
exports.decodeWriteProtectSettings = decodeWriteProtectSettings;
exports.inject = inject;

return module.exports; } });
//# sourceMappingURL=client.js.map
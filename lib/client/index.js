window.__ModuleLoader__.load({
  id: "dsh-deveco",
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
// src/client/format.ts
/**
* 展示层的小格式化函数（纯函数，便于单测）。
*
* @module dsh-deveco/client/format
*/
/** `12345` → `12,345`。 */
function formatCount(value) {
	if (!Number.isFinite(value) || value <= 0) return "0";
	return Math.floor(value).toLocaleString("en-US");
}
/** `1_048_576` → `1M`、`170_000` → `170K`、`32768` → `32K`。 */
function formatTokens(value) {
	if (!Number.isFinite(value) || value <= 0) return "—";
	if (value >= 1e6) {
		const millions = value / 1e6;
		return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (value >= 1e3) {
		const thousands = value / 1e3;
		return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}K`;
	}
	return String(Math.round(value));
}
/** 相对时间：`刚刚` / `3 分钟前` / 具体日期。 */
function formatWhen(at, now = Date.now()) {
	if (at === void 0 || !Number.isFinite(at) || at <= 0) return "—";
	const delta = now - at;
	if (delta < 0) {
		const minutes = Math.max(1, Math.round(-delta / 6e4));
		return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
	}
	if (delta < 6e4) return "刚刚";
	if (delta < 36e5) return `${Math.round(delta / 6e4)} 分钟前`;
	if (delta < 864e5) return `${Math.round(delta / 36e5)} 小时前`;
	return new Date(at).toLocaleDateString();
}
/** 账号的显示名：备注名 → 用户名 → 用户 id → 未命名。 */
function accountDisplayName(account, fallback) {
	return account.label ?? account.userName ?? account.userId ?? (account.id === "" ? fallback : account.id);
}
// \0dsh-css:E:\PythonMyCode\dsh-plugin-about\dsh-deveco\src\client\DevecoPluginCard.module.css.mjs
const css = ".yao8Kq_card{border:1px solid var(--dsw-alias-settings-card-stroke,#7f7f7f2e);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-settings-card-fill,transparent);color:var(--dsw-alias-label-primary,inherit);flex-direction:column;gap:12px;padding:16px;font-size:13px;line-height:1.5;display:flex}.yao8Kq_header{justify-content:space-between;align-items:flex-start;gap:12px;display:flex}.yao8Kq_headerMain{flex-direction:column;gap:2px;display:flex}.yao8Kq_title{margin:0;font-size:15px;font-weight:600}.yao8Kq_subtitle{color:var(--dsw-alias-label-tertiary,#7f7f7fe6);margin:0;font-size:12px}.yao8Kq_headerMeta{flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;display:flex}.yao8Kq_tabs{align-self:flex-start}.yao8Kq_section{flex-direction:column;gap:10px;display:flex}.yao8Kq_signInBox{flex-wrap:wrap;align-items:center;gap:10px;display:flex}.yao8Kq_tokenInput{flex:220px;min-width:180px}.yao8Kq_list{flex-direction:column;gap:8px;display:flex}.yao8Kq_accountRow{border:1px solid var(--dsw-alias-settings-card-stroke,#7f7f7f2e);border-radius:var(--dsw-radius-md,8px);justify-content:space-between;align-items:flex-start;gap:12px;padding:8px 10px;display:flex}.yao8Kq_accountMain{flex-direction:column;gap:4px;min-width:0;display:flex}.yao8Kq_accountTitle{flex-wrap:wrap;align-items:center;gap:6px;display:flex}.yao8Kq_accountName{font-weight:600}.yao8Kq_accountMeta{color:var(--dsw-alias-label-tertiary,#7f7f7fe6);flex-wrap:wrap;gap:10px;font-size:12px;display:flex}.yao8Kq_accountActions{flex-wrap:wrap;justify-content:flex-end;gap:4px;display:flex}.yao8Kq_inlineForm{align-items:center;gap:6px;display:flex}.yao8Kq_modelRow{border-radius:var(--dsw-radius-md,8px);cursor:pointer;align-items:flex-start;gap:8px;padding:6px 8px;display:flex}.yao8Kq_modelRow:hover{background:var(--dsw-alias-fill-secondary,#7f7f7f14)}.yao8Kq_modelMain{flex-direction:column;gap:2px;min-width:0;display:flex}.yao8Kq_modelTitle{flex-wrap:wrap;align-items:center;gap:6px;display:flex}.yao8Kq_modelName{font-weight:600}.yao8Kq_modelMeta{color:var(--dsw-alias-label-tertiary,#7f7f7fe6);flex-wrap:wrap;gap:10px;font-size:12px;display:flex}.yao8Kq_toolbar{flex-wrap:wrap;align-items:center;gap:10px;display:flex}.yao8Kq_checkinRow{border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-settings-card-stroke,#7f7f7f2e);align-items:center;gap:10px;padding:6px 8px;display:flex}.yao8Kq_switchRow{flex-wrap:wrap;align-items:center;gap:10px;display:flex}.yao8Kq_quotaBox{border:1px solid var(--dsw-alias-settings-card-stroke,#7f7f7f2e);border-radius:var(--dsw-radius-md,8px);flex-direction:column;gap:8px;padding:10px;display:flex}.yao8Kq_quotaTitle{font-weight:600}.yao8Kq_quotaExhausted{flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;display:flex}.yao8Kq_note{border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-fill-secondary,#7f7f7f14);color:var(--dsw-alias-label-tertiary,#7f7f7fe6);margin:0;padding:8px 10px;font-size:12px}.yao8Kq_muted{color:var(--dsw-alias-label-tertiary,#7f7f7fe6);font-size:12px}.yao8Kq_warnText{color:var(--dsw-alias-status-warning,#d97706);font-weight:700}.yao8Kq_error{border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-status-danger,#dc2626);color:var(--dsw-alias-status-danger,#dc2626);word-break:break-word;padding:8px 10px;font-size:12px}.yao8Kq_notice{border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-status-success,#16a34a);color:var(--dsw-alias-status-success,#16a34a);padding:8px 10px;font-size:12px}.yao8Kq_footer{border-top:1px solid var(--dsw-alias-settings-card-stroke,#7f7f7f2e);color:var(--dsw-alias-label-secondary,inherit);flex-wrap:wrap;align-items:center;gap:12px;padding-top:8px;font-size:12px;display:flex}.yao8Kq_footerTitle{font-weight:600}.yao8Kq_panel{flex-direction:column;gap:12px;height:100%;padding:16px;display:flex;overflow:auto}.yao8Kq_panelHeader{align-items:center;gap:10px;display:flex}.yao8Kq_panelTitle{margin:0;font-size:15px;font-weight:600}.yao8Kq_dockLine{color:var(--dsw-alias-label-tertiary,#7f7f7fe6);white-space:nowrap;align-items:center;gap:6px;font-size:12px;display:flex}.yao8Kq_dockSeparator{opacity:.5}";
const tagId = "dsh-deveco/DevecoPluginCard.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-deveco";
	tag.dataset.pluginCss = tagId;
	tag.textContent = css;
	document.head.appendChild(tag);
}
var DevecoPluginCard_module_css_default = {
	"footerTitle": "yao8Kq_footerTitle",
	"note": "yao8Kq_note",
	"panelHeader": "yao8Kq_panelHeader",
	"dockSeparator": "yao8Kq_dockSeparator",
	"switchRow": "yao8Kq_switchRow",
	"accountMeta": "yao8Kq_accountMeta",
	"accountRow": "yao8Kq_accountRow",
	"accountTitle": "yao8Kq_accountTitle",
	"accountName": "yao8Kq_accountName",
	"panel": "yao8Kq_panel",
	"dockLine": "yao8Kq_dockLine",
	"quotaExhausted": "yao8Kq_quotaExhausted",
	"quotaTitle": "yao8Kq_quotaTitle",
	"tokenInput": "yao8Kq_tokenInput",
	"footer": "yao8Kq_footer",
	"headerMeta": "yao8Kq_headerMeta",
	"modelTitle": "yao8Kq_modelTitle",
	"warnText": "yao8Kq_warnText",
	"tabs": "yao8Kq_tabs",
	"checkinRow": "yao8Kq_checkinRow",
	"title": "yao8Kq_title",
	"signInBox": "yao8Kq_signInBox",
	"inlineForm": "yao8Kq_inlineForm",
	"header": "yao8Kq_header",
	"subtitle": "yao8Kq_subtitle",
	"accountActions": "yao8Kq_accountActions",
	"modelRow": "yao8Kq_modelRow",
	"modelName": "yao8Kq_modelName",
	"error": "yao8Kq_error",
	"section": "yao8Kq_section",
	"quotaBox": "yao8Kq_quotaBox",
	"card": "yao8Kq_card",
	"accountMain": "yao8Kq_accountMain",
	"notice": "yao8Kq_notice",
	"muted": "yao8Kq_muted",
	"list": "yao8Kq_list",
	"toolbar": "yao8Kq_toolbar",
	"modelMain": "yao8Kq_modelMain",
	"panelTitle": "yao8Kq_panelTitle",
	"modelMeta": "yao8Kq_modelMeta",
	"headerMain": "yao8Kq_headerMain"
};
// src/client/DevecoDock.tsx
/**
* 对话输入框下方那一行：`Provider DevEco · 模型 · 今日 tokens · 已签到`。
*
* 只在当前模型确实来自 `deveco` 时渲染 —— 别的 provider 的对话不该出现这一行。
* 状态每 60 秒刷一次（够用，且不给 `/status` 添压力）。
*
* @module dsh-deveco/client/DevecoDock
*/
/** 这个 provider 路由的名字（客户端不能 import 宿主模块，所以这里单独抄一份）。 */
const DEVECO_PROVIDER = "deveco";
/** 状态刷新间隔。 */
const REFRESH_INTERVAL_MS = 6e4;
/** 读当前选中的 provider/model。 */
function readSelection(useProjection) {
	if (useProjection === void 0) return void 0;
	try {
		const value = useProjection("modelSelection");
		if (typeof value !== "object" || value === null) return void 0;
		const raw = value;
		return {
			...typeof raw.provider === "string" ? { provider: raw.provider } : {},
			...typeof raw.model === "string" ? { model: raw.model } : {},
			...typeof raw.name === "string" ? { name: raw.name } : {}
		};
	} catch {
		return;
	}
}
function DevecoDock({ useProjection, t, onOpenSettings }) {
	const [status, setStatus] = (0, react.useState)(void 0);
	const selection = readSelection(useProjection);
	const isDeveco = selection?.provider === DEVECO_PROVIDER;
	(0, react.useEffect)(() => {
		let cancelled = false;
		const load = async () => {
			try {
				const response = await fetch("/api/deveco/status", { headers: { Accept: "application/json" } });
				if (!response.ok) return;
				const parsed = await response.json();
				if (!cancelled && parsed.status !== void 0) setStatus(parsed.status);
			} catch {}
		};
		load();
		const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);
	if (status === void 0 || !isDeveco) return null;
	if (status.dock.dock !== true) return null;
	const modelName = selection?.name ?? selection?.model ?? "";
	const todayTokens = status.usage.today.inputTokens + status.usage.today.outputTokens;
	const checkedIn = Object.values(status.checkin.today).some((record) => record.ok);
	const clickable = typeof onOpenSettings === "function";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		className: DevecoPluginCard_module_css_default.dockLine,
		role: clickable ? "button" : void 0,
		tabIndex: clickable ? 0 : void 0,
		onClick: clickable ? () => onOpenSettings?.() : void 0,
		onKeyDown: clickable ? (event) => {
			if (event.key === "Enter" || event.key === " ") onOpenSettings?.();
		} : void 0,
		title: status.accounts.length === 0 ? t("dockNone") : void 0,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: modelName === "" ? t("dockProvider") : `${t("dockProvider")} · ${modelName}` }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: DevecoPluginCard_module_css_default.dockSeparator,
				children: "|"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("dockUsage", { tokens: formatCount(todayTokens) }) }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: DevecoPluginCard_module_css_default.dockSeparator,
				children: "|"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: checkedIn ? t("dockCheckin") : t("checkinNever") })
		]
	});
}
// src/client/dock-store.ts
const DEFAULT_DOCK_FLAGS = {
	dock: true,
	sidebar: false,
	settingsEntry: true,
	autoClaim: false
};
let snapshot = {
	dock: DEFAULT_DOCK_FLAGS,
	writable: false,
	loaded: false
};
const listeners = /* @__PURE__ */ new Set();
function dockSnapshot() {
	return snapshot;
}
function publishDock(patch) {
	snapshot = {
		dock: {
			...snapshot.dock,
			...patch.dock ?? {}
		},
		writable: patch.writable ?? snapshot.writable,
		loaded: true
	};
	for (const listener of [...listeners]) try {
		listener();
	} catch {}
}
function subscribeDock(listener) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
// src/client/panel-switch.ts
function createWantedSwitch(initial) {
	let value = initial;
	const listeners = /* @__PURE__ */ new Set();
	return {
		get: () => value,
		set: (next) => {
			if (next === value) return;
			value = next;
			for (const listener of [...listeners]) try {
				listener();
			} catch {}
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}
/** 侧边栏图标列入口：缺省关（图标列是全宿主共用资源）。 */
const sidebarEntrySwitch = createWantedSwitch(false);
/** 设置左侧导航入口：缺省开。 */
const settingsEntrySwitch = createWantedSwitch(true);
const sidebarPanelWanted = sidebarEntrySwitch.get;
const setSidebarPanelWanted = sidebarEntrySwitch.set;
const subscribeSidebarPanelWanted = sidebarEntrySwitch.subscribe;
const settingsEntryWanted = settingsEntrySwitch.get;
const setSettingsEntryWanted = settingsEntrySwitch.set;
const subscribeSettingsEntryWanted = settingsEntrySwitch.subscribe;
// src/client/DevecoPluginCard.tsx
/**
* DevEco 插件卡片（设置页 / 侧边栏整页 / bundle 详情页共用同一个组件）。
*
* 卡片自己读状态：`GET /api/deveco/status` 一次拿到账号、模型、用量、签到与显示开关，
* 之后每 30 秒刷一次。所有写操作都返回新的状态文档，直接替换本地快照 —— 不靠「祈祷
* 下一次轮询能反映出来」。
*
* @module dsh-deveco/client/DevecoPluginCard
*/
/** 状态轮询间隔。 */
const POLL_MS = 3e4;
async function requestJson(path, init) {
	const response = await fetch(path, {
		...init,
		headers: {
			Accept: "application/json",
			...init?.body === void 0 ? {} : { "Content-Type": "application/json" },
			...init?.headers ?? {}
		}
	});
	const text = await response.text();
	const parsed = text === "" ? {} : JSON.parse(text);
	if (!response.ok) {
		const message = typeof parsed === "object" && parsed !== null && "error" in parsed ? String(parsed.error) : `HTTP ${response.status}`;
		throw new Error(message);
	}
	return parsed;
}
function statusOfDot(account) {
	if (account.usable !== true) return "error";
	if (account.paused) return "idle";
	if (account.slot?.coolUntil !== void 0 && account.slot.coolUntil > Date.now()) return "warning";
	return "done";
}
/** 一个账号行。 */
function AccountRow({ account, t, pending, onAction }) {
	const [renaming, setRenaming] = (0, react.useState)(false);
	const [draft, setDraft] = (0, react.useState)(account.label ?? "");
	const name = accountDisplayName(account, t("accountNoLabel"));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: DevecoPluginCard_module_css_default.accountRow,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: DevecoPluginCard_module_css_default.accountMain,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: DevecoPluginCard_module_css_default.accountTitle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: statusOfDot(account) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: DevecoPluginCard_module_css_default.accountName,
							children: name
						}),
						account.pinned ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "info",
							children: t("accountPinned")
						}) : null,
						account.usable !== true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "danger",
							children: t("accountNeedsLogin")
						}) : null,
						account.paused ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "neutral",
							children: t("accountPaused")
						}) : null,
						account.isRealName !== true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "warning",
							children: t("accountNotRealName")
						}) : null,
						account.streak > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "success",
							children: t("streakDays", { days: account.streak })
						}) : null
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: DevecoPluginCard_module_css_default.accountMeta,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.userId ?? account.id }),
						account.nationalCode === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: account.nationalCode }),
						account.accessTokenExpiresAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("accountAccessExpires", { time: formatWhen(account.accessTokenExpiresAt) }) }),
						account.ttlMs > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							title: t("quotaNote"),
							children: t("accountTtlLearned", {
								ttl: Math.round(account.ttlMs / 6e4),
								source: account.ttlSource,
								samples: account.ttlSamples
							})
						}) : null,
						account.slot === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							account.slot.activeConcurrent,
							"/",
							account.slot.maxConcurrent
						] }),
						account.slot?.lastError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: DevecoPluginCard_module_css_default.warnText,
							title: account.slot.lastError,
							children: "!"
						})
					]
				}),
				renaming ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: DevecoPluginCard_module_css_default.inlineForm,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
							value: draft,
							placeholder: t("accountRenamePlaceholder"),
							onChange: (event) => setDraft(event.target.value)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "outline",
							disabled: pending,
							onClick: () => {
								onAction("rename", draft);
								setRenaming(false);
							},
							children: "OK"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "ghost",
							onClick: () => setRenaming(false),
							children: "×"
						})
					]
				}) : null
			]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: DevecoPluginCard_module_css_default.accountActions,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "ghost",
					disabled: pending,
					onClick: () => setRenaming((value) => !value),
					children: t("accountRename")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "ghost",
					disabled: pending,
					onClick: () => onAction("refresh"),
					children: t("refreshCredential")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "ghost",
					disabled: pending,
					onClick: () => onAction(account.pinned ? "unpin" : "pin"),
					children: account.pinned ? t("accountUnpin") : t("accountPin")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "ghost",
					disabled: pending,
					onClick: () => onAction(account.paused ? "resume" : "pause"),
					children: account.paused ? t("accountResume") : t("accountPause")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "ghost",
					disabled: pending,
					onClick: () => onAction("remove"),
					children: t("accountDelete")
				})
			]
		})]
	});
}
/** 一个模型行。 */
function ModelRow({ model, enabled, t, onToggle }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
		className: DevecoPluginCard_module_css_default.modelRow,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
			checked: enabled,
			onChange: onToggle,
			label: ""
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: DevecoPluginCard_module_css_default.modelMain,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: DevecoPluginCard_module_css_default.modelTitle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: DevecoPluginCard_module_css_default.modelName,
						children: model.name
					}),
					model.wireId !== model.id ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: DevecoPluginCard_module_css_default.muted,
						children: model.wireId
					}) : null,
					model.supportsImages ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
						tone: "info",
						children: t("modelVision")
					}) : null,
					model.reasoning ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
						tone: "outline",
						children: t("modelReasoning")
					}) : null,
					model.hidden ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
						tone: "neutral",
						children: t("modelHidden")
					}) : null
				]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: DevecoPluginCard_module_css_default.modelMeta,
				children: [
					model.contextWindow === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelContext", { tokens: formatTokens(model.contextWindow) }) }),
					model.maxTokens === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelOutput", { tokens: formatTokens(model.maxTokens) }) }),
					model.levels === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelLevels", { levels: model.levels.join("/") }) })
				]
			})]
		})]
	});
}
function DevecoPluginCard({ t }) {
	const [status, setStatus] = (0, react.useState)(void 0);
	const [selection, setSelection] = (0, react.useState)(void 0);
	const [error, setError] = (0, react.useState)(void 0);
	const [busy, setBusy] = (0, react.useState)(void 0);
	const [tab, setTab] = (0, react.useState)("accounts");
	const [token, setToken] = (0, react.useState)("");
	const [notice, setNotice] = (0, react.useState)(void 0);
	const [dock, setDock] = (0, react.useState)(dockSnapshot().dock ?? DEFAULT_DOCK_FLAGS);
	const mounted = (0, react.useRef)(true);
	const loginUrl = (0, react.useRef)(void 0);
	const refresh = async () => {
		try {
			const [next, nextSelection] = await Promise.all([requestJson("/api/deveco/status"), requestJson("/api/deveco/enabled-models")]);
			if (!mounted.current) return;
			setStatus(next.status);
			setSelection(nextSelection.selection);
			setDock(next.status.dock);
			publishDock({
				dock: next.status.dock,
				writable: next.status.writable
			});
			setSettingsEntryWanted(next.status.dock.settingsEntry);
			setSidebarPanelWanted(next.status.dock.sidebar);
			setError(void 0);
		} catch (caught) {
			if (!mounted.current) return;
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	};
	(0, react.useEffect)(() => {
		mounted.current = true;
		refresh();
		const timer = setInterval(() => void refresh(), POLL_MS);
		const unsubscribe = subscribeDock(() => setDock(dockSnapshot().dock));
		return () => {
			mounted.current = false;
			clearInterval(timer);
			unsubscribe();
		};
	}, []);
	const tabs = (0, react.useMemo)(() => [
		{
			value: "accounts",
			label: t("tabAccounts"),
			id: "deveco-tab-accounts",
			panelId: "deveco-panel-accounts"
		},
		{
			value: "models",
			label: t("tabModels"),
			id: "deveco-tab-models",
			panelId: "deveco-panel-models"
		},
		{
			value: "checkin",
			label: t("tabCheckin"),
			id: "deveco-tab-checkin",
			panelId: "deveco-panel-checkin"
		},
		{
			value: "display",
			label: t("tabDisplay"),
			id: "deveco-tab-display",
			panelId: "deveco-panel-display"
		}
	], [t]);
	const accountAction = async (id, action, label) => {
		setBusy(`${action}:${id}`);
		try {
			if (action === "remove") {
				const next = await requestJson(`/api/deveco/accounts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
				setStatus(next.status);
			} else {
				const body = { id };
				if (action === "pause") body.paused = true;
				if (action === "resume") body.paused = false;
				if (action === "pin") body.pinned = true;
				if (action === "unpin") body.pinned = false;
				if (action === "refresh") body.refresh = true;
				if (action === "rename") body.label = label ?? "";
				const next = await requestJson("/api/deveco/accounts", {
					method: "POST",
					body: JSON.stringify(body)
				});
				setStatus(next.status);
			}
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	const signIn = async () => {
		setBusy("login");
		setNotice(t("signInOpening"));
		try {
			const started = await requestJson("/api/deveco/login", { method: "POST" });
			loginUrl.current = started.url;
			setNotice(t("signInWaiting"));
			pollLogin(started.url);
		} catch (caught) {
			setNotice(void 0);
			setError(caught instanceof Error ? caught.message : String(caught));
			setBusy(void 0);
		}
	};
	const pollLogin = async (url) => {
		try {
			for (let attempt = 0; attempt < 200; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				if (!mounted.current) return;
				let outcome;
				try {
					outcome = await requestJson(`/api/deveco/login/status?url=${encodeURIComponent(url)}`);
				} catch {
					continue;
				}
				if (outcome.state === "pending") continue;
				if (outcome.state === "done") {
					setNotice(t("signInDone"));
					await refresh();
				} else setNotice(t("signInFailed", { message: outcome.message ?? outcome.kind ?? "unknown" }));
				return;
			}
		} finally {
			if (mounted.current) setBusy(void 0);
		}
	};
	const saveToken = async () => {
		const trimmed = token.trim();
		if (trimmed.split(".").length !== 3) {
			setError(t("pasteTokenInvalid"));
			return;
		}
		setBusy("token");
		try {
			const next = await requestJson("/api/deveco/token", {
				method: "POST",
				body: JSON.stringify({ jwtToken: trimmed })
			});
			setStatus(next.status);
			setToken("");
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	const toggleModel = async (model, next) => {
		if (status === void 0 || selection === void 0) return;
		const enabledIds = selection.choices.filter((choice) => choice.enabled).map((choice) => choice.id);
		const set = new Set(enabledIds);
		if (next) set.add(model.id);
		else set.delete(model.id);
		const all = selection.choices.map((choice) => choice.id);
		const payload = set.size === all.length ? [] : [...set];
		setBusy("models");
		try {
			const result = await requestJson("/api/deveco/enabled-models", {
				method: "POST",
				body: JSON.stringify({ enabledModels: payload })
			});
			setSelection(result.selection);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	const refreshModels = async () => {
		setBusy("refresh-models");
		try {
			const result = await requestJson("/api/deveco/refresh-models", { method: "POST" });
			setSelection(result.selection);
			setStatus(result.status);
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	/**
	* 「刷新额度」：重新探测账号可用性。
	*
	* 它不可能查到「还剩多少」—— 上游没有这个接口 —— 所以按钮旁边必须写清楚它做了什么，
	* 否则用户点完会以为额度被刷新了。
	*/
	const refreshQuota = async () => {
		setBusy("quota");
		try {
			const result = await requestJson("/api/deveco/quota", {
				method: "POST",
				body: "{}"
			});
			setStatus(result.status);
			setNotice(`${t("quotaProbeDone", { count: result.outcome.probed })}：${result.outcome.message}`);
			setError(result.outcome.ok ? void 0 : result.outcome.message);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	const checkin = async (force) => {
		setBusy("checkin");
		try {
			const result = await requestJson("/api/deveco/checkin", {
				method: "POST",
				body: JSON.stringify({ force })
			});
			setStatus(result.status);
			const outcome = result.outcome;
			setNotice(outcome.ok ? `${t("checkinOk")}：${outcome.message}` : t("checkinFailed", { message: outcome.results.find((entry) => !entry.ok)?.message ?? outcome.message }));
			setError(void 0);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	/** 体检：读一次 /doctor，把结果写进 notice/error。 */
	const diagnose = async () => {
		setBusy("doctor");
		try {
			const result = await requestJson("/api/deveco/doctor");
			const failed = result.report.checks.find((check) => !check.ok);
			if (result.report.ok) {
				setNotice(t("doctorOk"));
				setError(void 0);
			} else {
				setNotice(void 0);
				setError(t("doctorFail", { detail: failed === void 0 ? "unknown" : `${failed.id}: ${failed.detail}` }));
			}
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(void 0);
		}
	};
	const setDockFlag = async (patch) => {
		setDock((current) => ({
			...current,
			...patch
		}));
		publishDock({ dock: patch });
		if (patch.sidebar !== void 0) setSidebarPanelWanted(patch.sidebar);
		if (patch.settingsEntry !== void 0) setSettingsEntryWanted(patch.settingsEntry);
		try {
			await requestJson("/api/deveco/dock", {
				method: "POST",
				body: JSON.stringify(patch)
			});
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	};
	const accounts = status?.accounts ?? [];
	const usage = status?.usage;
	/**
	* 客户端可能比宿主先更新（客户端产物会热重载，宿主模块不会），所以 `quota` 当成可选：
	* 旧宿主不返回它时就整块不渲染，而不是让整张卡片崩掉。
	*/
	const quota = status?.quota;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: DevecoPluginCard_module_css_default.card,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
				className: DevecoPluginCard_module_css_default.header,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: DevecoPluginCard_module_css_default.headerMain,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: DevecoPluginCard_module_css_default.title,
						children: t("cardTitle")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: DevecoPluginCard_module_css_default.subtitle,
						children: t("cardSubtitle")
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: DevecoPluginCard_module_css_default.headerMeta,
					children: [status === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: DevecoPluginCard_module_css_default.muted,
						children: t("statusLoading")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
						tone: accounts.length > 0 ? "success" : "warning",
						children: accounts.length === 0 ? t("signedOut") : t("signedInCount", { count: accounts.length })
					}), status === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: DevecoPluginCard_module_css_default.muted,
						children: t("versionLabel", { version: status.version })
					})]
				})]
			}),
			error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: DevecoPluginCard_module_css_default.error,
				children: t("loadFailed", { message: error })
			}),
			notice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: DevecoPluginCard_module_css_default.notice,
				children: notice
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SegmentedTabs, {
				items: tabs,
				value: tab,
				onChange: setTab,
				label: t("cardTitle"),
				className: DevecoPluginCard_module_css_default.tabs,
				size: "sm"
			}),
			tab === "accounts" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				id: "deveco-panel-accounts",
				role: "tabpanel",
				"aria-labelledby": "deveco-tab-accounts",
				className: DevecoPluginCard_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: DevecoPluginCard_module_css_default.signInBox,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							disabled: busy === "login",
							onClick: () => void signIn(),
							children: t("signIn")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: DevecoPluginCard_module_css_default.muted,
							children: t("signInHint")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: DevecoPluginCard_module_css_default.signInBox,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
							value: token,
							placeholder: t("pasteTokenPlaceholder"),
							onChange: (event) => setToken(event.target.value),
							className: DevecoPluginCard_module_css_default.tokenInput
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							disabled: busy === "token" || token.trim() === "",
							onClick: () => void saveToken(),
							children: t("pasteTokenSubmit")
						})]
					}),
					accounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: DevecoPluginCard_module_css_default.muted,
						children: t("signedOut")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: DevecoPluginCard_module_css_default.list,
						children: accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow, {
							account,
							t,
							pending: busy !== void 0 && busy.endsWith(`:${account.id}`),
							onAction: (action, label) => void accountAction(account.id, action, label)
						}, account.id))
					})
				]
			}) : null,
			tab === "models" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				id: "deveco-panel-models",
				role: "tabpanel",
				"aria-labelledby": "deveco-tab-models",
				className: DevecoPluginCard_module_css_default.section,
				children: [
					status?.lastDiscoveryError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: DevecoPluginCard_module_css_default.error,
						children: t("catalogStale", { message: status.lastDiscoveryError })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: DevecoPluginCard_module_css_default.toolbar,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								disabled: busy === "refresh-models",
								onClick: () => void refreshModels(),
								children: busy === "refresh-models" ? t("refreshing") : t("refreshModels")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "ghost",
								size: "sm",
								disabled: selection === void 0 || busy === "models",
								onClick: () => {
									if (selection === void 0) return;
									setBusy("models");
									requestJson("/api/deveco/enabled-models", {
										method: "POST",
										body: JSON.stringify({ enabledModels: [] })
									}).then((result) => setSelection(result.selection)).catch(() => {}).finally(() => setBusy(void 0));
								},
								children: t("selectAll")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: DevecoPluginCard_module_css_default.muted,
								children: selection === void 0 || !selection.restricted ? t("selectionAll") : t("selectionRestricted")
							})
						]
					}),
					(selection?.choices ?? []).length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: DevecoPluginCard_module_css_default.muted,
						children: t("modelsEmpty")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: DevecoPluginCard_module_css_default.muted,
						children: t("modelsEmptyHint")
					})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: DevecoPluginCard_module_css_default.list,
						children: (selection?.choices ?? []).map((choice) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelRow, {
							model: choice,
							enabled: choice.enabled,
							t,
							onToggle: (next) => void toggleModel(choice, next)
						}, choice.id))
					})
				]
			}) : null,
			tab === "checkin" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				id: "deveco-panel-checkin",
				role: "tabpanel",
				"aria-labelledby": "deveco-tab-checkin",
				className: DevecoPluginCard_module_css_default.section,
				children: [
					quota === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: DevecoPluginCard_module_css_default.quotaBox,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: DevecoPluginCard_module_css_default.toolbar,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: DevecoPluginCard_module_css_default.quotaTitle,
										children: t("quotaTitle")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
										tone: quota.exhausted.length > 0 ? "danger" : "outline",
										children: t("quotaWindow", { window: quota.window.label })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: DevecoPluginCard_module_css_default.muted,
										children: t("quotaResetIn", { time: quota.resetIn })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: DevecoPluginCard_module_css_default.muted,
										children: t("quotaUsage", { tokens: formatCount((usage?.today.inputTokens ?? 0) + (usage?.today.outputTokens ?? 0)) })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										disabled: busy === "quota",
										onClick: () => void refreshQuota(),
										children: busy === "quota" ? t("quotaRefreshing") : t("quotaRefresh")
									})
								]
							}),
							quota.exhausted.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: DevecoPluginCard_module_css_default.quotaExhausted,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
										tone: "danger",
										children: t("quotaExhaustedTag")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("quotaExhaustedNotice", { count: quota.exhausted.length }) }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: DevecoPluginCard_module_css_default.muted,
										children: quota.exhausted.map((id) => accountDisplayName(accounts.find((account) => account.id === id) ?? { id }, t("accountNoLabel"))).join(", ")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: DevecoPluginCard_module_css_default.note,
								children: t("quotaNote")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: DevecoPluginCard_module_css_default.toolbar,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							size: "sm",
							disabled: busy === "checkin",
							onClick: () => void checkin(false),
							children: busy === "checkin" ? t("checking") : t("checkinNow")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: DevecoPluginCard_module_css_default.muted,
							children: status?.checkin.day ?? ""
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: DevecoPluginCard_module_css_default.note,
						children: t("checkinNote")
					}),
					accounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: DevecoPluginCard_module_css_default.muted,
						children: t("signedOut")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: DevecoPluginCard_module_css_default.list,
						children: accounts.map((account) => {
							const record = status?.checkin.today[account.id];
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: DevecoPluginCard_module_css_default.checkinRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: record === void 0 ? "idle" : record.ok ? "done" : "error" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: DevecoPluginCard_module_css_default.accountName,
										children: accountDisplayName(account, t("accountNoLabel"))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: DevecoPluginCard_module_css_default.muted,
										children: record === void 0 ? t("checkinNever") : record.ok ? `${t("checkinAlready")} · ${formatWhen(record.at)}` : record.message ?? ""
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: DevecoPluginCard_module_css_default.muted,
										children: t("checkinStreak", { days: account.streak })
									})
								]
							}, account.id);
						})
					})
				]
			}) : null,
			tab === "display" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				id: "deveco-panel-display",
				role: "tabpanel",
				"aria-labelledby": "deveco-tab-display",
				className: DevecoPluginCard_module_css_default.section,
				children: [
					status !== void 0 && status.writable !== true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: DevecoPluginCard_module_css_default.muted,
						children: t("displayReadonly")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: DevecoPluginCard_module_css_default.switchRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked: dock.dock,
							onChange: (next) => void setDockFlag({ dock: next }),
							label: t("showDock")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("showDock") })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: DevecoPluginCard_module_css_default.switchRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked: dock.sidebar,
							onChange: (next) => void setDockFlag({ sidebar: next }),
							label: t("showSidebar")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("showSidebar") })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: DevecoPluginCard_module_css_default.switchRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked: dock.settingsEntry,
							onChange: (next) => void setDockFlag({ settingsEntry: next }),
							label: t("showSettings")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("showSettings") })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: DevecoPluginCard_module_css_default.switchRow,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
								checked: dock.autoClaim,
								onChange: (next) => void setDockFlag({ autoClaim: next }),
								label: t("autoCheckin")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("autoCheckin") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: DevecoPluginCard_module_css_default.muted,
								children: t("autoCheckinHint")
							})
						]
					})
				]
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
				className: DevecoPluginCard_module_css_default.footer,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: DevecoPluginCard_module_css_default.footerTitle,
						children: t("usageTitle")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageTodayRequests", { count: formatCount(usage?.today.requests ?? 0) }) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageTodayInput", { tokens: formatCount(usage?.today.inputTokens ?? 0) }) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("usageTodayOutput", { tokens: formatCount(usage?.today.outputTokens ?? 0) }) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: DevecoPluginCard_module_css_default.muted,
						title: t("usageScope"),
						children: t("usageScope")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "ghost",
						disabled: busy === "doctor",
						onClick: () => void diagnose(),
						children: t("doctor")
					})
				]
			})
		]
	});
}
// src/client/DevecoPanel.tsx
/** 侧边栏图标（16×16，正六边形里一个 D 形切口 —— 呼应 DevEco 的六边形视觉）。 */
function DevecoPanelIcon({ size = 16 }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		width: size,
		height: size,
		viewBox: "0 0 16 16",
		fill: "none",
		"aria-hidden": "true",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M8 1.6 13.2 4.6v6L8 13.6 2.8 10.6v-6L8 1.6Z",
			stroke: "currentColor",
			strokeWidth: "1.2",
			strokeLinejoin: "round"
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M6.1 5.4h2.2a2.6 2.6 0 0 1 0 5.2H6.1V5.4Z",
			fill: "currentColor",
			opacity: "0.85"
		})]
	});
}
/** 侧边栏里的整页版本：一个返回按钮 + 同一张卡片。 */
function DevecoPanelPage({ t, backToConversation }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: DevecoPluginCard_module_css_default.panel,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: DevecoPluginCard_module_css_default.panelHeader,
			children: [backToConversation === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				variant: "ghost",
				size: "sm",
				onClick: () => backToConversation(),
				children: ["← ", t("backToConversation")]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
				className: DevecoPluginCard_module_css_default.panelTitle,
				children: t("panelTitle")
			})]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DevecoPluginCard, { t })]
	});
}
// src/client/locales.ts
const zh = {
	tabLabel: "DevEco",
	panelTitle: "DevEco Code",
	backToConversation: "返回对话",
	cardTitle: "DevEco Code",
	cardSubtitle: "华为 CodeGenie MaaS · GLM-5.1 / GLM-5.3 / Qwen 视觉",
	providerLabel: "供应商",
	statusLoading: "读取中…",
	loadFailed: "读取状态失败：{message}",
	tabAccounts: "账号",
	tabModels: "模型",
	tabCheckin: "额度 · 签到",
	tabDisplay: "显示",
	signedOut: "还没有登录任何账号",
	signedInCount: "已登录 {count} 个账号",
	signIn: "登录华为账号",
	signInHint: "会打开华为登录页，授权完成后自动回到这里。只支持中国大陆账号。",
	signInOpening: "正在打开登录页…",
	signInWaiting: "已打开登录页，等你在浏览器里完成登录…",
	signInDone: "登录成功",
	signInFailed: "登录失败：{message}",
	pasteToken: "或者直接粘贴 jwtToken",
	pasteTokenPlaceholder: "粘贴以 eyJ 开头的 jwtToken",
	pasteTokenSubmit: "保存令牌",
	pasteTokenInvalid: "这看起来不是 jwtToken（需要三段、用点分隔）",
	refreshCredential: "刷新凭证",
	accountUsable: "可用",
	accountNeedsLogin: "需重新登录",
	accountPaused: "已暂停",
	accountPinned: "置顶",
	accountBusy: "忙碌中",
	accountNotRealName: "未实名",
	accountDelete: "删除",
	accountPause: "暂停",
	accountResume: "恢复",
	accountPin: "置顶",
	accountUnpin: "取消置顶",
	accountRename: "改备注",
	accountRenamePlaceholder: "备注名（留空清除）",
	accountNoLabel: "未命名账号",
	streakDays: "连续 {days} 天",
	accountAccessExpires: "访问令牌 {time} 到期",
	accountTtlLearned: "令牌寿命 ~{ttl} 分钟（{source}，{samples} 个样本）",
	modelsEmpty: "模型目录是空的",
	modelsEmptyHint: "登录后会自动从上游拉取模型列表；也可以点下面的「刷新模型」。",
	catalogStale: "上次刷新模型失败（现在显示的是旧目录）：{message}",
	refreshModels: "刷新模型",
	refreshing: "刷新中…",
	modelContext: "{tokens} 上下文",
	modelOutput: "{tokens} 输出",
	modelVision: "识图",
	modelReasoning: "思考",
	modelHidden: "隐藏",
	modelLevels: "档位 {levels}",
	selectAll: "全选",
	clearSelection: "全不选",
	selectionAll: "全部模型都会出现在选择器里",
	selectionRestricted: "只显示勾选的模型",
	checkinTitle: "每日签到",
	checkinNote: "DevEco 没有积分/领取接口，免费额度每天自动重置。这里的签到是每天一次的真实体检：逐个账号拉一次模型目录，证明凭证今天还能用，并记录连续天数。",
	checkinNow: "立即签到",
	checking: "签到中…",
	checkinOk: "签到成功",
	checkinFailed: "签到失败：{message}",
	checkinAlready: "今天已签到",
	checkinNever: "还没签到",
	checkinStreak: "连续签到 {days} 天",
	checkinToday: "今日",
	quotaTitle: "额度",
	quotaWindow: "额度窗口 {window}",
	quotaResetIn: "{time} 后重置",
	quotaExhaustedTag: "额度用尽",
	quotaUsage: "本窗口本机 {tokens} tokens",
	quotaRefresh: "刷新额度",
	quotaRefreshing: "探测中…",
	quotaNote: "DevEco 不提供额度查询接口，所以这里没有「剩余额度」这个数字。「刷新额度」也不会让额度变多：它重新探测每个账号现在还能不能用（拉一次模型目录），并刷新本窗口的重置时间；真正用尽时上游会拒绝请求，插件会把那个账号标成「额度用尽」直到窗口重置。",
	quotaProbeDone: "已探测 {count} 个账号",
	quotaExhaustedNotice: "{count} 个账号在本窗口被上游判为额度用尽",
	displayTitle: "显示",
	showDock: "在对话输入框下方显示 DevEco 状态行",
	showSidebar: "在侧边栏图标列显示 DevEco 入口",
	showSettings: "在设置左侧导航显示 DevEco 入口",
	autoCheckin: "每天自动签到",
	autoCheckinHint: "打开后，DSH 启动 30 秒后会签到一次，之后每 6 小时检查一次（一天只签一次）。",
	displayReadonly: "当前宿主没有设置服务，这些开关不可写。",
	usageTitle: "本机用量",
	usageTodayRequests: "今日请求 {count}",
	usageTodayInput: "输入 {tokens}",
	usageTodayOutput: "输出 {tokens}",
	usageScope: "只统计本机经本插件发出的请求，不等于账号总额度",
	versionLabel: "版本 {version}",
	doctor: "体检",
	doctorOk: "体检通过",
	doctorFail: "体检发现问题：{detail}",
	dockProvider: "Provider DevEco",
	dockUsage: "今日 {tokens} tokens",
	dockCheckin: "已签到",
	dockNone: "未登录"
};
const en = {
	tabLabel: "DevEco",
	panelTitle: "DevEco Code",
	backToConversation: "Back to conversation",
	cardTitle: "DevEco Code",
	cardSubtitle: "Huawei CodeGenie MaaS · GLM-5.1 / GLM-5.3 / Qwen vision",
	providerLabel: "Provider",
	statusLoading: "Loading…",
	loadFailed: "Could not read the plugin status: {message}",
	tabAccounts: "Accounts",
	tabModels: "Models",
	tabCheckin: "Quota · Check-in",
	tabDisplay: "Display",
	signedOut: "No account signed in yet",
	signedInCount: "{count} account(s) signed in",
	signIn: "Sign in with Huawei",
	signInHint: "Opens the Huawei sign-in page; it comes back here when you are done. China-region accounts only.",
	signInOpening: "Opening the sign-in page…",
	signInWaiting: "Waiting for you to finish signing in in the browser…",
	signInDone: "Signed in",
	signInFailed: "Sign-in failed: {message}",
	pasteToken: "Or paste a jwtToken directly",
	pasteTokenPlaceholder: "Paste the jwtToken that starts with eyJ",
	pasteTokenSubmit: "Save token",
	pasteTokenInvalid: "That does not look like a jwtToken (three dot-separated parts)",
	refreshCredential: "Refresh credential",
	accountUsable: "Ready",
	accountNeedsLogin: "Sign in again",
	accountPaused: "Paused",
	accountPinned: "Pinned",
	accountBusy: "Busy",
	accountNotRealName: "Not real-name verified",
	accountDelete: "Remove",
	accountPause: "Pause",
	accountResume: "Resume",
	accountPin: "Pin",
	accountUnpin: "Unpin",
	accountRename: "Rename",
	accountRenamePlaceholder: "Label (empty clears it)",
	accountNoLabel: "Unnamed account",
	streakDays: "{days}-day streak",
	accountAccessExpires: "Access token expires {time}",
	accountTtlLearned: "Token lifetime ~{ttl} min ({source}, {samples} sample(s))",
	modelsEmpty: "The model catalog is empty",
	modelsEmptyHint: "Signing in pulls the upstream catalog automatically; you can also press \"Refresh models\".",
	catalogStale: "The last catalog refresh failed (showing the previous list): {message}",
	refreshModels: "Refresh models",
	refreshing: "Refreshing…",
	modelContext: "{tokens} context",
	modelOutput: "{tokens} output",
	modelVision: "Vision",
	modelReasoning: "Thinking",
	modelHidden: "Hidden",
	modelLevels: "Levels {levels}",
	selectAll: "Select all",
	clearSelection: "Select none",
	selectionAll: "Every model is offered in the pickers",
	selectionRestricted: "Only the checked models are offered",
	checkinTitle: "Daily check-in",
	checkinNote: "DevEco has no points or claim endpoint — the free quota resets daily on its own. This check-in is a real daily probe: it fetches the model catalog for each account, proves the credential still works, and keeps a streak.",
	checkinNow: "Check in now",
	checking: "Checking in…",
	checkinOk: "Checked in",
	checkinFailed: "Check-in failed: {message}",
	checkinAlready: "Checked in today",
	checkinNever: "Not checked in yet",
	checkinStreak: "{days}-day streak",
	checkinToday: "Today",
	quotaTitle: "Quota",
	quotaWindow: "Quota window {window}",
	quotaResetIn: "resets in {time}",
	quotaExhaustedTag: "Out of quota",
	quotaUsage: "{tokens} tokens from this device this window",
	quotaRefresh: "Refresh quota",
	quotaRefreshing: "Probing…",
	quotaNote: "DevEco exposes no quota endpoint, so there is no \"remaining\" number here. \"Refresh quota\" does not add any quota: it re-probes whether each account can still be used (one model-catalog fetch) and refreshes this window's reset time. When the quota really runs out the upstream rejects requests, and the plugin marks that account \"out of quota\" until the window resets.",
	quotaProbeDone: "Probed {count} account(s)",
	quotaExhaustedNotice: "{count} account(s) are out of quota for this window",
	displayTitle: "Display",
	showDock: "Show the DevEco status line under the chat input box",
	showSidebar: "Show a DevEco entry in the sidebar icon column",
	showSettings: "Show a DevEco entry in the settings left navigation",
	autoCheckin: "Check in automatically every day",
	autoCheckinHint: "When on, it checks in 30 seconds after DSH starts and re-checks every 6 hours (once per day).",
	displayReadonly: "This host has no settings service, so these switches are read-only.",
	usageTitle: "Local usage",
	usageTodayRequests: "{count} request(s) today",
	usageTodayInput: "{tokens} in",
	usageTodayOutput: "{tokens} out",
	usageScope: "Only requests this plugin sent from this machine; not the account total",
	versionLabel: "Version {version}",
	doctor: "Diagnose",
	doctorOk: "All checks passed",
	doctorFail: "A check failed: {detail}",
	dockProvider: "Provider DevEco",
	dockUsage: "{tokens} tokens today",
	dockCheckin: "Checked in",
	dockNone: "Not signed in"
};
// src/client/settings-route.ts
/**
* 打开「设置 → DevEco」这一页，不依赖宿主的私有 API。
*
* 两条路：
* 1. 新壳：设置面板在 `sidebar.settings` 槽上留了一个 store，`actions.openSection(id)` 直接开；
* 2. 老壳：先 `shortcuts.invoke('settings.open')`，再在设置弹层里点同名导航行。
*
* 两条都失败时返回 false，由调用方决定退路（卡片自己就在设置里，通常不必退）。
*
* @module dsh-deveco/client/settings-route
*/
/** 设置壳所在的槽位键。 */
const SETTINGS_SLOT = "sidebar.settings";
/** 老壳里重试点击的节奏（毫秒）。 */
const RETRY_DELAYS_MS = [
	0,
	60,
	70,
	80,
	90
];
function openViaStore(deps) {
	try {
		const entries = deps.slots?.entries?.(SETTINGS_SLOT) ?? [];
		for (const entry of entries) {
			const open = (entry.store?.create?.())?.actions?.openSection;
			if (typeof open === "function") {
				open(deps.sectionId);
				return true;
			}
		}
	} catch {}
	return false;
}
function openViaShortcut(deps) {
	const invoke = deps.shortcuts?.invoke;
	if (typeof invoke !== "function") return false;
	const doc = deps.doc ?? (typeof document === "undefined" ? void 0 : document);
	if (doc === void 0) return false;
	const schedule = deps.schedule ?? ((run, ms) => {
		setTimeout(run, ms).unref?.();
	});
	const wanted = (deps.label?.() ?? deps.sectionId).trim();
	invoke("settings.open", { modal: null });
	for (const delay of RETRY_DELAYS_MS) schedule(() => {
		const row = [...(doc.querySelector("[data-shortcut-modal=\"settings\"]") ?? doc).querySelectorAll("[role=\"tab\"], button, [role=\"menuitem\"]")].find((element) => (element.textContent ?? "").trim() === wanted);
		if (row instanceof HTMLElement) row.click();
	}, delay);
	return true;
}
/** 尽力打开设置里的 DevEco 分节；两条路都不通时返回 false。 */
function openPluginSettings(deps) {
	return openViaStore(deps) || openViaShortcut(deps);
}
// src/client/index.tsx
/** 卡片文案的命名空间。 */
const NAMESPACE = "settings.deveco";
/** 侧边栏图标与 `main` 面板共用的 key。 */
const PANEL_ID = "dsh-deveco";
const name = "dsh-deveco-client";
const inject = ["slots", "locale"];
function apply(ctx) {
	try {
		ctx.effect(() => ctx.locale.register(NAMESPACE, {
			zh,
			en
		}), "dsh-deveco: settings copy");
		const t = ctx.locale.bind(NAMESPACE);
		ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
			name: "plugins.bundle.config",
			key: "dsh-deveco",
			locale: NAMESPACE
		}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DevecoPluginCard, { t })));
		const layout = ctx.get("layout");
		const shortcuts = ctx.get("shortcuts");
		const openSettings = () => openPluginSettings({
			slots: ctx.get("slots"),
			shortcuts,
			sectionId: PANEL_ID,
			label: () => t("tabLabel")
		});
		try {
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "deveco-dock",
				order: 30,
				locale: NAMESPACE,
				inject: () => ({
					t,
					zone: "bar",
					onOpenSettings: openSettings
				})
			}, DevecoDock));
		} catch (error) {
			console.warn("[dsh-deveco] conversation dock slot unavailable:", error);
		}
		const panelClaims = [];
		const syncPanel = () => {
			for (const claim of panelClaims.splice(0)) try {
				claim();
			} catch {}
			if (!sidebarPanelWanted()) return;
			panelClaims.push(ctx.slots.inject("sidebar.panellist", () => {
				try {
					return ctx.slots.register({
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: 50,
						label: () => t("tabLabel"),
						locale: NAMESPACE
					}, DevecoPanelIcon);
				} catch (error) {
					console.warn("[dsh-deveco] sidebar icon registration failed:", error);
					return () => {};
				}
			}));
			panelClaims.push(ctx.slots.inject("main", () => {
				try {
					return ctx.slots.register({
						name: "main",
						key: PANEL_ID,
						locale: NAMESPACE,
						inject: () => ({
							t,
							backToConversation: () => layout?.selectPanel?.(null)
						})
					}, DevecoPanelPage);
				} catch (error) {
					console.warn("[dsh-deveco] sidebar page registration failed:", error);
					return () => {};
				}
			}));
		};
		const settingsClaims = [];
		const syncSettingsEntry = () => {
			for (const claim of settingsClaims.splice(0)) try {
				claim();
			} catch {}
			if (!settingsEntryWanted()) return;
			settingsClaims.push(ctx.slots.inject("settings.section", () => {
				try {
					return ctx.slots.register({
						name: "settings.section",
						id: PANEL_ID,
						order: 50,
						label: () => t("tabLabel"),
						locale: NAMESPACE,
						inject: () => ({ t })
					}, DevecoPluginCard);
				} catch (error) {
					console.warn("[dsh-deveco] settings section registration failed:", error);
					return () => {};
				}
			}));
		};
		syncPanel();
		syncSettingsEntry();
		ctx.effect(() => {
			const offPanel = subscribeSidebarPanelWanted(syncPanel);
			const offSettings = subscribeSettingsEntryWanted(syncSettingsEntry);
			return () => {
				offPanel();
				offSettings();
				for (const claim of panelClaims.splice(0)) claim();
				for (const claim of settingsClaims.splice(0)) claim();
			};
		}, "dsh-deveco: navigation entries");
		(async () => {
			try {
				const response = await fetch("/api/deveco/dock", { headers: { Accept: "application/json" } });
				if (!response.ok) return;
				const data = await response.json();
				setSidebarPanelWanted(data.dock?.sidebar === true);
				setSettingsEntryWanted(data.dock?.settingsEntry !== false);
			} catch {}
		})();
	} catch (error) {
		console.error("[dsh-deveco] client card failed to load (host provider unaffected):", error);
	}
}
exports.apply = apply;
exports.inject = inject;
exports.name = name;

    return module.exports;
  }
});

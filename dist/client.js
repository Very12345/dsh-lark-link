window.__ModuleLoader__.load({
	id: "@very12345/dsh-lark-link",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/index.ts
		const { createElement: h, useState, useEffect } = require("react");
		const win = globalThis;
		const name = "dsh-lark-link-client";
		const inject = ["slots"];
		/**
		* Compatibility shim for the legacy `settingsScope` client service.
		*
		* DSH 0.1.7-rc dropped that service (settings are now declared host-side via
		* `settings.installSection` and rendered by the generic settings UI), but the
		* WebAgent integration plugin shipped INSIDE webagent-dsh-core 7.4.4 still
		* injects it — so its client entry parks at
		* `pending (waiting for service: settingsScope)` and the GUI reports
		* "1 entry did not activate".
		*
		* The adaptation belongs HERE, in our plugin, rather than as a patch to the
		* vendor's versioned code: supplying the legacy contract lets that entry
		* activate untouched. It is deliberately READ-ONLY (`writable: false`): the
		* value the card shows is owned by the profile patch layer
		* (`webagent-integration.patch.yml` sets the search provider), so there is
		* nothing for the GUI to write back.
		*
		* `bind()` must hand back a STABLE snapshot object — the vendor card feeds it
		* to `React.useSyncExternalStore`, which re-renders forever on a new reference.
		*/
		function installLegacySettingsScope(ctx) {
			const compat = ctx;
			if (typeof compat.provide !== "function") return;
			try {
				if (compat.get?.("settingsScope")) return;
				const snapshots = /* @__PURE__ */ new Map();
				compat.provide("settingsScope", { bind(spec) {
					const namespace = String(spec?.namespace ?? "");
					let snapshot = snapshots.get(namespace);
					if (!snapshot) {
						snapshot = {
							status: "ready",
							writable: false,
							value: { provider: "deepseek" }
						};
						snapshots.set(namespace, snapshot);
					}
					return {
						getSnapshot: () => snapshot,
						subscribe: () => () => {},
						set: () => snapshot
					};
				} });
			} catch {}
		}
		function deriveState(s) {
			if (!s) return "loading";
			if (!s.configured) return "setup";
			switch (s.connState) {
				case "connected": return "running";
				case "connecting":
				case "reconnecting": return "connecting";
				case "degraded":
				case "quarantined": return "error";
				default: return "ready";
			}
		}
		const STATE_VIEW = {
			setup: {
				emoji: "⚙️",
				label: "未配置",
				color: "#ffb454",
				bg: "rgba(255,180,84,.12)",
				hint: "手机飞书扫码，或在输入框运行 /lark setup"
			},
			ready: {
				emoji: "✅",
				label: "已配置 · 待启动",
				color: "#7fd1ff",
				bg: "rgba(127,209,255,.12)",
				hint: "开启桥接后，即可从飞书与助手对话。"
			},
			connecting: {
				emoji: "🟡",
				label: "连接中…",
				color: "#ffd66b",
				bg: "rgba(255,214,107,.12)",
				hint: "正在建立飞书长连接"
			},
			running: {
				emoji: "🟢",
				label: "运行中",
				color: "#7ee2a8",
				bg: "rgba(126,226,168,.12)",
				hint: "连接正常，飞书消息会进入当前桥接。"
			},
			error: {
				emoji: "🔴",
				label: "连接异常",
				color: "var(--dsw-alias-label-primary, #1f2937)",
				bg: "rgba(255,138,128,.12)",
				hint: "/lark restart 重连 · /lark status 查看详情"
			}
		};
		function apply(ctx) {
			installLegacySettingsScope(ctx);
			const LarkLinkSection = () => {
				const [st, setSt] = useState(void 0);
				const [qrTs, setQrTs] = useState(0);
				const [qrLoaded, setQrLoaded] = useState(false);
				const [manualOpen, setManualOpen] = useState(false);
				const [appId, setAppId] = useState("");
				const [appSecret, setAppSecret] = useState("");
				const [domain, setDomain] = useState("feishu");
				const [manualSaving, setManualSaving] = useState(false);
				const [manualError, setManualError] = useState("");
				const [manualNotice, setManualNotice] = useState("");
				const [users, setUsers] = useState([]);
				const [instanceHost, setInstanceHost] = useState("");
				const [controlBusy, setControlBusy] = useState("");
				const [policyOpen, setPolicyOpen] = useState(false);
				const [policySaving, setPolicySaving] = useState(false);
				const [policyDraft, setPolicyDraft] = useState(void 0);
				const [effectiveDefaultModel, setEffectiveDefaultModel] = useState("");
				const [modelCatalog, setModelCatalog] = useState([]);
				useEffect(() => {
					const origin = win.location?.origin ?? "";
					const fetchStatus = () => {
						win.fetch?.(`${origin}/plugins/lark-link/status`).then((r) => r.ok ? r.json() : Promise.reject(/* @__PURE__ */ new Error("status"))).then((j) => setSt(j)).catch(() => setSt((prev) => prev));
						win.fetch?.(`${origin}/plugins/lark-link/management`).then((r) => r.ok ? r.json() : Promise.reject(/* @__PURE__ */ new Error("management"))).then((value) => {
							const management = value;
							if (management.status) setSt((previous) => ({
								...previous,
								...management.status
							}));
							setInstanceHost(String(management.instance?.host ?? ""));
							setUsers(Array.isArray(management.users) ? management.users : []);
							setModelCatalog(Array.isArray(management.modelCatalog) ? management.modelCatalog : []);
							if (management.policy) {
								setEffectiveDefaultModel(management.policy.effectiveDefaultModel ?? "");
								setPolicyDraft((previous) => previous?.dirty ? previous : {
									restricted: management.policy?.modelAccess?.restricted === true,
									allowedModels: management.policy?.modelAccess?.allowedModels ?? [],
									defaultModel: management.policy?.modelAccess?.defaultModel ?? "",
									workspaceRoot: management.policy?.workspaceRoot ?? "",
									dirty: false
								});
							}
						}).catch(() => void 0);
					};
					fetchStatus();
					const stId = setInterval(fetchStatus, 3e3);
					const qrId = setInterval(() => setQrTs(Date.now()), 4e3);
					setQrTs(Date.now());
					return () => {
						clearInterval(stId);
						clearInterval(qrId);
					};
				}, []);
				const state = deriveState(st);
				const origin = win.location?.origin ?? "";
				const showQr = state === "setup";
				const valueOf = (event) => String(event?.target?.value ?? "");
				const saveManualCredentials = () => {
					if (manualSaving) return;
					if (!appId.trim() || !appSecret.trim()) {
						setManualError("请填写 App ID 和 App Secret");
						return;
					}
					setManualSaving(true);
					setManualError("");
					setManualNotice("");
					win.fetch?.(`${origin}/plugins/lark-link/credentials`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							appId: appId.trim(),
							appSecret,
							domain
						})
					}).then(async (response) => {
						const value = await response.json();
						if (!response.ok || !value.ok) throw new Error(value.error || `保存失败（HTTP ${response.status}）`);
						setAppSecret("");
						setManualOpen(false);
						setUsers((previous) => value.appSwitched ? [] : previous);
						setManualNotice(value.appSwitched ? "已切换机器人并清空旧机器人的路由、补发队列和会话映射。" : "凭据已保存，桥接已重新连接。");
						setSt((previous) => ({
							...previous,
							configured: true,
							appIdMasked: value.appIdMasked,
							domain: value.domain,
							connState: value.connState ?? "connected"
						}));
					}).catch((error) => setManualError(error instanceof Error ? error.message : "手动配置失败")).finally(() => setManualSaving(false));
				};
				const runControl = (action) => {
					if (controlBusy) return;
					setControlBusy(action);
					setManualNotice("");
					setManualError("");
					win.fetch?.(`${origin}/plugins/lark-link/control`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ action })
					}).then(async (response) => {
						const value = await response.json();
						if (!response.ok || !value.ok) throw new Error(value.error || `操作失败（HTTP ${response.status}）`);
						setSt((previous) => ({
							...previous,
							connState: value.connState
						}));
						setManualNotice(action === "stop" ? "桥接已停止。" : action === "restart" ? "桥接已重新连接。" : "桥接已启动。");
					}).catch((error) => setManualError(error instanceof Error ? error.message : "管理操作失败")).finally(() => setControlBusy(""));
				};
				const savePolicy = () => {
					if (policySaving || !policyDraft) return;
					if (policyDraft.restricted && policyDraft.allowedModels.length === 0) {
						setManualError("启用模型白名单时至少保留一个模型");
						return;
					}
					setPolicySaving(true);
					setManualError("");
					setManualNotice("");
					win.fetch?.(`${origin}/plugins/lark-link/policy`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							modelAccess: {
								restricted: policyDraft.restricted,
								allowedModels: policyDraft.allowedModels,
								defaultModel: policyDraft.defaultModel
							},
							workspaceRoot: policyDraft.workspaceRoot
						})
					}).then(async (response) => {
						const value = await response.json();
						if (!response.ok || !value.ok) throw new Error(value.error || `保存失败（HTTP ${response.status}）`);
						setPolicyDraft({
							restricted: value.modelAccess?.restricted === true,
							allowedModels: value.modelAccess?.allowedModels ?? [],
							defaultModel: value.modelAccess?.defaultModel ?? "",
							workspaceRoot: value.workspaceRoot ?? "",
							dirty: false
						});
						setManualNotice("模型访问策略和默认工作区已保存。下一轮请求生效。");
					}).catch((error) => setManualError(error instanceof Error ? error.message : "策略保存失败")).finally(() => setPolicySaving(false));
				};
				const view = state === "loading" ? {
					emoji: "…",
					label: "读取状态",
					color: "var(--dsw-alias-label-primary, #1f2937)",
					bg: "rgba(255,255,255,.05)",
					hint: ""
				} : STATE_VIEW[state];
				const extras = [];
				if (st?.outboxPending && st.outboxPending > 0) extras.push(`待发 ${st.outboxPending}`);
				if (st?.outboxFailed && st.outboxFailed > 0) extras.push(`失败 ${st.outboxFailed}`);
				if (st?.inboundFailed && st.inboundFailed > 0) extras.push(`补发失败 ${st.inboundFailed}`);
				const banner = h("span", {
					className: "dshp-status",
					"data-ok": state === "running",
					"data-warn": state === "connecting" || state === "error"
				}, h("span", { className: "dshp-dot" }), view.label);
				const credentialSummary = st?.appIdMasked ? h("div", { style: {
					marginBottom: "10px",
					opacity: .75,
					fontSize: "12px"
				} }, `当前：${st.appIdMasked} · ${st.domain === "lark" ? "Lark" : "飞书"}${instanceHost ? ` · 主机 ${instanceHost}` : ""}`) : null;
				const fieldStyle = {
					boxSizing: "border-box",
					width: "100%",
					padding: "7px 8px",
					border: "1px solid var(--dsw-alias-border-l3, #e4e7ec)",
					borderRadius: "7px",
					background: "var(--dsw-alias-bg-layer-2, #fff)",
					color: "var(--dsw-alias-label-primary, #1f2937)",
					font: "inherit"
				};
				const manualToggle = h("button", {
					type: "button",
					className: "dshp-disclosure",
					"aria-expanded": manualOpen,
					onClick: () => {
						setManualOpen((v) => !v);
						setManualError("");
					}
				}, h("span", null, "机器人凭据"), h("span", null, manualOpen ? "⌄" : "›"));
				const manualForm = manualOpen ? h("div", { style: {
					display: "grid",
					gap: "8px",
					padding: "10px",
					marginBottom: "10px",
					border: "1px solid rgba(255,255,255,.12)",
					borderRadius: "8px",
					background: "var(--dsw-alias-bg-layer-1, #ffffff)"
				} }, h("label", { htmlFor: "lark-app-id" }, "App ID"), h("input", {
					type: "text",
					id: "lark-app-id",
					value: appId,
					autoComplete: "off",
					spellCheck: false,
					placeholder: "cli_xxxxxxxxxxxxxxxx",
					onChange: (event) => setAppId(valueOf(event)),
					style: fieldStyle
				}), h("label", { htmlFor: "lark-app-secret" }, "App Secret"), h("input", {
					type: "password",
					id: "lark-app-secret",
					value: appSecret,
					autoComplete: "new-password",
					spellCheck: false,
					placeholder: "不会回显或写入普通配置",
					onChange: (event) => setAppSecret(valueOf(event)),
					style: fieldStyle
				}), h("label", { htmlFor: "lark-domain" }, "服务区域"), h("select", {
					id: "lark-domain",
					value: domain,
					onChange: (event) => setDomain(valueOf(event) === "lark" ? "lark" : "feishu"),
					style: fieldStyle
				}, h("option", { value: "feishu" }, "飞书（中国大陆）"), h("option", { value: "lark" }, "Lark（国际版）")), manualError ? h("div", { style: {
					color: "var(--dsw-alias-label-primary, #1f2937)",
					whiteSpace: "pre-wrap"
				} }, manualError) : null, h("button", {
					type: "button",
					disabled: manualSaving,
					onClick: saveManualCredentials,
					style: {
						padding: "8px 10px",
						border: "none",
						borderRadius: "7px",
						background: "#3d64df",
						color: "white",
						cursor: manualSaving ? "default" : "pointer",
						opacity: manualSaving ? .65 : 1,
						font: "inherit"
					}
				}, manualSaving ? "保存并重连中…" : "保存并重连")) : null;
				const notice = manualNotice ? h("div", { style: {
					marginBottom: "10px",
					padding: "8px",
					borderRadius: "7px",
					background: "rgba(126,226,168,.1)",
					color: "var(--dsw-alias-label-primary, #1f2937)"
				} }, manualNotice) : null;
				const flatModels = modelCatalog.flatMap((group) => group.models.map((model) => ({
					ref: `${group.provider}/${model.id}`,
					label: `${group.label || group.provider} · ${model.name || model.id}`
				})));
				const policyToggle = h("button", {
					type: "button",
					className: "dshp-disclosure",
					"aria-expanded": policyOpen,
					onClick: () => {
						setPolicyOpen((v) => !v);
						setManualError("");
					}
				}, h("span", null, "模型与工作区"), h("span", null, policyOpen ? "⌄" : "›"));
				const selectableDefaults = flatModels.filter((model) => !policyDraft?.restricted || policyDraft.allowedModels.includes(model.ref));
				const policyForm = policyOpen && policyDraft ? h("div", { style: {
					display: "grid",
					gap: "8px",
					padding: "10px",
					marginBottom: "10px",
					border: "1px solid rgba(255,255,255,.12)",
					borderRadius: "8px",
					background: "var(--dsw-alias-bg-layer-1, #ffffff)"
				} }, h("label", { style: {
					display: "flex",
					gap: "7px",
					alignItems: "center"
				} }, h("input", {
					type: "checkbox",
					checked: policyDraft.restricted,
					onChange: (event) => {
						const restricted = Boolean(event.target?.checked);
						setPolicyDraft((previous) => {
							if (!previous) return previous;
							const allowedModels = restricted && previous.allowedModels.length === 0 ? flatModels.map((model) => model.ref) : previous.allowedModels;
							const defaultModel = restricted && !allowedModels.includes(previous.defaultModel) ? allowedModels[0] ?? "" : previous.defaultModel;
							return {
								...previous,
								restricted,
								allowedModels,
								defaultModel,
								dirty: true
							};
						});
					}
				}), "启用模型白名单"), h("div", { style: {
					opacity: .65,
					fontSize: "12px"
				} }, "启用后，未勾选模型不会出现在 /model 中，直接指定也会被拒绝。"), policyDraft.restricted ? h("div", { style: {
					maxHeight: "170px",
					overflowY: "auto",
					padding: "4px 6px",
					border: "1px solid var(--dsw-alias-border-l3, #c8cdd8)",
					borderRadius: "6px"
				} }, ...flatModels.map((model) => h("label", {
					key: model.ref,
					style: {
						display: "flex",
						gap: "6px",
						alignItems: "flex-start",
						padding: "4px 0"
					}
				}, h("input", {
					type: "checkbox",
					checked: policyDraft.allowedModels.includes(model.ref),
					onChange: (event) => {
						const checked = Boolean(event.target?.checked);
						setPolicyDraft((previous) => {
							if (!previous) return previous;
							const allowedModels = checked ? Array.from(/* @__PURE__ */ new Set([...previous.allowedModels, model.ref])) : previous.allowedModels.filter((value) => value !== model.ref);
							return {
								...previous,
								allowedModels,
								defaultModel: previous.defaultModel === model.ref && !checked ? allowedModels[0] ?? "" : previous.defaultModel,
								dirty: true
							};
						});
					}
				}), h("span", { style: { overflowWrap: "anywhere" } }, model.label)))) : null, h("label", { htmlFor: "lark-default-model" }, "默认模型"), h("select", {
					id: "lark-default-model",
					value: policyDraft.defaultModel,
					onChange: (event) => setPolicyDraft((previous) => previous ? {
						...previous,
						defaultModel: valueOf(event),
						dirty: true
					} : previous),
					style: fieldStyle
				}, ...!policyDraft.restricted ? [h("option", { value: "" }, `跟随 DSH 全局默认${effectiveDefaultModel ? `（${effectiveDefaultModel}）` : ""}`)] : [], ...selectableDefaults.map((model) => h("option", {
					key: model.ref,
					value: model.ref
				}, model.label))), h("label", { htmlFor: "lark-workspace" }, "默认工作区"), h("input", {
					type: "text",
					id: "lark-workspace",
					value: policyDraft.workspaceRoot,
					placeholder: "留空则使用 DSH 进程工作目录",
					onChange: (event) => setPolicyDraft((previous) => previous ? {
						...previous,
						workspaceRoot: valueOf(event),
						dirty: true
					} : previous),
					style: fieldStyle
				}), h("button", {
					type: "button",
					disabled: policySaving || !policyDraft.dirty,
					onClick: savePolicy,
					style: {
						padding: "8px 10px",
						border: "none",
						borderRadius: "7px",
						background: "#3d64df",
						color: "white",
						cursor: policySaving || !policyDraft.dirty ? "default" : "pointer",
						opacity: policySaving || !policyDraft.dirty ? .55 : 1,
						font: "inherit"
					}
				}, policySaving ? "保存中…" : "保存访问策略")) : null;
				const userRows = users.slice(0, 20).map((user) => h("details", {
					className: "dshp-user",
					key: user.sessionKey
				}, h("summary", null, h("span", { className: "dshp-label" }, user.senderName || user.senderOpenId), h("div", { className: "dshp-help" }, `${user.chatType === "p2p" ? "私聊" : "群聊"} · ${user.inboundMessages} 条消息`)), h("div", { className: "dshp-user-meta" }, `聊天：${user.chatId}`), user.activeSessionId ? h("div", { className: "dshp-user-meta" }, `会话：${user.activeSessionId}`) : null, h("div", { className: "dshp-user-meta" }, `最近活跃：${new Date(user.lastSeenAt).toLocaleString()}`)));
				const userPanel = h("section", { className: "dshp-section" }, h("h3", { className: "dshp-heading" }, `用户与对话 · ${users.length}`), h("div", { className: "dshp-panel" }, ...userRows.length ? userRows : [h("div", { className: "dshp-empty" }, "还没有收到消息。连接后，在飞书中给机器人发送消息即可。")]));
				const qrImg = showQr ? h("img", {
					src: `${origin}/plugins/lark-link/qr?t=${qrTs}`,
					alt: "Lark Link setup QR",
					onError: () => setQrLoaded(false),
					onLoad: () => setQrLoaded(true),
					style: {
						width: "220px",
						height: "220px",
						display: qrLoaded ? "block" : "none",
						margin: "0 auto 10px"
					}
				}) : null;
				const qrHint = showQr && !qrLoaded ? h("div", { style: {
					textAlign: "center",
					opacity: .6,
					padding: "8px 0 12px",
					fontSize: "12px"
				} }, "二维码生成中…（若无，确认已在输入框运行 /lark setup）") : null;
				return h("section", { className: "dshp-page" }, h("style", null, "\n.dshp-page{--sp-text:var(--dsw-alias-label-primary,#20242c);--sp-muted:var(--dsw-alias-label-secondary,#69717f);--sp-border:var(--dsw-alias-border-l3,#e4e7ec);--sp-bg:var(--dsw-alias-bg-layer-2,#fff);--sp-soft:var(--dsw-alias-bg-layer-3,#f7f8fa);--sp-accent:#3d64df;color:var(--sp-text);width:100%;max-width:720px;padding:12px 0 32px;font-family:inherit;font-size:14px;line-height:1.5}\n.dshp-page *{box-sizing:border-box}.dshp-header{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:28px}.dshp-title{display:flex;align-items:center;gap:14px}.dshp-symbol{display:grid;place-items:center;flex:none;width:44px;height:44px;border:1px solid var(--sp-border);border-radius:13px;background:var(--sp-soft);font-size:20px}.dshp-page h2{font-size:22px;font-weight:650;line-height:1.35;letter-spacing:-.4px;margin:0}.dshp-subtitle{color:var(--sp-muted);font-size:13px;margin:5px 0 0}.dshp-status{display:inline-flex;align-items:center;gap:7px;color:var(--sp-muted);font-size:12px;white-space:nowrap;border:1px solid var(--sp-border);border-radius:20px;padding:5px 10px}.dshp-dot{width:6px;height:6px;flex:none;border-radius:50%;background:#969eab}.dshp-status[data-ok=true] .dshp-dot{background:#21936a}.dshp-status[data-warn=true] .dshp-dot{background:#c58c2e}\n.dshp-section{margin-top:26px}.dshp-heading{color:var(--sp-muted);font-weight:600;font-size:13px;margin:0 0 10px}.dshp-panel{background:var(--sp-bg);border:1px solid var(--sp-border);border-radius:12px;overflow:hidden}.dshp-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px}.dshp-row+.dshp-row{border-top:1px solid var(--sp-border)}.dshp-label{font-weight:550;font-size:14px;margin:0}.dshp-help{font-size:12px;color:var(--sp-muted);line-height:1.65;margin:4px 0 0}.dshp-page button,.dshp-page input,.dshp-page select{font:inherit}.dshp-page button{cursor:pointer}.dshp-page button:disabled{cursor:default;opacity:.45}.dshp-page button:focus-visible,.dshp-page input:focus-visible,.dshp-page select:focus-visible{outline:3px solid #8ba9ff;outline-offset:3px}.dshp-switch{position:relative;flex:none;width:40px;height:24px;border:0;border-radius:20px;padding:3px;background:#a0a7b2}.dshp-switch[aria-checked=true]{background:var(--sp-accent)}.dshp-knob{display:block;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002;transform:translateX(0);transition:transform .15s}.dshp-switch[aria-checked=true] .dshp-knob{transform:translateX(16px)}\n.dshp-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;border:1px solid var(--sp-border);background:var(--sp-bg);color:var(--sp-text);border-radius:7px;padding:7px 12px;font-size:12px!important}.dshp-button:hover{background:var(--sp-soft)}.dshp-primary{background:var(--sp-accent)!important;border-color:var(--sp-accent)!important;color:white!important}.dshp-danger{color:var(--dsw-alias-label-error,#c73f38)}.dshp-footnote{color:var(--sp-muted);font-size:12px;line-height:1.65;margin:12px 2px 0}.dshp-error{color:var(--dsw-alias-label-error,#c73f38);background:var(--sp-soft);border:1px solid var(--sp-border);padding:12px 14px;border-radius:8px;font-size:12px;margin-top:14px}.dshp-footer{font-size:11px;color:var(--sp-muted);margin-top:18px}.dshp-empty{font-size:12px;color:var(--sp-muted);padding:20px}.dshp-option{width:100%;display:flex;align-items:center;gap:12px;text-align:left;padding:14px;border:1px solid transparent;background:transparent;color:var(--sp-text);border-radius:8px}.dshp-option[aria-checked=true]{background:var(--sp-soft);border-color:var(--sp-border)}.dshp-option-copy{flex:1}.dshp-radio{width:16px;height:16px;border:1.5px solid #9ca5b3;border-radius:50%;display:grid;place-items:center;flex:none}.dshp-option[aria-checked=true] .dshp-radio{border-color:var(--sp-accent)}.dshp-option[aria-checked=true] .dshp-radio:after{content:'';width:8px;height:8px;border-radius:50%;background:var(--sp-accent)}.dshp-options{padding:6px}.dshp-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dshp-tags{display:flex;gap:7px;flex-wrap:wrap}.dshp-tag{font-size:12px;color:var(--sp-muted);background:var(--sp-soft);border:1px solid var(--sp-border);padding:4px 9px;border-radius:6px}.dshp-form{padding:20px;border-top:1px solid var(--sp-border);display:grid;gap:12px}.dshp-page input:not([type=checkbox]),.dshp-page select{min-height:36px;border:1px solid var(--sp-border)!important;border-radius:7px!important;background:var(--sp-bg)!important;color:var(--sp-text)!important;padding:7px 10px!important;font:inherit!important}.dshp-page input[type=checkbox]{accent-color:var(--sp-accent);width:15px;height:15px;flex:none}.dshp-disclosure{width:100%;display:flex;align-items:center;justify-content:space-between;gap:16px;text-align:left;background:transparent;border:0;color:var(--sp-text);padding:20px;font-size:14px;font-weight:550}.dshp-disclosure span:last-child{color:var(--sp-muted)}.dshp-user{padding:14px 20px}.dshp-user+.dshp-user{border-top:1px solid var(--sp-border)}.dshp-user summary{cursor:pointer;list-style:none}.dshp-user summary::-webkit-details-marker{display:none}.dshp-user summary:after{content:'›';float:right;color:var(--sp-muted)}.dshp-user[open] summary:after{content:'⌄'}.dshp-user-meta{color:var(--sp-muted);font-size:12px;overflow-wrap:anywhere;margin-top:6px}\n@media(max-width:520px){.dshp-page h2{font-size:20px}.dshp-header{align-items:flex-start;gap:10px}.dshp-subtitle{max-width:220px}.dshp-symbol{width:38px;height:38px}.dshp-row,.dshp-form,.dshp-disclosure{padding:16px}.dshp-row{gap:12px}.dshp-status{font-size:11px}}\n@media(prefers-reduced-motion:reduce){.dshp-knob{transition:none}}\n\n          .dshp-lark-form{padding:0 20px 20px}.dshp-lark-form>div{border:0!important;background:transparent!important;padding:0!important;margin:0!important;gap:12px!important}.dshp-lark-form>div>button{border-radius:7px!important;padding:8px 12px!important}.dshp-lark-form label{font-size:13px}.dshp-lark-form [style*=\"max-height\"]{max-height:240px!important;border:1px solid var(--sp-border)!important;padding:10px!important}.dshp-lark-notice{padding:14px 20px}.dshp-qr{padding:20px;text-align:center}.dshp-qr img{border:1px solid var(--sp-border);border-radius:12px;padding:12px;background:white}.dshp-qr p{margin:0;font-size:12px;color:var(--sp-muted)}\n        "), h("header", { className: "dshp-header" }, h("div", { className: "dshp-title" }, h("span", { className: "dshp-symbol" }, h("svg", {
					width: 22,
					height: 22,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.7,
					"aria-hidden": true
				}, h("path", { d: "M21 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 19 0ZM7 10h9M7 14h6" }))), h("div", null, h("h2", null, "飞书 / Lark"), h("p", { className: "dshp-subtitle" }, "把桌面助手连接到飞书对话。"))), banner), h("div", { className: "dshp-panel" }, h("div", { className: "dshp-row" }, h("div", null, h("p", { className: "dshp-label" }, "启用飞书桥接"), h("p", { className: "dshp-help" }, st?.configured ? "将收到的消息交给 DSH，并同步回复。" : "先扫码或填写机器人凭据，再开启桥接。")), h("div", { className: "dshp-actions" }, st?.configured ? h("button", {
					type: "button",
					className: "dshp-button",
					disabled: !!controlBusy,
					onClick: () => runControl("restart")
				}, controlBusy === "restart" ? "重连中…" : "重新连接") : null, h("button", {
					type: "button",
					className: "dshp-switch",
					role: "switch",
					"aria-label": "启用飞书桥接",
					"aria-checked": state === "running" || state === "connecting",
					disabled: !st?.configured || !!controlBusy,
					onClick: () => runControl(state === "running" || state === "connecting" ? "stop" : state === "error" ? "restart" : "start")
				}, h("span", { className: "dshp-knob" })))), credentialSummary ? h("div", { style: { padding: "0 20px 12px" } }, credentialSummary) : null, extras.length ? h("div", { className: "dshp-row" }, h("p", { className: "dshp-label" }, "消息投递"), h("span", { className: "dshp-help" }, extras.join(" · "))) : null), showQr ? h("section", { className: "dshp-section" }, h("h3", { className: "dshp-heading" }, "扫码配置"), h("div", { className: "dshp-panel dshp-qr" }, qrImg, qrHint, h("p", null, "使用手机飞书扫码，完成机器人配置。"))) : null, notice ? h("div", {
					className: "dshp-lark-notice",
					role: "status"
				}, notice) : null, h("section", { className: "dshp-section" }, h("h3", { className: "dshp-heading" }, "连接与账号"), h("div", { className: "dshp-panel" }, manualToggle, manualForm ? h("div", { className: "dshp-lark-form" }, manualForm) : null)), h("section", { className: "dshp-section" }, h("h3", { className: "dshp-heading" }, "对话偏好"), h("div", { className: "dshp-panel" }, policyToggle, policyForm ? h("div", { className: "dshp-lark-form" }, policyForm) : null)), userPanel, manualError ? h("div", {
					className: "dshp-error",
					role: "alert"
				}, manualError) : null, h("div", { className: "dshp-footer" }, "凭据和对话偏好在确认保存后生效。"));
			};
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "lark-link",
				order: 45,
				label: "飞书 / Lark"
			}, LarkLinkSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

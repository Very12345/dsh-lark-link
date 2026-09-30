// dsh-lark-link client half (browser). Reuses the DSH Web GUI entirely
// (spec §7). This client adds one surface — a settings section whose content is
// a small STATE MACHINE over (configured × connection):
//   not-configured → show the setup QR
//   configured + stopped/idle → "ready, run /lark start"
//   configured + connecting → "connecting…"
//   configured + connected → "running" (stop/restart)
//   configured + degraded/quarantined → "error"
// State comes from the host /plugins/lark-link/status route (JSON: connState,
// outbox counters, configured). The QR is a host-served PNG at
// /plugins/lark-link/qr (the GUI markdown image sanitizer drops data: URLs,
// and a plugin can't push over ctx.remote — so we poll a local image we own).
//
// Slot registration: the whole management surface used to be a sidebar-footer
// popover (`sidebar.footer.action`) rendered through a body portal, because
// peer footer-slot plugins rewrote that container and deformed it. It is now
// its own `settings.section` page: the settings shell owns the layout, nothing
// competes for the container, and the portal workaround is gone with the
// sidebar entry.

import type { Context } from "@deepseek-ai/cordis";

type ReactApi = {
	createElement: (
		type: unknown,
		props?: Record<string, unknown> | null,
		...children: unknown[]
	) => unknown;
	useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
	useEffect: (setup: () => (() => void) | void, deps?: unknown[]) => void;
};
const R = require("react") as ReactApi;
const { createElement: h, useState, useEffect } = R;

const win = globalThis as unknown as {
	location?: { origin?: string };
	fetch?: (
		url: string,
		init?: {
			method?: string;
			headers?: Record<string, string>;
			body?: string;
		},
	) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
};

export const name = "dsh-lark-link-client";
export const inject = ["slots"];

export interface ClientContext extends Context {
	slots: {
		inject(name: string, register: () => () => void): void;
		register(
			opts: { name: string; id: string; order?: number; label?: string },
			Component: (props?: unknown) => unknown,
		): () => void;
	};
	/** Legacy client settings-scope service (0.1.6 and older only). */
	settingsScope?: {
		bind(spec?: { namespace?: string }): {
			getSnapshot(): unknown;
			subscribe(listener: () => void): () => void;
			set(key: string, value: unknown): unknown;
		};
	};
}

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
function installLegacySettingsScope(ctx: ClientContext): void {
	const compat = ctx as unknown as {
		get?: (name: string, strict?: boolean) => unknown;
		provide?: (name: string, value: unknown) => unknown;
	};
	if (typeof compat.provide !== "function") return;
	try {
		// Never shadow a real implementation (0.1.6 and older provide one).
		if (compat.get?.("settingsScope")) return;
		const snapshots = new Map<string, unknown>();
		compat.provide("settingsScope", {
			bind(spec?: { namespace?: string }) {
				const namespace = String(spec?.namespace ?? "");
				let snapshot = snapshots.get(namespace);
				if (!snapshot) {
					snapshot = {
						status: "ready",
						writable: false,
						value: { provider: "deepseek" },
					};
					snapshots.set(namespace, snapshot);
				}
				return {
					getSnapshot: () => snapshot,
					subscribe: () => () => {},
					set: () => snapshot,
				};
			},
		});
	} catch {
		// A real provider appeared concurrently — the real one wins.
	}
}

interface StatusPayload {
	connState?: string;
	configured?: boolean;
	appIdMasked?: string;
	domain?: "feishu" | "lark";
	outboxPending?: number;
	outboxFailed?: number;
	inboundFailed?: number;
}

interface ManagementUser {
	sessionKey: string;
	chatId: string;
	chatType: "p2p" | "group";
	senderOpenId: string;
	senderName?: string;
	inboundMessages: number;
	lastSeenAt: number;
	activeSessionId?: string;
	workspaceRoot?: string;
	provider?: string;
	model?: string;
	reasoningEffort?: string;
	preset?: string;
}

interface ManagementPayload {
	ok?: boolean;
	instance?: { host?: string; pid?: number };
	status?: StatusPayload;
	policy?: {
		modelAccess?: {
			restricted?: boolean;
			allowedModels?: string[];
			defaultModel?: string;
		};
		workspaceRoot?: string;
		effectiveDefaultModel?: string;
	};
	modelCatalog?: Array<{
		provider: string;
		label?: string;
		models: Array<{ id: string; name?: string }>;
	}>;
	users?: ManagementUser[];
}

interface PolicyDraft {
	restricted: boolean;
	allowedModels: string[];
	defaultModel: string;
	workspaceRoot: string;
	dirty: boolean;
}

type PanelState =
	| "loading"
	| "setup"
	| "ready"
	| "connecting"
	| "running"
	| "error";

function deriveState(s: StatusPayload | undefined): PanelState {
	if (!s) return "loading";
	if (!s.configured) return "setup";
	switch (s.connState) {
		case "connected":
			return "running";
		case "connecting":
		case "reconnecting":
			return "connecting";
		case "degraded":
		case "quarantined":
			return "error";
		default: // stopped | idle | undefined
			return "ready";
	}
}

const STATE_VIEW: Record<
	Exclude<PanelState, "loading">,
	{ emoji: string; label: string; color: string; bg: string; hint: string }
> = {
	setup: {
		emoji: "⚙️",
		label: "未配置",
		color: "#ffb454",
		bg: "rgba(255,180,84,.12)",
		hint: "手机飞书扫码，或在输入框运行 /lark setup",
	},
	ready: {
		emoji: "✅",
		label: "已配置 · 待启动",
		color: "#7fd1ff",
		bg: "rgba(127,209,255,.12)",
		hint: "在输入框运行 /lark start 启动桥接",
	},
	connecting: {
		emoji: "🟡",
		label: "连接中…",
		color: "#ffd66b",
		bg: "rgba(255,214,107,.12)",
		hint: "正在建立飞书长连接",
	},
	running: {
		emoji: "🟢",
		label: "运行中",
		color: "#7ee2a8",
		bg: "rgba(126,226,168,.12)",
		hint: "/lark stop · /lark restart · 发消息即可对话",
	},
	error: {
		emoji: "🔴",
		label: "连接异常",
		color: "#ff8a80",
		bg: "rgba(255,138,128,.12)",
		hint: "/lark restart 重连 · /lark status 查看详情",
	},
};

export function apply(ctx: ClientContext): void {
	installLegacySettingsScope(ctx);
	const LarkLinkSection = (): unknown => {
		const [st, setSt] = useState<StatusPayload | undefined>(undefined);
		const [qrTs, setQrTs] = useState<number>(0);
		const [qrLoaded, setQrLoaded] = useState<boolean>(false);
		const [manualOpen, setManualOpen] = useState<boolean>(false);
		const [appId, setAppId] = useState<string>("");
		const [appSecret, setAppSecret] = useState<string>("");
		const [domain, setDomain] = useState<"feishu" | "lark">("feishu");
		const [manualSaving, setManualSaving] = useState<boolean>(false);
		const [manualError, setManualError] = useState<string>("");
		const [manualNotice, setManualNotice] = useState<string>("");
		const [users, setUsers] = useState<ManagementUser[]>([]);
		const [instanceHost, setInstanceHost] = useState<string>("");
		const [controlBusy, setControlBusy] = useState<string>("");
		const [policyOpen, setPolicyOpen] = useState<boolean>(false);
		const [policySaving, setPolicySaving] = useState<boolean>(false);
		const [policyDraft, setPolicyDraft] = useState<PolicyDraft | undefined>(
			undefined,
		);
		const [effectiveDefaultModel, setEffectiveDefaultModel] = useState<string>("");
		const [modelCatalog, setModelCatalog] = useState<
			NonNullable<ManagementPayload["modelCatalog"]>
		>([]);


		useEffect(() => {
			const origin = win.location?.origin ?? "";
			const fetchStatus = (): void => {
				void win
					.fetch?.(`${origin}/plugins/lark-link/status`)
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error("status"))))
					.then((j) => setSt(j as StatusPayload))
					.catch(() => setSt((prev) => prev));
				void win
					.fetch?.(`${origin}/plugins/lark-link/management`)
					.then((r) =>
						r.ok ? r.json() : Promise.reject(new Error("management")),
					)
					.then((value) => {
						const management = value as ManagementPayload;
						if (management.status)
							setSt((previous) => ({ ...previous, ...management.status }));
						setInstanceHost(String(management.instance?.host ?? ""));
						setUsers(Array.isArray(management.users) ? management.users : []);
						setModelCatalog(
							Array.isArray(management.modelCatalog)
								? management.modelCatalog
								: [],
						);
						if (management.policy) {
							setEffectiveDefaultModel(
								management.policy.effectiveDefaultModel ?? "",
							);
							setPolicyDraft((previous) =>
								previous?.dirty
									? previous
									: {
											restricted:
												management.policy?.modelAccess?.restricted === true,
											allowedModels:
												management.policy?.modelAccess?.allowedModels ?? [],
											defaultModel:
												management.policy?.modelAccess?.defaultModel ?? "",
											workspaceRoot: management.policy?.workspaceRoot ?? "",
											dirty: false,
										},
							);
						}
					})
					.catch(() => undefined);
			};
			fetchStatus();
			const stId = setInterval(fetchStatus, 3000);
			// QR only matters in the setup state; poll a fresh PNG while unconfigured.
			const qrId = setInterval(() => setQrTs(Date.now()), 4000);
			setQrTs(Date.now());
			return () => {
				clearInterval(stId);
				clearInterval(qrId);
			};
		}, []);

		const state = deriveState(st);
		const origin = win.location?.origin ?? "";
		const showQr = state === "setup";
		const valueOf = (event: unknown): string =>
			String(
				(event as { target?: { value?: unknown } })?.target?.value ?? "",
			);
		const saveManualCredentials = (): void => {
			if (manualSaving) return;
			if (!appId.trim() || !appSecret.trim()) {
				setManualError("请填写 App ID 和 App Secret");
				return;
			}
			setManualSaving(true);
			setManualError("");
			setManualNotice("");
			void win
				.fetch?.(`${origin}/plugins/lark-link/credentials`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ appId: appId.trim(), appSecret, domain }),
				})
				.then(async (response) => {
					const value = (await response.json()) as {
						ok?: boolean;
						error?: string;
						appSwitched?: boolean;
						appIdMasked?: string;
						domain?: "feishu" | "lark";
						connState?: string;
					};
					if (!response.ok || !value.ok)
						throw new Error(value.error || `保存失败（HTTP ${response.status}）`);
					setAppSecret("");
					setManualOpen(false);
					setUsers((previous) => (value.appSwitched ? [] : previous));
					setManualNotice(
						value.appSwitched
							? "已切换机器人并清空旧机器人的路由、补发队列和会话映射。"
							: "凭据已保存，桥接已重新连接。",
					);
					setSt((previous) => ({
						...previous,
						configured: true,
						appIdMasked: value.appIdMasked,
						domain: value.domain,
						connState: value.connState ?? "connected",
					}));
				})
				.catch((error: unknown) =>
					setManualError(
						error instanceof Error ? error.message : "手动配置失败",
					),
				)
				.finally(() => setManualSaving(false));
		};
		const runControl = (action: "start" | "stop" | "restart"): void => {
			if (controlBusy) return;
			setControlBusy(action);
			setManualNotice("");
			setManualError("");
			void win
				.fetch?.(`${origin}/plugins/lark-link/control`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action }),
				})
				.then(async (response) => {
					const value = (await response.json()) as {
						ok?: boolean;
						error?: string;
						connState?: string;
					};
					if (!response.ok || !value.ok)
						throw new Error(value.error || `操作失败（HTTP ${response.status}）`);
					setSt((previous) => ({
						...previous,
						connState: value.connState,
					}));
					setManualNotice(
						action === "stop"
							? "桥接已停止。"
							: action === "restart"
								? "桥接已重新连接。"
								: "桥接已启动。",
					);
				})
				.catch((error: unknown) =>
					setManualError(error instanceof Error ? error.message : "管理操作失败"),
				)
				.finally(() => setControlBusy(""));
		};
		const savePolicy = (): void => {
			if (policySaving || !policyDraft) return;
			if (policyDraft.restricted && policyDraft.allowedModels.length === 0) {
				setManualError("启用模型白名单时至少保留一个模型");
				return;
			}
			setPolicySaving(true);
			setManualError("");
			setManualNotice("");
			void win
				.fetch?.(`${origin}/plugins/lark-link/policy`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						modelAccess: {
							restricted: policyDraft.restricted,
							allowedModels: policyDraft.allowedModels,
							defaultModel: policyDraft.defaultModel,
						},
						workspaceRoot: policyDraft.workspaceRoot,
					}),
				})
				.then(async (response) => {
					const value = (await response.json()) as {
						ok?: boolean;
						error?: string;
						modelAccess?: PolicyDraft;
						workspaceRoot?: string;
					};
					if (!response.ok || !value.ok)
						throw new Error(value.error || `保存失败（HTTP ${response.status}）`);
					setPolicyDraft({
						restricted: value.modelAccess?.restricted === true,
						allowedModels: value.modelAccess?.allowedModels ?? [],
						defaultModel: value.modelAccess?.defaultModel ?? "",
						workspaceRoot: value.workspaceRoot ?? "",
						dirty: false,
					});
					setManualNotice("模型访问策略和默认工作区已保存。下一轮请求生效。");
				})
				.catch((error: unknown) =>
					setManualError(error instanceof Error ? error.message : "策略保存失败"),
				)
				.finally(() => setPolicySaving(false));
		};

		const view =
			state === "loading"
				? {
						emoji: "…",
						label: "读取状态",
						color: "#9aa0a6",
						bg: "rgba(255,255,255,.05)",
						hint: "",
					}
				: STATE_VIEW[state];

		const extras: string[] = [];
		if (st?.outboxPending && st.outboxPending > 0)
			extras.push(`待发 ${st.outboxPending}`);
		if (st?.outboxFailed && st.outboxFailed > 0)
			extras.push(`失败 ${st.outboxFailed}`);
		if (st?.inboundFailed && st.inboundFailed > 0)
			extras.push(`补发失败 ${st.inboundFailed}`);

		const banner = h(
			"div",
			{
				style: {
					display: "flex",
					alignItems: "center",
					gap: "8px",
					padding: "10px 12px",
					marginBottom: "10px",
					background: view.bg,
					borderRadius: "8px",
					color: view.color,
					fontWeight: 600,
				},
			},
			h("span", { style: { fontSize: "16px" } }, view.emoji),
			h("span", null, view.label),
			extras.length
				? h(
						"span",
						{
							style: {
								marginLeft: "auto",
								fontWeight: 400,
								opacity: 0.8,
								fontSize: "11px",
							},
						},
						extras.join(" · "),
					)
				: null,
		);

		const hint = view.hint
			? h(
					"div",
					{
						style: {
							opacity: 0.8,
							marginBottom: "10px",
							whiteSpace: "pre-wrap",
						},
					},
					view.hint,
				)
			: null;

		const credentialSummary = st?.appIdMasked
			? h(
					"div",
					{
						style: {
							marginBottom: "10px",
							opacity: 0.75,
							fontSize: "11px",
						},
					},
					`当前：${st.appIdMasked} · ${st.domain === "lark" ? "Lark" : "飞书"}${instanceHost ? ` · 主机 ${instanceHost}` : ""}`,
				)
			: null;
		const fieldStyle = {
			boxSizing: "border-box",
			width: "100%",
			padding: "7px 8px",
			border: "1px solid rgba(255,255,255,.18)",
			borderRadius: "7px",
			background: "rgba(255,255,255,.06)",
			color: "inherit",
			font: "inherit",
		};
		const manualToggle = h(
			"button",
			{
				type: "button",
				onClick: () => {
					setManualOpen((value) => !value);
					setManualError("");
				},
				style: {
					width: "100%",
					padding: "7px 9px",
					marginBottom: "10px",
					border: "1px solid rgba(127,209,255,.4)",
					borderRadius: "7px",
					background: "rgba(127,209,255,.1)",
					color: "#b9e6ff",
					cursor: "pointer",
					font: "inherit",
				},
			},
			manualOpen ? "取消手动配置" : "手动配置 App ID / App Secret",
		);
		const manualForm = manualOpen
			? h(
					"div",
					{
						style: {
							display: "grid",
							gap: "8px",
							padding: "10px",
							marginBottom: "10px",
							border: "1px solid rgba(255,255,255,.12)",
							borderRadius: "8px",
							background: "rgba(0,0,0,.18)",
						},
					},
					h("label", null, "App ID"),
					h("input", {
						type: "text",
						value: appId,
						autoComplete: "off",
						spellCheck: false,
						placeholder: "cli_xxxxxxxxxxxxxxxx",
						onChange: (event: unknown) => setAppId(valueOf(event)),
						style: fieldStyle,
					}),
					h("label", null, "App Secret"),
					h("input", {
						type: "password",
						value: appSecret,
						autoComplete: "new-password",
						spellCheck: false,
						placeholder: "不会回显或写入普通配置",
						onChange: (event: unknown) => setAppSecret(valueOf(event)),
						style: fieldStyle,
					}),
					h("label", null, "服务区域"),
					h(
						"select",
						{
							value: domain,
							onChange: (event: unknown) =>
								setDomain(valueOf(event) === "lark" ? "lark" : "feishu"),
							style: fieldStyle,
						},
						h("option", { value: "feishu" }, "飞书（中国大陆）"),
						h("option", { value: "lark" }, "Lark（国际版）"),
					),
					manualError
						? h(
								"div",
								{ style: { color: "#ff8a80", whiteSpace: "pre-wrap" } },
								manualError,
							)
						: null,
					h(
						"button",
						{
							type: "button",
							disabled: manualSaving,
							onClick: saveManualCredentials,
							style: {
								padding: "8px 10px",
								border: "none",
								borderRadius: "7px",
								background: "#3370ff",
								color: "white",
								cursor: manualSaving ? "default" : "pointer",
								opacity: manualSaving ? 0.65 : 1,
								font: "inherit",
							},
						},
						manualSaving ? "保存并重连中…" : "保存并重连",
					),
				)
			: null;
		const controlButton = (
			label: string,
			action: "start" | "stop" | "restart",
		): unknown =>
			h(
				"button",
				{
					type: "button",
					disabled: Boolean(controlBusy),
					onClick: () => runControl(action),
					style: {
						flex: 1,
						padding: "6px 7px",
						border: "1px solid rgba(255,255,255,.16)",
						borderRadius: "7px",
						background: "rgba(255,255,255,.06)",
						color: "inherit",
						cursor: controlBusy ? "default" : "pointer",
						font: "inherit",
					},
				},
				controlBusy === action ? "处理中…" : label,
			);
		const controls = h(
			"div",
			{ style: { display: "flex", gap: "6px", marginBottom: "10px" } },
			controlButton("启动", "start"),
			controlButton("停止", "stop"),
			controlButton("重连", "restart"),
		);
		const notice = manualNotice
			? h(
					"div",
					{
						style: {
							marginBottom: "10px",
							padding: "8px",
							borderRadius: "7px",
							background: "rgba(126,226,168,.1)",
							color: "#9bf0bb",
						},
					},
					manualNotice,
				)
			: null;
		const flatModels = modelCatalog.flatMap((group) =>
			group.models.map((model) => ({
				ref: `${group.provider}/${model.id}`,
				label: `${group.label || group.provider} · ${model.name || model.id}`,
			})),
		);
		const policyToggle = h(
			"button",
			{
				type: "button",
				onClick: () => {
					setPolicyOpen((value) => !value);
					setManualError("");
				},
				style: {
					width: "100%",
					padding: "7px 9px",
					marginBottom: "10px",
					border: "1px solid rgba(126,226,168,.4)",
					borderRadius: "7px",
					background: "rgba(126,226,168,.1)",
					color: "#9bf0bb",
					cursor: "pointer",
					font: "inherit",
				},
			},
			policyOpen ? "收起模型与工作区设置" : "模型与工作区设置",
		);
		const selectableDefaults = flatModels.filter(
			(model) =>
				!policyDraft?.restricted ||
				policyDraft.allowedModels.includes(model.ref),
		);
		const policyForm =
			policyOpen && policyDraft
				? h(
						"div",
						{
							style: {
								display: "grid",
								gap: "8px",
								padding: "10px",
								marginBottom: "10px",
								border: "1px solid rgba(255,255,255,.12)",
								borderRadius: "8px",
								background: "rgba(0,0,0,.18)",
							},
						},
						h(
							"label",
							{ style: { display: "flex", gap: "7px", alignItems: "center" } },
							h("input", {
								type: "checkbox",
								checked: policyDraft.restricted,
								onChange: (event: unknown) => {
									const restricted = Boolean(
										(event as { target?: { checked?: unknown } }).target?.checked,
									);
									setPolicyDraft((previous) => {
										if (!previous) return previous;
										const allowedModels =
											restricted && previous.allowedModels.length === 0
												? flatModels.map((model) => model.ref)
												: previous.allowedModels;
										const defaultModel =
											restricted && !allowedModels.includes(previous.defaultModel)
												? allowedModels[0] ?? ""
												: previous.defaultModel;
										return {
											...previous,
											restricted,
											allowedModels,
											defaultModel,
											dirty: true,
										};
									});
								},
							}),
							"启用模型白名单",
						),
						h(
							"div",
							{ style: { opacity: 0.65, fontSize: "10px" } },
							"启用后，未勾选模型不会出现在 /model 中，直接指定也会被拒绝。",
						),
						policyDraft.restricted
							? h(
									"div",
									{
										style: {
											maxHeight: "170px",
											overflowY: "auto",
											padding: "4px 6px",
											border: "1px solid rgba(255,255,255,.1)",
											borderRadius: "6px",
										},
									},
									...flatModels.map((model) =>
										h(
											"label",
											{
												key: model.ref,
												style: {
													display: "flex",
													gap: "6px",
													alignItems: "flex-start",
													padding: "4px 0",
												},
											},
											h("input", {
												type: "checkbox",
												checked: policyDraft.allowedModels.includes(model.ref),
												onChange: (event: unknown) => {
													const checked = Boolean(
														(event as { target?: { checked?: unknown } }).target
															?.checked,
													);
													setPolicyDraft((previous) => {
														if (!previous) return previous;
														const allowedModels = checked
															? Array.from(
																	new Set([...previous.allowedModels, model.ref]),
																)
															: previous.allowedModels.filter(
																	(value) => value !== model.ref,
																);
														return {
															...previous,
															allowedModels,
															defaultModel:
																previous.defaultModel === model.ref && !checked
																	? allowedModels[0] ?? ""
																	: previous.defaultModel,
															dirty: true,
														};
													});
												},
											}),
											h("span", { style: { overflowWrap: "anywhere" } }, model.label),
										),
									),
								)
							: null,
						h("label", null, "默认模型"),
						h(
							"select",
							{
								value: policyDraft.defaultModel,
								onChange: (event: unknown) =>
									setPolicyDraft((previous) =>
										previous
											? {
													...previous,
													defaultModel: valueOf(event),
													dirty: true,
												}
											: previous,
									),
								style: fieldStyle,
							},
							...(!policyDraft.restricted
								? [
										h(
											"option",
											{ value: "" },
											`跟随 DSH 全局默认${effectiveDefaultModel ? `（${effectiveDefaultModel}）` : ""}`,
										),
									]
								: []),
							...selectableDefaults.map((model) =>
								h("option", { key: model.ref, value: model.ref }, model.label),
							),
						),
						h("label", null, "默认工作区"),
						h("input", {
							type: "text",
							value: policyDraft.workspaceRoot,
							placeholder: "留空则使用 DSH 进程工作目录",
							onChange: (event: unknown) =>
								setPolicyDraft((previous) =>
									previous
										? {
												...previous,
												workspaceRoot: valueOf(event),
												dirty: true,
											}
										: previous,
								),
							style: fieldStyle,
						}),
						h(
							"button",
							{
								type: "button",
								disabled: policySaving || !policyDraft.dirty,
								onClick: savePolicy,
								style: {
									padding: "8px 10px",
									border: "none",
									borderRadius: "7px",
									background: "#3370ff",
									color: "white",
									cursor:
										policySaving || !policyDraft.dirty ? "default" : "pointer",
									opacity: policySaving || !policyDraft.dirty ? 0.55 : 1,
									font: "inherit",
								},
							},
							policySaving ? "保存中…" : "保存访问策略",
						),
					)
				: null;
		const userRows = users.slice(0, 20).map((user) =>
			h(
				"div",
				{
					key: user.sessionKey,
					style: {
						padding: "7px 0",
						borderTop: "1px solid rgba(255,255,255,.08)",
					},
				},
				h(
					"div",
					{ style: { fontWeight: 600, overflowWrap: "anywhere" } },
					user.senderName || user.senderOpenId,
				),
				h(
					"div",
					{ style: { opacity: 0.65, fontSize: "10px", overflowWrap: "anywhere" } },
					`${user.chatType} · ${user.chatId} · ${user.inboundMessages} 条 · ${new Date(user.lastSeenAt).toLocaleString()}`,
				),
				user.activeSessionId
					? h(
							"div",
							{ style: { opacity: 0.55, fontSize: "10px", overflowWrap: "anywhere" } },
							`会话：${user.activeSessionId}`,
						)
					: null,
			),
		);
		const userPanel = h(
			"div",
			{
				style: {
					marginBottom: "10px",
					maxHeight: "190px",
					overflowY: "auto",
				},
			},
			h(
				"div",
				{ style: { fontWeight: 600, marginBottom: "4px" } },
				`用户与桥接链（${users.length}）`,
			),
			...(userRows.length
				? userRows
				: [h("div", { style: { opacity: 0.6 } }, "尚无当前机器人收到的消息")]),
		);

		// QR only while unconfigured; hidden (but fetched) until it loads.
		const qrImg = showQr
			? h("img", {
					src: `${origin}/plugins/lark-link/qr?t=${qrTs}`,
					alt: "Lark Link setup QR",
					onError: () => setQrLoaded(false),
					onLoad: () => setQrLoaded(true),
					style: {
						width: "220px",
						height: "220px",
						display: qrLoaded ? "block" : "none",
						margin: "0 auto 10px",
					},
				})
			: null;
		const qrHint =
			showQr && !qrLoaded
				? h(
						"div",
						{
							style: {
								textAlign: "center",
								opacity: 0.6,
								padding: "8px 0 12px",
								fontSize: "11px",
							},
						},
						"二维码生成中…（若无，确认已在输入框运行 /lark setup）",
					)
				: null;

		const footer = h(
			"div",
			{
				style: {
					marginTop: "6px",
					paddingTop: "8px",
					borderTop: "1px solid rgba(255,255,255,.08)",
					opacity: 0.6,
					fontSize: "11px",
					lineHeight: 1.6,
				},
			},
			"可在本面板手动更新凭据，或使用 /lark setup 扫码配置",
			h("br"),
			"详情与全链路：/lark status",
		);

		const panel = h(
			"div",
			{
				style: {
					display: "flex",
					flexDirection: "column",
					width: "100%",
					maxWidth: "760px",
					color: "inherit",
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: "12px",
					lineHeight: 1.5,
				},
			},
			h(
				"strong",
				{ style: { fontSize: "13px", marginBottom: "10px" } },
				"🪶 Lark Link",
			),
			banner,
			hint,
			credentialSummary,
			controls,
			notice,
			policyToggle,
			policyForm,
			manualToggle,
			manualForm,
			userPanel,
			qrImg,
			qrHint,
			footer,
		);

		return panel;
	};

	// The whole management surface — QR setup, credentials, users, policy and the
	// model catalogue — lives in its own settings section. It used to be a
	// sidebar-footer popover; the sidebar entry is gone, so this section is the
	// only way in and always renders its content (no open/close state).
	ctx.slots.inject("settings.section", () =>
		ctx.slots.register(
			{
				name: "settings.section",
				id: "lark-link",
				order: 45,
				label: "Lark Link",
			},
			LarkLinkSection,
		),
	);
}

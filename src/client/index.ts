// dsh-lark-link client half (browser). Reuses the DSH Web GUI entirely
// (spec §7). This client adds one surface — a sidebar footer action whose
// popover is a small STATE MACHINE over (configured × connection):
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
// Slot registration: `sidebar.footer.action` is a `list` slot (declared by
// ui-sidebar); `register` takes the parent name + an entry `id`. The component
// owns its open/close state; the popover is position:fixed and is rendered
// through a React portal to document.body — it escapes the sidebar footer slot
// container, so peer footer-slot plugins (e.g. dsh-cost-meter, which rewrites
// that container's children/order) can never reshape or dislocate it.

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
// render the popover through a portal to document.body so it escapes the
// shared sidebar footer slot container. The sidebar.footer.action slot is a
// LIST where other plugins (e.g. dsh-cost-meter) legitimately reorder the
// container's children / rewrite its inline flex styles while watching it with
// a MutationObserver — a popover left as a slot child gets reshuffled by that
// churn and visibly deforms (GH issue #3). A body portal keeps it stable.
const reactDom = require("react-dom") as {
	createPortal?: (node: unknown, container: unknown) => unknown;
};

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
	// Browser-only, used as the portal mount target. Kept out of the TS dom lib
	// (this package's lib is ES2023); accessed lazily through globalThis.
	document?: { body?: unknown } | null;
};

// If react-dom.createPortal is available (and we're in a browser), mount via a
// body portal; otherwise fall back to rendering in place (older runtimes).
const bodyEl = win.document?.body;
const portalToBody =
	bodyEl != null && reactDom.createPortal
		? (node: unknown) => reactDom.createPortal!(node, bodyEl)
		: (node: unknown) => node;

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
	users?: ManagementUser[];
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
	const SidebarAction = (): unknown => {
		const [open, setOpen] = useState<boolean>(false);
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

		useEffect(() => {
			if (!open) return;
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
		}, [open]);

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

		const button = h(
			"button",
			{
				type: "button",
				title: "Lark Link",
				onClick: () => setOpen((v) => !v),
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: "6px",
					padding: "6px 10px",
					border: "1px solid rgba(127,127,127,.25)",
					borderRadius: "8px",
					background: open ? "rgba(127,127,127,.18)" : "transparent",
					color: "inherit",
					cursor: "pointer",
					fontSize: "13px",
					lineHeight: 1,
				},
			},
			"🪶",
			"Lark",
		);

		if (!open) return button;

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
					position: "fixed",
					top: "12px",
					right: "12px",
					zIndex: 2147483000,
					minWidth: "300px",
					maxWidth: "360px",
					padding: "14px 16px",
					background: "rgba(24,26,32,.97)",
					color: "#e6e8eb",
					border: "1px solid rgba(255,255,255,.16)",
					borderRadius: "12px",
					boxShadow: "0 16px 48px rgba(0,0,0,.5)",
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: "12px",
					lineHeight: 1.5,
				},
			},
			h(
				"div",
				{
					style: {
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: "10px",
					},
				},
				h("strong", { style: { fontSize: "13px" } }, "🪶 Lark Link"),
				h(
					"button",
					{
						type: "button",
						onClick: () => {
							setOpen(false);
							setManualOpen(false);
							setAppSecret("");
							setManualError("");
						},
						style: {
							background: "transparent",
							border: "none",
							color: "#9aa0a6",
							cursor: "pointer",
							fontSize: "16px",
							lineHeight: 1,
						},
						title: "关闭",
					},
					"×",
				),
			),
			banner,
			hint,
			credentialSummary,
			controls,
			notice,
			manualToggle,
			manualForm,
			userPanel,
			qrImg,
			qrHint,
			footer,
		);

		// The popover goes through portalToBody (document.body) so another
		// footer-slot plugin (dsh-cost-meter) reordering the shared sidebar
		// footer container can never dislocate or deform it. Only the trigger
		// button stays inside the sidebar footer slot.
		return h("div", null, button, portalToBody(panel));
	};

	ctx.slots.inject("sidebar.footer.action", () =>
		ctx.slots.register(
			{
				name: "sidebar.footer.action",
				id: "lark-link-entry",
				order: 100,
				label: "Lark Link",
			},
			SidebarAction,
		),
	);
}

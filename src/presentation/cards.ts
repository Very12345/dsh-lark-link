// Feishu card builders (L4 presentation, schema 2.0). Pure functions.
//
// 2026-08-14 对齐 pi-feishu-link 修复：schema 2.0 已移除 tag:"action"
// 容器（ErrCode 200861）——按钮直接平铺进 body.elements（tag:"button"，
// width:"fill" 防截断），交互回传用 behaviors:[{type:"callback",value}]。
// emoji 精简为稳定集合（部分 emoji 在部分客户端字体渲染乱码）。

import type { AgentPresetOption } from "../common/types.ts";

export type CardVariant = "status" | "help" | "setup" | "welcome" | "error";

/** Card button value (op routing). */
export interface CardButtonValue {
	op: string;
	[key: string]: unknown;
}

/**
 * schema 2.0 按钮：直接作为组件放 elements（平铺、宽度完整不缩略）；
 * 交互回传用 behaviors:[{type:"callback",value}]（card.action.trigger 回调返回 value）。
 */
export function button(
	text: string,
	value: CardButtonValue,
	style?: "primary" | "danger",
): unknown {
	const b: Record<string, unknown> = {
		tag: "button",
		width: "fill",
		text: { tag: "plain_text", content: text },
		behaviors: [{ type: "callback", value }],
	};
	if (style === "primary") b.type = "primary";
	if (style === "danger") b.type = "danger";
	return b;
}

/**
 * Heuristic: does this reply carry markdown worth rendering as a card?
 * Matches headings, lists, fenced code, blockquotes, bold, tables and
 * paragraph breaks (pi-feishu-link rich-text mode selection).
 */
export function looksLikeMarkdown(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	if (
		/(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\*\*|\|.*\|)/.test(t) ||
		t.includes("\n\n")
	)
		return true;
	return false;
}

export function markdownCard(
	markdown: string,
	opts: { header?: string; accent?: boolean } = {},
): unknown {
	return {
		schema: "2.0",
		// schema 2.0: `header` is a TOP-LEVEL sibling of `body` — nesting it
		// inside body fails with ErrCode 200621 "unknown property header".
		...(opts.header
			? {
					header: {
						title: { tag: "plain_text", content: opts.header },
						template: opts.accent ? "blue" : "grey",
					},
				}
			: {}),
		body: { elements: [{ tag: "markdown", content: markdown }] },
	};
}

/**
 * Agent preset options (DSH agent-presets).
 *
 * `AGENT_PRESETS` is the FALLBACK roster — the four shipped presets — used
 * when the live DSH agentPresets service is unreachable. When the service is
 * up, the bridge renders the dynamic roster (shipped + user-authored) instead;
 * see the DshSessionBackend.listPresets surface.
 */
export const AGENT_PRESETS: ReadonlyArray<AgentPresetOption> = [
	{
		id: "standard",
		label: "标准模式",
		desc: "全能：文件/Shell/检索/Skills/目标/子代理/工作流",
		trust: "system",
	},
	{
		id: "code",
		label: "PTC 模式",
		desc: "标准能力 + Code Mode（多步操作一次执行，更快）",
		trust: "system",
	},
	{
		id: "minimal",
		label: "极简模式",
		desc: "仅 bash + 文件编辑，轻量省 token",
		trust: "system",
	},
	{
		id: "cordis",
		label: "创造模式",
		desc: "标准能力 + preset 创作工具（面向开发者）",
		trust: "system",
	},
];

/** Permission preset options (dsh-permission-presets). */
export const PERMISSION_PRESETS: ReadonlyArray<{
	id: string;
	label: string;
	desc: string;
}> = [
	{ id: "read-only", label: "只读", desc: "沙箱只读，危险操作需审批" },
	{
		id: "workspace-write",
		label: "工作区写",
		desc: "仅工作区可写，危险操作需审批",
	},
	{
		id: "danger-full-access",
		label: "Full access",
		desc: "全访问 + 审批 never（默认）",
	},
];

/** Append action buttons to a markdown card's body. */
export function withButtons(card: unknown, buttons: unknown[]): unknown {
	const c = card as { body?: { elements?: unknown[] } };
	return {
		...c,
		body: {
			...(c.body ?? {}),
			elements: [...(c.body?.elements ?? []), ...buttons],
		},
	};
}

/**
 * Intent-confirmation card (DSH ask_user_question → Feishu).
 *
 * Single-select (default): one button per option, answered immediately via op
 * "uqa:<questionId>:<optionIndex>".
 *
 * Multi-select (multiSelect === true): a form_container with a
 * multi_select_static dropdown; the user taps 提交 and the onSubmit callback
 * returns action.form_value.answer (string[] of option indexes — Feishu spells
 * the form payload in snake_case; the bridge accepts both spellings) via op
 * "uqam:<questionId>".
 *
 * The footer always invites a plain-text reply as a custom answer.
 */
export function questionCard(q: {
	id: string;
	header?: string;
	question: string;
	detail?: string;
	options?: ReadonlyArray<{ label: string; description?: string }>;
	multiSelect?: boolean;
}): unknown {
	const header = q.header
		? {
				header: {
					title: { tag: "plain_text", content: q.header },
					template: "blue" as const,
				},
			}
		: {};
	if (q.multiSelect) {
		const options = (q.options ?? []).map((o, i) => ({
			text: { tag: "plain_text", content: o.label },
			value: String(i),
		}));
		return {
			schema: "2.0",
			...header,
			body: {
				elements: [
					{ tag: "markdown", content: q.question },
					...(q.detail ? [{ tag: "markdown", content: q.detail }] : []),
					{
						tag: "form_container",
						children: [
							{
								tag: "multi_select_static",
								name: "answer",
								placeholder: {
									tag: "plain_text",
									content: "请选择（可多选）…",
								},
								options,
							},
						],
						onSubmit: [
							{ type: "callback", value: { op: `uqam:${q.id}` } },
						],
					},
					{ tag: "markdown", content: "或直接发消息输入自定义答案" },
				],
			},
		};
	}
	const elements: unknown[] = [
		{ tag: "markdown", content: q.question },
		...(q.detail ? [{ tag: "markdown", content: q.detail }] : []),
	];
	(q.options ?? []).forEach((o, i) => {
		elements.push(button(o.label, { op: `uqa:${q.id}:${i}` }));
	});
	elements.push({
		tag: "markdown",
		content: "或直接发消息输入自定义答案",
	});
	return {
		schema: "2.0",
		...header,
		body: { elements },
	};
}

/** Single-select mode picker card — tap a button to switch (no typing). */
export function modeCard(
	current?: string,
	presets?: ReadonlyArray<AgentPresetOption>,
): unknown {
	const roster = presets && presets.length > 0 ? presets : AGENT_PRESETS;
	return markdownCard(
		[
			"**Agent 模式**（单选，点按钮即切换，下条消息生效）",
			"",
			...roster.map(
				(p) =>
					`- ${p.label}${p.trust === "user" ? "（自定义）" : ""}${
						current === p.id ? " ← 当前" : ""
					}：${p.desc ?? p.id}${p.broken ? `（不可用：${p.broken}）` : ""}`,
			),
		].join("\n"),
		{ header: "切换模式", accent: true },
	) as {
		body: { elements: unknown[] };
	};
}

/** Model picker card grouped by provider: provider header + one button per model. */
export function modelCard(
	current: { provider?: string; model?: string } | undefined,
	groups: ReadonlyArray<{
		provider: string;
		label?: string;
		models: ReadonlyArray<{ id: string; name?: string }>;
	}>,
): unknown {
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: `**当前模型**: ${current?.provider ?? "?"}/${current?.model ?? "未设置"}`,
		},
		{
			tag: "markdown",
			content: "**按供应商选择模型**（点按钮即切换，下条消息生效）",
		},
	];
	let first = true;
	for (const g of groups) {
		if (g.models.length === 0) continue;
		if (!first) elements.push({ tag: "hr" });
		first = false;
		elements.push({
			tag: "markdown",
			content: `**${g.label ?? g.provider}**`,
		});
		for (const m of g.models) {
			elements.push({
				tag: "button",
				width: "fill",
				text: { tag: "plain_text", content: m.name ?? m.id },
				behaviors: [
					{
						type: "callback",
						value: { op: `model:${g.provider}/${m.id}` },
					},
				],
			});
		}
	}
	if (first) {
		elements.push({
			tag: "markdown",
			content: "（无可用模型列表）",
		});
	}
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "切换模型" },
			template: "blue",
		},
		body: { elements },
	};
}

/** Model-owned reasoning effort picker for one Feishu conversation. */
export function reasoningCard(
	model: { provider: string; model: string },
	current: string | undefined,
	defaultEffort: string | undefined,
	efforts: ReadonlyArray<{ id: string; name: string; description?: string }>,
): unknown {
	const effective = current ?? defaultEffort;
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: [
				`**当前模型**: ${model.provider}/${model.model}`,
				`**当前强度**: ${effective ?? "提供方默认"}${current ? "（本会话指定）" : "（跟随默认）"}`,
				"",
				"选择只影响当前飞书会话，下次模型请求生效，不会清空上下文。",
			].join("\n"),
		},
		button("跟随模型默认", { op: "reasoning:default" }),
	];
	for (const effort of efforts) {
		elements.push(button(
			`${effort.name}${effort.id === effective ? "（当前）" : ""}`,
			{ op: `reasoning:${effort.id}` },
		));
		if (effort.description) elements.push({ tag: "markdown", content: effort.description });
	}
	return {
		schema: "2.0",
		header: { title: { tag: "plain_text", content: "切换思考强度" }, template: "blue" },
		body: { elements },
	};
}

/** Single-select permission picker card. */
export function permissionCard(current?: string): unknown {
	return markdownCard(
		[
			"**权限模式**（单选，点按钮即切换）",
			"",
			...PERMISSION_PRESETS.map(
				(p) => `- ${p.label}${current === p.id ? " ← 当前" : ""}：${p.desc}`,
			),
		].join("\n"),
		{ header: "切换权限", accent: true },
	) as {
		body: { elements: unknown[] };
	};
}

/**
 * Workspace history picker card (/resume): one button per historical session
 * of the CURRENT workspace (newest first).
 *
 * User-friendliness decisions:
 * - Relative times (5 分钟前 / 3 天前) instead of raw timestamps.
 * - Stored preset badge per row; the CURRENT session is listed too but its
 *   button is disabled (users see where they are).
 * - Button op carries the session id URI-ENCODED — the card-action dispatcher
 *   splits op at the FIRST ":" and lark-link session ids are full of colons
 *   (`lark-link:dm:oc_x:nonce:0`); an unencoded id would lose its prefix and
 *   the click would resolve to 未找到会话.
 */
/** Relative time as shown in the pickers (刚刚 / 5 分钟前 / 3 天前). */
export function relativeTime(ts: number, now: number = Date.now()): string {
	const d = Math.max(0, now - ts);
	const m = Math.floor(d / 60_000);
	if (m < 1) return "刚刚";
	if (m < 60) return `${m} 分钟前`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} 小时前`;
	const day = Math.floor(h / 24);
	if (day < 30) return `${day} 天前`;
	return new Date(ts).toLocaleDateString("zh-CN");
}

export function resumeCard(
	sessions: ReadonlyArray<{
		id: string;
		createdAt: number;
		preset?: string;
		title?: string;
		summary?: string;
		userTurns?: number;
		toolCalls?: number;
		lastActivityAt?: number;
	}>,
	currentSessionId?: string,
	opts: { now?: () => number } = {},
): unknown {
	const now = opts.now ?? Date.now;
	const elements: unknown[] = [
		{
			tag: "markdown",
			content:
				"**恢复历史会话**（点按钮即恢复；或直接回复 `/resume <序号>`）",
		},
	];
	// Sequence numbers count only RESUMABLE rows — the current session is
	// displayed (disabled, unnumbered) so `/resume <n>` always matches the
	// numbered buttons exactly.
	let n = 0;
	sessions.forEach((s) => {
		const isCurrent = s.id === currentSessionId;
		const rowNumber = isCurrent ? undefined : ++n;
		const titlePart = s.title ? s.title.slice(0, 32) : "会话";
		const activityAt = s.lastActivityAt ?? s.createdAt;
		const stats = [
			s.preset ? `模式 ${s.preset}` : undefined,
			typeof s.userTurns === "number" ? `${s.userTurns} 轮提问` : undefined,
			typeof s.toolCalls === "number" && s.toolCalls > 0
				? `${s.toolCalls} 次工具`
				: undefined,
		].filter(Boolean);
		elements.push({
			tag: "markdown",
			content: [
				isCurrent ? `**当前 · ${titlePart}**` : `**#${rowNumber} · ${titlePart}**`,
				`${relativeTime(activityAt, now())}${stats.length > 0 ? ` · ${stats.join(" · ")}` : ""}`,
				s.summary ? `> ${s.summary}` : "> 暂无可提取的回复概览",
			].join("\n"),
		});
		const label = isCurrent ? "当前会话" : `恢复 #${rowNumber}`;
		const btn = button(label, { op: `resume:${encodeURIComponent(s.id)}` });
		if (isCurrent) {
			(btn as { disabled?: boolean }).disabled = true;
		}
		elements.push(btn);
	});


	if (currentSessionId && !sessions.some((s) => s.id === currentSessionId)) {
		// The current session was excluded from the listing (fresh chat, no
		// history yet) — still show where the conversation IS.
		elements.push({
			tag: "markdown",
			content: `- 当前会话：刚刚开始（发消息即在此会话继续）`,
		});
	}
	if (sessions.length === 0) {
		elements.push({
			tag: "markdown",
			content: "（该工作区暂无历史会话日志）",
		});
	}
	elements.push({
		tag: "markdown",
		content: [
			"———",
			"💡 恢复后**下一条消息接续历史上下文**；此前的会话仍然保留，随时可再 `/resume` 切回。",
			"新起会话用 `/new`；换工作区用 `/workspace <路径>`。",
			"重命名 / 删除 / 迁移项目请用 `/manage`（对话管理）。",
		].join("\n"),
	});
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "恢复历史会话" },
			template: "blue",
		},
		body: { elements },
	};
}

/**
 * /help — grouped command reference.
 *
 * The LIST is the primary content (a regression had the panel replace this
 * whole card with its generic "✅ 操作已完成" ack, so the list never reached
 * the user), followed by a button that opens the control panel so every entry
 * is also reachable in one tap.
 */
export function helpCard(): unknown {
	const groups: ReadonlyArray<{ title: string; lines: ReadonlyArray<string> }> = [
		{
			title: "会话",
			lines: [
				"`/new` 新任务（并行，需确认） · `/stop` 停止当前任务",
				"`/tasks` 任务列表与切换 · `/manage` 对话管理（重命名/删除/迁移项目）",
			],
		},
		{
			title: "模型与模式",
			lines: [
				"`/model` 切换模型 · `/reasoning` 思考强度（`/thinking` 同义）",
				"`/mode` Agent 模式 · `/permission` 权限",
			],
		},
		{
			title: "工作区与文件",
			lines: [
				"`/workspace` 目录浏览器（可上下浏览、新建文件夹）",
				"`/cwd` 查看当前工作区 · `/files [路径]` 列出目录内容",
			],
		},
		{
			title: "诊断与运维",
			lines: [
				"`/status` 桥接状态 · `/whoami` 当前会话诊断",
				"`/usage` 用量 · `/doctor` 诊断包 · `/reconnect` 重连",
			],
		},
		{
			title: "配置与桥管理",
			lines: [
				"`/lark-config` 设置面板 · `/stream on|off` 流式开关",
				"`/lark` 桥管理（setup/start/stop/restart/status）",
			],
		},
	];
	const text = [
		"**可用命令**（点下方按钮进入控制面板，或直接输入）",
		"",
		...groups.flatMap((group) => [`**${group.title}**`, ...group.lines, ""]),
		"`/goal`、`/compact` 等 DSH 命令原样执行；skill 无需前缀，直接描述任务即可。",
	].join("\n");
	return withButtons(
		markdownCard(text, { header: "Lark Link 帮助", accent: true }),
		[button("🧭 打开控制面板", { op: "menu" }, "primary")],
	);
}

/** Welcome card with one-click buttons (schema 2.0 平铺按钮). */
export function welcomeCard(botName: string): unknown {
	return {
		schema: "2.0",
		body: {
			header: {
				title: { tag: "plain_text", content: "连接成功" },
				template: "blue",
			},
			elements: [
				{
					tag: "markdown",
					content: `**${botName} 已连接**\n\n你可以直接和我说话，或点下方按钮：`,
				},
				button("命令面板", { op: "help" }),
				button("桥接状态", { op: "status" }),
				button("停止任务", { op: "stop" }),
			],
		},
	};
}

/**
 * Control panel — the single entry point for every bridge command. `/menu`,
 * `/help` and the welcome card all land here; every action is one tap and no
 * command needs to be typed from memory.
 */
export function commandPanelCard(): unknown {
	const groups: ReadonlyArray<{
		title: string;
		items: ReadonlyArray<readonly [string, string]>;
	}> = [
		{
			title: "概览",
			items: [
				["📊 桥接状态", "status"],
				["🗂 对话管理", "manage"],
			],
		},
		{
			title: "会话",
			items: [
				["🗂 任务列表", "tasks"],
				["🆕 新任务", "new"],
				["⏹ 停止当前任务", "stop"],
				["📂 工作区", "workspace"],
				["📄 文件", "files"],
			],
		},
		{
			title: "模型与模式",
			items: [
				["🤖 模型", "model"],
				["🧠 思考强度", "reasoning"],
				["🎛 模式", "mode"],
				["🛡 权限", "permission"],
			],
		},
		{
			title: "诊断与运维",
			items: [
				["🩺 诊断包", "doctor"],
				["🔍 当前会话", "whoami"],
				["📈 用量", "usage"],
				["🔌 重连", "reconnect"],
			],
		},
		{
			title: "配置与桥管理",
			items: [
				["⚙️ 设置", "lark-config"],
				["🌊 流式开关", "stream"],
				["🪶 桥管理", "lark"],
				["❓ 帮助", "help"],
			],
		},
	];
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: "**命令控制面板**\n点按钮直接执行；也可以直接输入文字与 Agent 对话。",
		},
	];
	for (const group of groups) {
		elements.push({ tag: "markdown", content: `**${group.title}**` });
		for (const [label, op] of group.items) elements.push(button(label, { op }));
	}
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "控制面板" },
			template: "blue",
		},
		body: { elements },
	};
}

// ---- conversation management (/manage) ---------------------------------------

/**
 * One row of the conversation-management panel. `alias` is the bridge-side name
 * (see session-aliases.ts) and wins over the derived `title`, because DSH can
 * only retitle a session that is live in its store.
 */
export interface ManageableSession {
	id: string;
	createdAt: number;
	title?: string;
	alias?: string;
	preset?: string;
	summary?: string;
	userTurns?: number;
	toolCalls?: number;
	lastActivityAt?: number;
	/** Workspace (project) the session belongs to. */
	cwd?: string;
}

const sessionLabel = (s: { title?: string; alias?: string }): string =>
	s.alias ?? s.title ?? "（未命名会话）";

const sessionStats = (s: ManageableSession): string =>
	[
		s.preset ? `模式 ${s.preset}` : undefined,
		typeof s.userTurns === "number" ? `${s.userTurns} 轮提问` : undefined,
		typeof s.toolCalls === "number" && s.toolCalls > 0 ? `${s.toolCalls} 次工具` : undefined,
	]
		.filter(Boolean)
		.join(" · ");

/**
 * /manage — the conversation-management panel: pick a session, then operate on
 * it (rename / delete / migrate project). Recovery itself stays in /resume, and
 * the panel always carries an explicit exit button.
 */
export function sessionManageCard(input: {
	sessions: ReadonlyArray<ManageableSession>;
	currentSessionId?: string;
	/** Result of the last action, echoed at the top of the panel. */
	note?: string;
	now?: () => number;
}): unknown {
	const now = input.now ?? Date.now;
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: [
				"**对话管理**",
				"选择一条会话后可以重命名 / 删除 / 迁移项目；恢复上下文仍用 `/resume`。",
			].join("\n"),
		},
	];
	if (input.note) elements.push({ tag: "markdown", content: `✅ ${input.note}` });
	input.sessions.forEach((s, index) => {
		const isCurrent = s.id === input.currentSessionId;
		const stats = sessionStats(s);
		elements.push({
			tag: "markdown",
			content: [
				`**#${index + 1} · ${sessionLabel(s)}**${isCurrent ? "（当前）" : ""}`,
				`${relativeTime(s.lastActivityAt ?? s.createdAt, now())}${stats ? ` · ${stats}` : ""}`,
				s.summary ? `> ${s.summary}` : "",
			]
				.filter(Boolean)
				.join("\n"),
		});
		elements.push(button("🗂 管理", { op: `manage:pick:${encodeURIComponent(s.id)}` }));
	});
	if (input.sessions.length === 0) {
		elements.push({ tag: "markdown", content: "（该工作区暂无历史会话日志）" });
	}
	elements.push({ tag: "hr" });
	elements.push(button("🔄 刷新", { op: "manage:list" }));
	elements.push(button("✖️ 退出对话管理", { op: "manage:exit" }, "primary"));
	return {
		schema: "2.0",
		header: { title: { tag: "plain_text", content: "对话管理" }, template: "blue" },
		body: { elements },
	};
}

/** One session's operations. Destructive/live-breaking ones are disabled for
 *  the session this conversation is currently using. */
export function sessionManageDetailCard(input: {
	session: ManageableSession;
	currentSessionId?: string;
	note?: string;
	now?: () => number;
}): unknown {
	const now = input.now ?? Date.now;
	const s = input.session;
	const isCurrent = s.id === input.currentSessionId;
	const id = encodeURIComponent(s.id);
	const stats = sessionStats(s);
	const renamed = Boolean(s.alias && s.title && s.alias !== s.title);
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: [
				`**名称**：${sessionLabel(s)}${renamed ? `（原名 ${s.title}）` : ""}`,
				`**会话 ID**：\`${s.id}\``,
				`**创建**：${new Date(s.createdAt).toLocaleString("zh-CN")} · **最近活动**：${relativeTime(s.lastActivityAt ?? s.createdAt, now())}`,
				...(stats ? [`**统计**：${stats}`] : []),
				...(s.cwd ? [`**所属项目**：\`${s.cwd}\``] : []),
				...(s.summary ? [`**最近回复**：${s.summary}`] : []),
			].join("\n"),
		},
	];
	if (isCurrent) {
		elements.push({
			tag: "markdown",
			content: "ℹ️ 这是当前会话：可以重命名；删除 / 迁移 / 恢复需要先切到别的会话（`/resume` 或 `/new`）。",
		});
	}
	if (input.note) elements.push({ tag: "markdown", content: `✅ ${input.note}` });
	elements.push({ tag: "hr" });
	elements.push(button("✏️ 重命名", { op: `manage:rename:${id}` }));
	const resume = button("▶️ 恢复此会话", { op: `manage:resume:${id}` }, "primary");
	const move = button("📦 迁移项目", { op: `manage:move:${id}` });
	const remove = button("🗑 删除", { op: `manage:delete:${id}` }, "danger");
	if (isCurrent) {
		for (const btn of [resume, move, remove]) {
			(btn as { disabled?: boolean }).disabled = true;
		}
	}
	elements.push(resume, move, remove);
	elements.push({ tag: "hr" });
	elements.push(button("↩️ 返回列表", { op: "manage:list" }));
	elements.push(button("✖️ 退出对话管理", { op: "manage:exit" }));
	return {
		schema: "2.0",
		header: { title: { tag: "plain_text", content: "对话管理 · 会话详情" }, template: "blue" },
		body: { elements },
	};
}

/** Rename form. The bridge keeps the alias; a LIVE session also gets the real
 *  DSH title (the host's title service only retitles live sessions). */
export function sessionRenameCard(input: { session: ManageableSession }): unknown {
	const id = encodeURIComponent(input.session.id);
	return {
		schema: "2.0",
		header: { title: { tag: "plain_text", content: "重命名会话" }, template: "blue" },
		body: {
			elements: [
				{
					tag: "markdown",
					content: [
						`当前名称：**${sessionLabel(input.session)}**`,
						"",
						"名称由桥侧保存并显示在对话管理 / `/resume` 中；若该会话正在被使用，会同时更新 DSH 标题。",
					].join("\n"),
				},
				{
					tag: "form_container",
					children: [
						{
							tag: "input",
							name: "alias",
							placeholder: { tag: "plain_text", content: "新名称（最多 48 字）" },
						},
					],
					onSubmit: [{ type: "callback", value: { op: `manage:rename:submit:${id}` } }],
				},
				button("↩️ 返回", { op: `manage:pick:${id}` }),
				{ tag: "markdown", content: "💡 名称最多 48 字；再次重命名会覆盖旧名称。" },
			],
		},
	};
}

/** Migrate-project picker: known projects as buttons, plus a free-form path. */
export function sessionMoveCard(input: {
	session: ManageableSession;
	targets: ReadonlyArray<string>;
}): unknown {
	const id = encodeURIComponent(input.session.id);
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: [
				`把 **${sessionLabel(input.session)}** 迁移到另一个项目（工作区目录）。`,
				input.session.cwd ? `当前项目：\`${input.session.cwd}\`` : "当前项目：未知",
				"迁移只改变这条会话归属的工作区，不会移动工作区里的任何文件。",
			].join("\n"),
		},
	];
	const candidates = input.targets.filter((target) => target !== input.session.cwd);
	if (candidates.length > 0) {
		elements.push({ tag: "markdown", content: "**选择目标项目**" });
		for (const target of candidates) {
			elements.push(
				button(`📦 ${target}`, {
					op: `manage:move:to:${id}|${encodeURIComponent(target)}`,
				}),
			);
		}
	} else {
		elements.push({ tag: "markdown", content: "（暂无其他项目，可在下面直接输入目标路径）" });
	}
	elements.push({ tag: "hr" });
	elements.push({
		tag: "form_container",
		children: [
			{
				tag: "input",
				name: "path",
				placeholder: { tag: "plain_text", content: "或输入目标路径，如 /home/ubuntu/dsh-workspace/demo" },
			},
		],
		onSubmit: [{ type: "callback", value: { op: `manage:move:submit:${id}` } }],
	});
	elements.push(button("↩️ 返回", { op: `manage:pick:${id}` }));
	return {
		schema: "2.0",
		header: { title: { tag: "plain_text", content: "迁移项目" }, template: "blue" },
		body: { elements },
	};
}

// ---- parallel tasks (/tasks) --------------------------------------------------

/** One row of the task list — a live task, or a historical session not yet bound. */
export interface TaskRow {
	/** Registered task id (`dm:oc_x#2`) — absent for a bare historical session. */
	taskId?: string;
	/** DSH session id, once the task has one. */
	sessionId?: string;
	/** 1-based ordinal within the conversation. */
	seq: number;
	/** Bridge-side task name. */
	label?: string;
	/** Derived session title. */
	title?: string;
	summary?: string;
	/** Stored agent preset of the underlying session (needed to resume it). */
	preset?: string;
	status: "running" | "idle" | "stopped";
	active: boolean;
	/** Discovered from the workspace log rather than from a task record. */
	historical?: boolean;
	lastActivityAt: number;
}

const taskLabel = (row: TaskRow): string =>
	row.label ?? row.title ?? (row.historical ? "历史会话" : "任务");

const statusBadge = (row: TaskRow): string =>
	row.status === "running" ? "🔵 运行中" : row.status === "idle" ? "⚪ 空闲" : "⚫ 已停止";

const taskStats = (row: TaskRow): string =>
	[
		`#${row.seq}`,
		statusBadge(row),
		row.active ? "当前" : undefined,
		row.historical ? "历史" : undefined,
	]
		.filter(Boolean)
		.join(" · ");

/**
 * /tasks — every task this conversation owns, RUNNING FIRST, with one-tap
 * switching. Supersedes the old /resume picker: a running task can be opened
 * mid-turn, and a historical session is simply a task that is not hosted.
 */
export function taskListCard(input: {
	tasks: ReadonlyArray<TaskRow>;
	note?: string;
	workspace?: string;
	now?: () => number;
}): unknown {
	const now = input.now ?? Date.now;
	// Running first, then most recently active: what the user wants to find is
	// almost always the thing that is still working.
	const rows = [...input.tasks].sort((a, b) => {
		const rank = (row: TaskRow): number => (row.status === "running" ? 0 : row.status === "idle" ? 1 : 2);
		const byStatus = rank(a) - rank(b);
		if (byStatus !== 0) return byStatus;
		return b.lastActivityAt - a.lastActivityAt;
	});
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: [
				"**任务**（运行中优先；点「切换」把消息发到那条任务）",
				input.workspace ? `工作区：\`${input.workspace}\`` : "",
			]
				.filter(Boolean)
				.join("\n"),
		},
	];
	if (input.note) elements.push({ tag: "markdown", content: `✅ ${input.note}` });
	rows.forEach((row) => {
		elements.push({
			tag: "markdown",
			content: [
				`**#${row.seq} · ${taskLabel(row)}**${row.active ? "（当前）" : ""}`,
				`${taskStats(row)} · ${relativeTime(row.lastActivityAt, now())}`,
				row.summary ? `> ${row.summary}` : "",
			]
				.filter(Boolean)
				.join("\n"),
		});
		if (row.taskId) {
			elements.push(
				button("▶️ 切换", { op: `tasks:switch:${encodeURIComponent(row.taskId)}` }, "primary"),
			);
			if (row.status === "running") {
				elements.push(button("⏹ 停止", { op: `tasks:stop:${encodeURIComponent(row.taskId)}` }));
			}
		} else if (row.sessionId) {
			// A historical session becomes a task the moment it is opened.
			elements.push(
				button("▶️ 切换", { op: `tasks:open:${encodeURIComponent(row.sessionId)}` }, "primary"),
			);
		}
		if (row.sessionId) {
			elements.push(button("🗂 管理", { op: `manage:pick:${encodeURIComponent(row.sessionId)}` }));
		}
	});
	if (rows.length === 0) {
		elements.push({ tag: "markdown", content: "（还没有任务，直接发消息或点下面的「新任务」）" });
	}
	elements.push({ tag: "hr" });
	elements.push(button("➕ 新任务", { op: "tasks:new" }, "primary"));
	elements.push(button("🔄 刷新", { op: "tasks:list" }));
	elements.push(button("✖️ 退出", { op: "tasks:exit" }));
	return {
		schema: "2.0",
		header: { title: { tag: "plain_text", content: "任务列表" }, template: "blue" },
		body: { elements },
	};
}

/**
 * Switch/refresh result for ONE task: its state, what it has produced so far
 * (including the answer that is still being written) and its controls.
 */
export function taskBriefingCard(input: {
	task: TaskRow;
	/** Forwarder snapshot of the task's CURRENT turn. */
	snapshot?: { text: string; stage: string; streaming: boolean; settled: boolean };
	workspace?: string;
	preset?: string;
	todos?: ReadonlyArray<{ content: string; status: string }>;
	note?: string;
	now?: () => number;
}): unknown {
	const now = input.now ?? Date.now;
	const row = input.task;
	const running = row.status === "running";
	const parts: string[] = [
		`**#${row.seq} · ${taskLabel(row)}**`,
		`状态：${statusBadge(row)}${row.active ? " · 当前任务（新消息发到这里）" : ""}`,
		`最近活动：${relativeTime(row.lastActivityAt, now())}`,
	];
	if (input.workspace) parts.push(`工作区：\`${input.workspace}\``);
	if (input.preset) parts.push(`模式：\`${input.preset}\``);
	if (row.sessionId) parts.push(`会话：\`${row.sessionId}\``);
	if (row.summary) parts.push(`> ${row.summary}`);
	if (input.todos && input.todos.length > 0) {
		parts.push(
			"**进度**",
			...input.todos
				.slice(0, 12)
				.map((todo) =>
					todo.status === "completed"
						? `- ~~${todo.content}~~`
						: todo.status === "in_progress"
							? `- 🔄 ${todo.content}`
							: `- ⬜ ${todo.content}`,
				),
		);
	}
	const elements: unknown[] = [{ tag: "markdown", content: parts.join("\n") }];
	if (input.note) elements.push({ tag: "markdown", content: `✅ ${input.note}` });
	const snap = input.snapshot;
	if (running) {
		elements.push({
			tag: "markdown",
			content: [
				"🔵 **运行中**：输出继续更新在它自己的卡片里（已为你续上）。",
				snap?.text
					? `**当前进度**\n> ${snap.text.split("\n").slice(-6).join("\n> ").slice(0, 700)}`
					: "**当前进度**\n> 正在思考或调用工具，还没有可展示的正文。",
			].join("\n"),
		});
	} else if (snap?.text) {
		elements.push({
			tag: "markdown",
			content: `**最近输出**\n> ${snap.text.split("\n").slice(-6).join("\n> ").slice(0, 700)}`,
		});
	}
	elements.push({ tag: "hr" });
	if (row.taskId) {
		if (running) {
			elements.push(button("⏹ 停止任务", { op: `tasks:stop:${encodeURIComponent(row.taskId)}` }));
		}
		elements.push(
			button("🔄 刷新状态", { op: `tasks:refresh:${encodeURIComponent(row.taskId)}` }),
		);
	}
	if (row.sessionId) {
		elements.push(button("🗂 管理", { op: `manage:pick:${encodeURIComponent(row.sessionId)}` }));
	}
	elements.push(button("📋 任务列表", { op: "tasks:list" }));
	elements.push(button("✖️ 退出", { op: "tasks:exit" }));
	return {
		schema: "2.0",
		header: { title: { tag: "plain_text", content: "任务" }, template: running ? "green" : "blue" },
		body: { elements },
	};
}

/** Delete confirmation — the only destructive action in the panel. */
export function sessionDeleteConfirmCard(input: { session: ManageableSession }): unknown {
	const id = encodeURIComponent(input.session.id);
	return {
		schema: "2.0",
		header: { title: { tag: "plain_text", content: "删除会话" }, template: "red" },
		body: {
			elements: [
				{
					tag: "markdown",
					content: [
						`确认删除 **${sessionLabel(input.session)}**？`,
						"",
						"会移除该会话的持久化日志（含全部历史上下文），**无法恢复**。",
						"当前正在使用的会话不能删除。",
					].join("\n"),
				},
				button("🗑 确认删除", { op: `manage:delete:confirm:${id}` }, "danger"),
				button("✖️ 取消", { op: `manage:pick:${id}` }),
			],
		},
	};
}

/** CardKit entity used for command replies. It is intentionally one expanded
 * collapsible panel: later command replies update its markdown element instead
 * of creating another message above the main conversation. */
export function commandPanelStreamCard(
	entries: ReadonlyArray<{ command: string; result: string; at?: number }>,
): unknown {
	const history = `**命令记录（${entries.length}）**\n\n${entries
		.map((entry) => {
			const time = new Date(entry.at ?? Date.now()).toLocaleTimeString("zh-CN", {
				hour: "2-digit",
				minute: "2-digit",
			});
			return `**${time}** · \`/${entry.command}\`\n${entry.result}`;
		})
		.join("\n\n") || "*等待命令…*"}`;
	return {
		schema: "2.0",
		config: {
			update_multi: true,
			streaming_mode: true,
			streaming_config: {
				print_frequency_ms: { default: 80 },
				print_step: { default: 2 },
				print_strategy: "fast",
			},
		},
		body: {
			elements: [
				{
					tag: "collapsible_panel",
					expanded: true,
					header: {
						title: { tag: "plain_text", content: "命令与设置" },
						icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
						icon_position: "right",
						icon_expanded_angle: -180,
					},
					border: { color: "grey", corner_radius: "5px" },
					elements: [{ tag: "markdown", content: history, element_id: "command_md" }],
				},
			],
		},
	};
}

const decoratePanelCallbacks = (input: unknown, cardId: string): unknown => {
	if (Array.isArray(input)) return input.map((item) => decoratePanelCallbacks(item, cardId));
	if (!input || typeof input !== "object") return input;
	const record = input as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (
			key === "value" &&
			value &&
			typeof value === "object" &&
			typeof (value as Record<string, unknown>).op === "string"
		) {
			out[key] = { ...(value as Record<string, unknown>), _panel_card_id: cardId };
		} else {
			out[key] = decoratePanelCallbacks(value, cardId);
		}
	}
	return out;
};

const commandPanelShell = (
	command: string,
	expanded: boolean,
	elements: unknown[],
	template: string = "blue",
): unknown => ({
	schema: "2.0",
	config: { update_multi: true },
	body: {
		elements: [
			{
				tag: "collapsible_panel",
				expanded,
				header: {
					title: { tag: "plain_text", content: `/${command}` },
					template,
					icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
					icon_position: "right",
					icon_expanded_angle: -180,
				},
				border: { color: "grey", corner_radius: "5px" },
				elements,
			},
		],
	},
});

export function commandRunningCard(command: string, elapsedSeconds: number): unknown {
	return commandPanelShell(command, true, [
		{ tag: "markdown", content: `⏳ **执行中** · ${elapsedSeconds}s` },
	]);
}

export function commandCollapsedCard(command: string, result: string): unknown {
	return commandPanelShell(
		command,
		false,
		[{ tag: "markdown", content: result ? `✅ ${result}` : "✅ 已完成" }],
		"green",
	);
}

/**
 * Same shell as commandCollapsedCard, but the header turns red and the body is
 * prefixed ⚠️. Previously a failed command collapsed into the same green
 * "✅ 操作已完成" as a success, so failures were indistinguishable from
 * no-ops in the Feishu timeline.
 */
export function commandFailedCard(command: string, result: string): unknown {
	return commandPanelShell(
		command,
		false,
		[{ tag: "markdown", content: result ? `⚠️ ${result}` : "⚠️ 执行失败" }],
		"red",
	);
}

export function commandInteractivePanelCard(
	command: string,
	card: unknown,
	cardId: string,
): unknown {
	const decorated = decoratePanelCallbacks(card, cardId) as Record<string, unknown>;
	const body = decorated?.body as Record<string, unknown> | undefined;
	const elements = Array.isArray(body?.elements) ? (body.elements as unknown[]) : [];
	return commandPanelShell(command, true, elements);
}

/**
 * Structured bridge status card: the one-line overview plus the full detail
 * block (kept as ONE markdown element so multi-line detail survives — the
 * text channel used to fold it into a single clipped line), with the routine
 * follow-up actions attached.
 */
export function statusCard(
	statusText: string,
	detailLines: string[] = [],
): unknown {
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "桥接状态" },
			template: "blue",
		},
		body: {
			elements: [
				{ tag: "markdown", content: `**概览**\n${statusText}` },
				...(detailLines.length > 0
					? [
							{
								tag: "markdown",
								content: `**明细**\n${detailLines
									.map((line) => `- ${line}`)
									.join("\n")}`,
							},
						]
					: []),
				{ tag: "hr" },
				button("🩺 诊断包", { op: "doctor" }),
				button("🔌 重连", { op: "reconnect" }),
				button("🧭 控制面板", { op: "menu" }),
			],
		},
	};
}

export function setupCard(qrUrl: string, expireInSec: number): unknown {
	return markdownCard(
		[
			"**扫码创建飞书应用**（30 秒上线）",
			"",
			`二维码有效期 ${expireInSec}s，或用链接手动打开：`,
			qrUrl,
		].join("\n"),
		{ header: "Lark Link 设置", accent: true },
	);
}

export function errorCard(message: string): unknown {
	return markdownCard(`**出错了**\n\n${message}`, {
		header: "错误",
		accent: false,
	});
}

// ---- command result / confirmation cards ------------------------------------

/**
 * /new confirmation. Resetting the session is cheap for the bridge but
 * destroys the conversation context, so it asks before rotating.
 */
export function newConfirmCard(input: { workspace: string }): unknown {
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "开启新任务" },
			template: "orange",
		},
		body: {
			elements: [
				{
					tag: "markdown",
					content: [
						"将开启一条**全新的任务**：新上下文，与当前任务并行存在。",
						"⚡ 当前任务**不会被停止**，长任务会继续在后台跑，用 `/tasks` 查看与切换。",
						"",
						`📁 工作区: \`${input.workspace}\``,
					].join("\n"),
				},
				button("✅ 确认新任务", { op: "new:confirm" }, "primary"),
				button("✖️ 取消", { op: "new:cancel" }),
			],
		},
	};
}

/** /stop result plus the natural follow-ups (nothing running should still be
 *  actionable instead of dead-ending on a one-line text ack). */
export function stopResultCard(input: { text: string }): unknown {
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "停止任务" },
			template: "green",
		},
		body: {
			elements: [
				{ tag: "markdown", content: input.text },
				button("📊 桥接状态", { op: "status" }),
				button("🆕 新会话", { op: "new" }),
			],
		},
	};
}

/**
 * Button-driven settings panel for /lark-config. Every toggle rewrites ONE
 * hot-reloadable key through the generic `cfg:<key>=<value>` op, so adding a
 * switch never needs a new callback branch; the advanced text form stays
 * available for keys that need free-form values.
 */
export function configPanelCard(input: {
	streamingEnabled: boolean;
	reactionsEnabled: boolean;
	groupPolicy: string;
	agentPreset: string;
	permissionMode: string;
	allowlist: ReadonlyArray<string>;
	denyList: ReadonlyArray<string>;
}): unknown {
	const state = (value: boolean): string => (value ? "🟢 已开启" : "⚪ 已关闭");
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: "**常用设置**（点按钮即时生效，写入 runtime-overrides.json）",
		},
		{ tag: "markdown", content: `**流式卡片** 当前: ${state(input.streamingEnabled)}` },
		button("开启流式卡片", { op: "cfg:streaming.enabled=true" }),
		button("关闭流式卡片", { op: "cfg:streaming.enabled=false" }),
		{ tag: "markdown", content: `**表情回执** 当前: ${state(input.reactionsEnabled)}` },
		button("开启表情回执", { op: "cfg:reactions.enabled=true" }),
		button("关闭表情回执", { op: "cfg:reactions.enabled=false" }),
		{ tag: "markdown", content: `**群聊触发** 当前: \`${input.groupPolicy}\`` },
		button("免 @ 全部触发", { op: "cfg:groupPolicy=open" }),
		button("仅 @ 机器人时触发", { op: "cfg:groupPolicy=mention" }),
		button("仅关键词触发", { op: "cfg:groupPolicy=keywords" }),
		{ tag: "hr" },
		{
			tag: "markdown",
			content: `**当前模式** \`${input.agentPreset}\` · **权限** \`${input.permissionMode}\``,
		},
		button("🎛 切换模式", { op: "mode" }),
		button("🛡 切换权限", { op: "permission" }),
		{ tag: "hr" },
		{
			tag: "markdown",
			content: [
				"**高级**（文本形式，可改全部热改键）",
				`允许用户: \`${input.allowlist.length > 0 ? input.allowlist.join(", ") : "未限制"}\` · 命令拒绝前缀: \`${input.denyList.length > 0 ? input.denyList.join(", ") : "无"}\``,
				"例：`/lark-config allowlist=ou_xxx`、`/lark-config streaming.printStep=5`",
			].join("\n"),
		},
	];
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "设置" },
			template: "blue",
		},
		body: { elements },
	};
}

/** /lark — bridge administration without typing subcommands. */
export function larkAdminPanelCard(input: {
	connState: string;
	configured: boolean;
}): unknown {
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "Lark 桥管理" },
			template: "blue",
		},
		body: {
			elements: [
				{
					tag: "markdown",
					content: `**连接**: \`${input.connState}\` · **凭据**: ${
						input.configured ? "已配置" : "未配置"
					}`,
				},
				button("▶️ 启动", { op: "lark:start" }, "primary"),
				button("⏹ 停止", { op: "lark:stop" }),
				button("🔄 重启", { op: "lark:restart" }),
				button("📊 桥状态", { op: "lark:status" }),
				button("📱 扫码配置应用", { op: "lark:setup" }),
				button("⚠️ 清除凭据与状态", { op: "lark:uninstall-clean" }, "danger"),
			],
		},
	};
}

// ---- workspace browser -------------------------------------------------------

/**
 * Interactive directory browser for /workspace.
 *
 * Every navigation re-renders THIS card (the caller updates the same CardKit
 * entity through `_panel_card_id`), so browsing never floods the chat. `..` is
 * disabled when there is no parent (filesystem root); the conversation's
 * current workspace is marked so the user can see where it stands.
 */
export function workspaceBrowserCard(input: {
	browsePath: string;
	workspacePath: string;
	parentPath?: string;
	entries: ReadonlyArray<{ name: string; path: string }>;
	truncated?: boolean;
}): unknown {
	const isCurrent = input.browsePath === input.workspacePath;
	const elements: unknown[] = [
		{
			tag: "markdown",
			content: `**当前浏览**\n\`${input.browsePath}\`${
				isCurrent
					? "\n（就是当前工作区）"
					: `\n当前工作区: \`${input.workspacePath}\``
			}`,
		},
	];
	// Paths travel URI-encoded inside the ops: card actions split on the FIRST
	// ":" and absolute paths / conversation keys contain colons, so a raw path
	// would lose its prefix and resolve to the wrong directory.
	const up = button("⬆️ 上一级", {
		op: input.parentPath
			? `ws:up:${encodeURIComponent(input.parentPath)}`
			: "ws:up",
	});
	if (!input.parentPath) (up as { disabled?: boolean }).disabled = true;
	elements.push(up);
	elements.push({
		tag: "markdown",
		content: `**子目录**（${input.entries.length}${input.truncated ? "+" : ""}）`,
	});
	if (input.entries.length === 0) {
		elements.push({ tag: "markdown", content: "（没有子目录）" });
	} else {
		for (const entry of input.entries) {
			elements.push(
				button(`📁 ${entry.name}`, {
					// Session keys / paths contain colons; card actions split on the
					// FIRST one, so the absolute path travels URI-encoded.
					op: `ws:cd:${encodeURIComponent(entry.path)}`,
				}),
			);
		}
		if (input.truncated) {
			elements.push({
				tag: "markdown",
				content: "*(子目录过多，仅显示前若干个；可先用 `/files` 或进入子目录继续查看)*",
			});
		}
	}
	const encodedBrowse = encodeURIComponent(input.browsePath);
	elements.push({ tag: "hr" });
	elements.push(
		button("✅ 切换到此目录", { op: `ws:pick:${encodedBrowse}` }, "primary"),
	);
	elements.push(button("🆕 新建文件夹", { op: `ws:mk:${encodedBrowse}` }));
	elements.push(button("✖️ 取消（保持原工作区）", { op: "ws:cancel" }));
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "选择工作区目录" },
			template: "blue",
		},
		body: { elements },
	};
}

/** New-folder form for the workspace browser (falls back to the text form). */
export function workspaceNewFolderCard(input: { parentPath: string }): unknown {
	const encodedParent = encodeURIComponent(input.parentPath);
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: "新建文件夹" },
			template: "blue",
		},
		body: {
			elements: [
				{ tag: "markdown", content: `在 \`${input.parentPath}\` 下新建目录。` },
				{
					tag: "form_container",
					children: [
						{
							tag: "input",
							name: "name",
							placeholder: {
								tag: "plain_text",
								content: "文件夹名称（不含路径分隔符）",
							},
						},
					],
					onSubmit: [
						{
							type: "callback",
							value: { op: `ws:mk:submit:${encodedParent}` },
						},
					],
				},
				button("↩️ 返回目录浏览", { op: `ws:back:${encodedParent}` }),
				{
					tag: "markdown",
					content: "表单不可用时，可直接发送 `/workspace mk <名称>`。",
				},
			],
		},
	};
}

export const CARD_MESSAGE_TYPE = "interactive";

/**
 * 网站预览卡：链接按钮用 open_url（在飞书内打开，手机落内置浏览器），
 * 刷新/关闭用 callback（服务端管理隧道生命周期）。
 */
export function sitePreviewCard(input: {
	title: string;
	publicUrl: string;
	debugUrl: string;
	origin: string;
	label: string;
	action: string;
	expiresAt: number;
	now?: number;
}): unknown {
	const now = input.now ?? Date.now();
	const minutes = Math.max(0, Math.round((input.expiresAt - now) / 60000));
	const applink = `https://applink.feishu.cn/client/web_url/open?mode=window&url=${encodeURIComponent(
		input.publicUrl,
	)}`;
	const openButton = {
		tag: "button",
		width: "fill",
		text: { tag: "plain_text", content: "🌐 在飞书内打开" },
		type: "primary",
		behaviors: [{ type: "open_url", default_url: applink }],
	};
	const debugButton = {
		tag: "button",
		width: "fill",
		text: { tag: "plain_text", content: "🐞 调试模式（vConsole）" },
		behaviors: [{ type: "open_url", default_url: `${input.debugUrl}` }],
	};
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: `🌐 ${input.title}` },
			template: "turquoise",
		},
		body: {
			elements: [
				{
					tag: "markdown",
					content: `**${input.action}** · ${input.label}\n原始地址 \`${input.origin}\` · 约 ${minutes} 分钟后失效`,
				},
				openButton,
				debugButton,
				button("🔄 刷新链接（地址会变）", { op: "site:refresh" }),
				button("🛑 关闭预览", { op: "site:stop" }, "danger"),
				{
					tag: "markdown",
					content: `直接链接：${input.publicUrl} · 调试：${input.debugUrl}`,
				},
			],
		},
	};
}

export * from "./task-cards.ts";

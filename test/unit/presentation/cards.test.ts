// Card builder tests (aligned with pi-feishu-link 2026-08-14 fix): schema 2.0
// cards MUST NOT contain tag:"action" containers (ErrCode 200861); buttons are
// flat body.elements with behaviors:[{type:"callback",value}] and width:"fill".

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	welcomeCard,
	commandPanelCard,
	statusCard,
	markdownCard,
	setupCard,
	errorCard,
	button,
	modeCard,
	reasoningCard,
	questionCard,
	resumeCard,
	helpCard,
	newConfirmCard,
	stopResultCard,
	configPanelCard,
	larkAdminPanelCard,
	workspaceBrowserCard,
	workspaceNewFolderCard,
	sessionManageCard,
	sessionManageDetailCard,
	sessionRenameCard,
	sessionMoveCard,
	sessionDeleteConfirmCard,
	taskListCard,
	taskBriefingCard,
} from "../../../src/presentation/cards.ts";

type Json = Record<string, unknown>;

function collectButtons(node: unknown, acc: Array<Json> = []): Array<Json> {
	if (Array.isArray(node)) {
		for (const item of node) collectButtons(item, acc);
		return acc;
	}
	if (node && typeof node === "object") {
		const obj = node as Json;
		if (obj.tag === "button") acc.push(obj);
		for (const v of Object.values(obj)) collectButtons(v, acc);
	}
	return acc;
}

test("命令卡片声明 schema 2.0（按钮需 behaviors 回调）", () => {
	for (const card of [
		welcomeCard("测试"),
		commandPanelCard(),
		statusCard("connected", []),
	]) {
		assert.equal((card as Json).schema, "2.0");
	}
	// setup/error 卡片本来就是 schema 1.0（config + 顶层 elements）。
	for (const card of [setupCard("https://x", 300), errorCard("oops")]) {
		assert.equal((card as Json).schema, "2.0");
	}
});

test("markdownCard 用 schema 2.0（与命令卡片一致）", () => {
	const card = markdownCard("**hi**") as Json;
	assert.equal(card.schema, "2.0");
	const body = card.body as Json;
	const elements = body.elements as Array<{ tag: string; content: string }>;
	assert.equal(elements[0]?.tag, "markdown");
	assert.equal(elements[0]?.content, "**hi**");
});

test("卡片不含 tag:action 容器（schema 2.0 已移除该能力，200861）", () => {
	const cards = [
		welcomeCard("测试"),
		commandPanelCard(),
		statusCard("connected", []),
	];
	let actionCount = 0;
	const walk = (n: unknown): void => {
		if (Array.isArray(n)) return n.forEach(walk);
		if (n && typeof n === "object") {
			const obj = n as Json;
			if (obj.tag === "action") actionCount++;
			Object.values(obj).forEach(walk);
		}
	};
	cards.forEach(walk);
	assert.equal(actionCount, 0, "schema 2.0 卡片不得包含 action 容器");
});

test("按钮直接平铺在 body.elements 且带 behaviors callback + width fill", () => {
	const card = welcomeCard("测试") as Json;
	const body = card.body as Json;
	const elements = body.elements as Json[];
	const buttons = elements.filter((e) => e.tag === "button");
	assert.ok(buttons.length >= 3, `welcome 卡应有按钮，实际 ${buttons.length}`);
	for (const b of buttons) {
		assert.equal(b.width, "fill", "按钮撑满宽度防截断");
		const behaviors = b.behaviors as Array<{ type: string; value: Json }>;
		assert.ok(
			behaviors[0]?.type === "callback",
			"按钮用 behaviors callback 回传",
		);
		assert.ok(typeof behaviors[0]?.value?.op === "string", "回传值含 op");
	}
});

test("按钮 op 路由到期望的命令", () => {
	const card = commandPanelCard() as Json;
	const body = card.body as Json;
	const buttons = collectButtons(body);
	const ops = buttons.map(
		(b) => (b.behaviors as Array<{ value: Json }>)[0]!.value.op as string,
	);
	assert.ok(ops.includes("status"));
	assert.ok(ops.includes("stop"));
	assert.ok(ops.includes("doctor"));
	assert.ok(ops.includes("lark-config"));
});

test("button helper: primary/danger 样式", () => {
	const primary = button(
		"批准",
		{ op: "approve", approvalId: "a1" },
		"primary",
	) as Json;
	assert.equal(primary.type, "primary");
	const danger = button(
		"拒绝",
		{ op: "deny", approvalId: "a1" },
		"danger",
	) as Json;
	assert.equal(danger.type, "danger");
	const plain = button("状态", { op: "status" }) as Json;
	assert.equal(plain.type, undefined);
});

test("modeCard 无名单时回退到官方 4 个模式", () => {
	const card = modeCard() as Json;
	const body = card.body as Json;
	const md = body.elements as Array<{ tag: string; content: string }>;
	const text = md.find((e) => e.tag === "markdown")!.content;
	for (const label of ["标准模式", "PTC 模式", "极简模式", "创造模式"]) {
		assert.ok(text.includes(label), `官方模式 ${label} 应出现在回退卡片`);
	}
});

test("modeCard 渲染动态名单（含自定义与不可用标注）", () => {
	const card = modeCard("aaa", [
		{ id: "standard", label: "标准模式", trust: "system" },
		{ id: "aaa", label: "AAA 模式", trust: "user", desc: "示例描述" },
		{ id: "bbb", label: "BBB 模式", trust: "user", broken: "示例原因" },
	]) as Json;
	const body = card.body as Json;
	const md = body.elements as Array<{ tag: string; content: string }>;
	const text = md.find((e) => e.tag === "markdown")!.content;
	assert.ok(text.includes("AAA 模式（自定义） ← 当前"), "自定义模式应标注并高亮当前");
	assert.ok(text.includes("（不可用：示例原因）"), "broken 模式应标注不可用原因");
	assert.ok(!text.includes("standard（自定义）"), "官方模式不应标自定义");
});

test("reasoningCard dynamically renders model-owned efforts and default reset", () => {
	const card = reasoningCard(
		{ provider: "webagent", model: "qwen.text.web.3.8-max" },
		"medium",
		"low",
		[
			{ id: "low", name: "Low" },
			{ id: "medium", name: "Medium" },
			{ id: "high", name: "High" },
		],
	) as Json;
	const ops = collectButtons(card).map(
		(b) => (b.behaviors as Array<{ value: Json }>)[0]!.value.op,
	);
	assert.deepEqual(ops, ["reasoning:default", "reasoning:low", "reasoning:medium", "reasoning:high"]);
	const text = JSON.stringify(card);
	assert.match(text, /medium/);
	assert.match(text, /本会话指定/);
});

test("questionCard 单选：每选项一个按钮，op 形如 uqa:<id>:<index>", () => {
	const card = questionCard({
		id: "q1",
		question: "请选择",
		options: [{ label: "A" }, { label: "B" }],
	}) as Json;
	const body = card.body as Json;
	const buttons = collectButtons(body);
	const ops = buttons.map(
		(b) => (b.behaviors as Array<{ value: Json }>)[0]!.value.op as string,
	);
	assert.deepEqual(ops, ["uqa:q1:0", "uqa:q1:1"]);
});

test("questionCard 多选：form_container + multi_select_static + 提交/onSubmit 只能一次", () => {
	const card = questionCard({
		id: "q9",
		question: "可多选",
		options: [{ label: "X" }, { label: "Y" }, { label: "Z" }],
		multiSelect: true,
	}) as Json;
	assert.equal(card.schema, "2.0");
	const body = card.body as Json;
	const elements = body.elements as Json[];
	const form = elements.find((e) => e.tag === "form_container") as
		| Json
		| undefined;
	assert.ok(form, "多选应包含 form_container");
	const children = (form!.children ?? []) as Json[];
	const select = children.find((c) => c.tag === "multi_select_static") as
		| Json
		| undefined;
	assert.ok(select, "form_container 内应有 multi_select_static");
	assert.equal(select!.name, "answer");
	const opts = (select!.options ?? []) as Array<{ value: string }>;
	assert.deepEqual(
		opts.map((o) => o.value),
		["0", "1", "2"],
		"选项值应为 stringified 索引",
	);
	const onSubmit = (form!.onSubmit ?? []) as Array<{ type: string; value: Json }>;
	assert.equal(onSubmit[0]?.type, "callback");
	assert.equal(onSubmit[0]?.value?.op, "uqam:q9");
	// 多选卡片不应有立即提交的单选项按钮
	assert.equal(collectButtons(body).length, 0, "多选不渲染立即提交按钮");
});


// ---- /resume picker card ------------------------------------------------------

function resumeButtons(card: unknown): Array<{ behaviors?: Array<{ value?: Json }>; disabled?: boolean }> {
	const c = card as { body?: { elements?: unknown[] } };
	return (c.body?.elements ?? []).filter(
		(e): e is { behaviors?: Array<{ value?: Json }>; disabled?: boolean } =>
			(e as { tag?: string }).tag === "button",
	);
}

test("resumeCard: button ops ENCODE the session id so colons survive card-action splitting", () => {
	const card = resumeCard(
		[
			{ id: "lark-link:dm:oc_x:nonce1:0", createdAt: Date.now() - 60_000 },
			{ id: "7c9e067f-abc", createdAt: Date.now() - 3_600_000 },
		],
		undefined,
		{ now: () => 2_000_000_000_000 },
	);
	const ops = resumeButtons(card)
		.filter((b) => String((b.behaviors?.[0]?.value as { op?: string })?.op ?? "").startsWith("resume:"))
		.map(
		(b) => (b.behaviors?.[0]?.value as { op?: string })?.op ?? "",
		);
	assert.equal(ops.length, 2);
	assert.equal(ops[0], "resume:lark-link~1dm~1oc_x~1nonce1~10".replaceAll("~1", "%3A"));
	assert.equal(ops[1], "resume:7c9e067f-abc");
});

test("resumeCard: relative times, titles, current-session row disabled, empty state", () => {
	const now = Date.now();
	const card = resumeCard(
		[
			{ id: "s1", createdAt: now - 5 * 60_000, title: "重构卡片流式" },
			{ id: "s2", createdAt: now - 3 * 86400_000, title: "修复频控" },
		],
		"s2",
		{ now: () => now },
	);
	const buttons = (resumeButtons(card) as Array<{
		text?: { content?: string };
		behaviors?: Array<{ value?: Json }>;
		disabled?: boolean;
	}>).filter((b) => String((b.behaviors?.[0]?.value as { op?: string })?.op ?? "").startsWith("resume:"));
	const rendered = JSON.stringify(card);
	assert.match(rendered, /5 分钟前/);
	assert.match(rendered, /重构卡片流式/);
	assert.match(rendered, /3 天前/);
	assert.match(buttons[1]?.text?.content ?? "", /当前会话/);
	assert.match(rendered, /修复频控/);
	// current session listed but its button disabled
	assert.equal(buttons[1]?.disabled, true, "current session row disabled");
	assert.match(rendered, /当前/);


	const empty = resumeCard([], undefined, { now: () => now });
	assert.match(JSON.stringify(empty), /暂无历史会话/);
});

// ---- command-system cards (help / panel / workspace browser) -----------------

function buttonOps(card: unknown): string[] {
	return collectButtons(card).map(
		(b) => (b.behaviors as Array<{ value: Json }>)[0]!.value.op as string,
	);
}

test("helpCard: keeps the grouped command list and offers a control-panel button", () => {
	const rendered = JSON.stringify(helpCard());
	for (const fragment of ["/status", "/workspace", "/model", "/tasks", "/doctor", "/lark-config", "/manage"]) {
		assert.ok(rendered.includes(fragment), `help 清单应包含 ${fragment}`);
	}
	const ops = buttonOps(helpCard());
	assert.deepEqual(ops, ["menu"], "help 卡应提供且仅提供一个控制面板入口");
});

test("commandPanelCard: covers every command group with one-tap buttons", () => {
	const ops = buttonOps(commandPanelCard());
	for (const expected of [
		"status",
		"manage",
		"new",
		"stop",
		"workspace",
		"files",
		"model",
		"reasoning",
		"mode",
		"permission",
		"doctor",
		"whoami",
		"usage",
		"reconnect",
		"lark-config",
		"stream",
		"lark",
		"help",
	]) {
		assert.ok(ops.includes(expected), `控制面板应含 ${expected} 按钮`);
	}
});

test("workspaceBrowserCard: directory buttons, parent disabled at the root, cancel keeps the workspace", () => {
	const card = workspaceBrowserCard({
		browsePath: "/srv/app",
		workspacePath: "/srv/app",
		parentPath: "/srv",
		entries: [
			{ name: "src", path: "/srv/app/src" },
			{ name: "docs", path: "/srv/app/docs" },
		],
	});
	const ops = buttonOps(card);
	assert.ok(ops.some((op) => op.startsWith("ws:up:")), "上一级应携带父目录");
	assert.ok(ops.includes(`ws:cd:${encodeURIComponent("/srv/app/src")}`));
	assert.ok(ops.some((op) => op.startsWith("ws:pick:")), "切换按钮应携带浏览路径");
	assert.ok(ops.some((op) => op.startsWith("ws:mk:")), "新建按钮应携带浏览路径");
	assert.ok(ops.includes("ws:cancel"));
	const pick = ops.find((op) => op.startsWith("ws:pick:"))!;
	assert.equal(decodeURIComponent(pick.slice("ws:pick:".length)), "/srv/app");
	const rendered = JSON.stringify(card);
	assert.match(rendered, /就是当前工作区/);

	const root = workspaceBrowserCard({
		browsePath: "/",
		workspacePath: "/srv/app",
		entries: [],
	});
	const upButton = collectButtons(root).find(
		(b) => (b.behaviors as Array<{ value: Json }>)[0]!.value.op === "ws:up",
	);
	assert.equal(upButton?.disabled, true, "文件系统根应禁用上一级");
	assert.match(JSON.stringify(root), /没有子目录/);
});

test("workspaceBrowserCard: colon-bearing paths survive the op split via URI encoding", () => {
	const card = workspaceBrowserCard({
		browsePath: "/srv/a:b",
		workspacePath: "/srv/app",
		parentPath: "/srv",
		entries: [{ name: "x:y", path: "/srv/a:b/x:y" }],
	});
	const ops = buttonOps(card);
	const cd = ops.find((op) => op.startsWith("ws:cd:"));
	assert.ok(cd, "应生成目录按钮");
	const encoded = cd!.slice("ws:cd:".length);
	assert.equal(decodeURIComponent(encoded), "/srv/a:b/x:y");
	assert.ok(!encoded.includes(":"), "编码后不应残留裸冒号");
});

test("workspaceNewFolderCard: form input plus a text fallback", () => {
	const card = workspaceNewFolderCard({ parentPath: "/srv/app" }) as Json;
	const elements = (card.body as Json).elements as Json[];
	const form = elements.find((e) => e.tag === "form_container") as Json | undefined;
	assert.ok(form, "应包含 form_container");
	const children = (form!.children ?? []) as Json[];
	const input = children.find((c) => c.tag === "input") as Json | undefined;
	assert.equal(input?.name, "name");
	const onSubmit = (form!.onSubmit ?? []) as Array<{ value: Json }>;
	const submitOp = String(onSubmit[0]?.value?.op ?? "");
	assert.ok(submitOp.startsWith("ws:mk:submit:"), `提交 op 应携带父目录，实际 ${submitOp}`);
	assert.equal(
		decodeURIComponent(submitOp.slice("ws:mk:submit:".length)),
		"/srv/app",
	);
	assert.ok(
		buttonOps(card).some((op) => op.startsWith("ws:back:")),
		"应可返回目录浏览",
	);
	assert.match(JSON.stringify(card), /\/workspace mk/);
});

test("configPanelCard: toggles rewrite single hot-reloadable keys", () => {
	const ops = buttonOps(
		configPanelCard({
			streamingEnabled: true,
			reactionsEnabled: false,
			groupPolicy: "mention",
			agentPreset: "code",
			permissionMode: "danger-full-access",
			allowlist: [],
			denyList: [],
		}),
	);
	assert.ok(ops.includes("cfg:streaming.enabled=true"));
	assert.ok(ops.includes("cfg:streaming.enabled=false"));
	assert.ok(ops.includes("cfg:reactions.enabled=true"));
	assert.ok(ops.includes("cfg:groupPolicy=open"));
	assert.ok(ops.includes("cfg:groupPolicy=mention"));
	assert.ok(ops.includes("mode"));
	assert.ok(ops.includes("permission"));
});

test("larkAdminPanelCard: subcommands are buttons, destructive one is danger-styled", () => {
	const card = larkAdminPanelCard({ connState: "connected", configured: true });
	const ops = buttonOps(card);
	for (const sub of ["start", "stop", "restart", "status", "setup", "uninstall-clean"]) {
		assert.ok(ops.includes(`lark:${sub}`), `应含 lark:${sub}`);
	}
	const danger = collectButtons(card).find(
		(b) => (b.behaviors as Array<{ value: Json }>)[0]!.value.op === "lark:uninstall-clean",
	);
	assert.equal(danger?.type, "danger");
	assert.match(JSON.stringify(card), /已配置/);
});

test("new/stop result cards: schema 2.0, no tag:action container, actionable buttons", () => {
	const cards = [
		newConfirmCard({ workspace: "/srv/app" }),
		stopResultCard({ text: "已停止当前会话任务" }),
	];
	for (const card of cards) assert.equal((card as Json).schema, "2.0");
	assert.deepEqual(buttonOps(cards[0]), ["new:confirm", "new:cancel"]);
	assert.deepEqual(buttonOps(cards[1]), ["status", "new"]);
	let actionCount = 0;
	const walk = (n: unknown): void => {
		if (Array.isArray(n)) return n.forEach(walk);
		if (n && typeof n === "object") {
			const obj = n as Json;
			if (obj.tag === "action") actionCount++;
			Object.values(obj).forEach(walk);
		}
	};
	cards.forEach(walk);
	assert.equal(actionCount, 0, "schema 2.0 卡片不得包含 action 容器");
});

// ---- parallel tasks (/tasks) --------------------------------------------------

test("taskListCard: running first, switch/stop per row, explicit exit", () => {
	const card = taskListCard({
		tasks: [
			{
				taskId: "dm:oc_x#1",
				sessionId: "s1",
				seq: 1,
				title: "老任务",
				status: "idle",
				active: false,
				lastActivityAt: 0,
			},
			{
				taskId: "dm:oc_x#2",
				sessionId: "s2",
				seq: 2,
				title: "在跑",
				status: "running",
				active: true,
				lastActivityAt: 0,
			},
			{
				sessionId: "s3",
				seq: 3,
				title: "历史",
				status: "stopped",
				active: false,
				historical: true,
				lastActivityAt: 0,
			},
		],
		now: () => 0,
	});
	const ops = buttonOps(card);
	const enc = encodeURIComponent;
	// Switch/open buttons appear in the RENDERED order: running task first, then
	// the idle one, then the unclaimed historical session.
	assert.deepEqual(
		ops.filter((op) => op.startsWith("tasks:switch:") || op.startsWith("tasks:open:")),
		[
			`tasks:switch:${enc("dm:oc_x#2")}`,
			`tasks:switch:${enc("dm:oc_x#1")}`,
			`tasks:open:${enc("s3")}`,
		],
	);
	assert.ok(ops.includes(`tasks:stop:${enc("dm:oc_x#2")}`), "运行中的任务可以停止");
	assert.ok(ops.includes("tasks:list"));
	assert.ok(ops.includes("tasks:new"));
	assert.ok(ops.includes("tasks:exit"), "必须带退出按钮");
	assert.equal(
		ops.includes(`tasks:stop:${enc("dm:oc_x#1")}`),
		false,
		"空闲任务不给停止按钮",
	);
	const rendered = JSON.stringify(card);
	assert.ok(rendered.indexOf("在跑") < rendered.indexOf("老任务"), "运行中的排最前");
	assert.ok(rendered.indexOf("老任务") < rendered.indexOf("历史"), "历史会话排最后");
	// A bare historical session has no task id, so it offers no stop button.
	assert.equal(
		ops.some((op) => op.startsWith("tasks:stop:") && op.includes(enc("s3"))),
		false,
	);
});

test("taskBriefingCard: live progress, controls, and no stop button once stopped", () => {
	const running = taskBriefingCard({
		task: {
			taskId: "dm:oc_x#2",
			sessionId: "s2",
			seq: 2,
			title: "长任务",
			status: "running",
			active: true,
			lastActivityAt: 0,
		},
		snapshot: { text: "正在写第 3 段", stage: "answering", streaming: true, settled: false },
		workspace: "/srv/dsh-workspace/abcde",
		preset: "code",
		todos: [
			{ content: "阶段一", status: "completed" },
			{ content: "阶段二", status: "in_progress" },
		],
		now: () => 0,
	});
	const rendered = JSON.stringify(running);
	assert.match(rendered, /运行中/);
	assert.match(rendered, /正在写第 3 段/, "必须带上正在写的输出");
	assert.match(rendered, /阶段二/, "todo 进度也要带上");
	assert.equal(((running as Json).header as Json).template, "green");
	const ops = buttonOps(running);
	assert.ok(ops.includes(`tasks:stop:${encodeURIComponent("dm:oc_x#2")}`));
	assert.ok(ops.includes("tasks:list"));
	assert.ok(ops.includes("tasks:exit"));

	const stopped = taskBriefingCard({
		task: { taskId: "dm:oc_x#1", seq: 1, status: "stopped", active: false, lastActivityAt: 0 },
		now: () => 0,
	});
	assert.equal(
		buttonOps(stopped).some((op) => op.startsWith("tasks:stop:")),
		false,
		"已停止的任务不给停止按钮",
	);
});

// ---- conversation management (/manage) ---------------------------------------

test("resumeCard: no deletion entry any more — that moved to /manage", () => {
	const card = resumeCard([{ id: "session-a", createdAt: 0 }], undefined, { now: () => 0 });
	const ops = buttonOps(card);
	assert.equal(
		ops.some((op) => op.startsWith("resume-delete")),
		false,
		`/resume 不得再有删除按钮：${ops.join(", ")}`,
	);
	assert.ok(ops.some((op) => op.startsWith("resume:")), "恢复按钮必须保留");
	assert.match(JSON.stringify(card), /\/manage/, "应引导到对话管理");
});

test("sessionManageCard: one row per session, alias wins over the derived title, explicit exit", () => {
	const card = sessionManageCard({
		sessions: [
			{ id: "session-a", createdAt: 0, title: "旧标题", alias: "新名字" },
			{ id: "session-b", createdAt: 0, title: "另一个" },
		],
		currentSessionId: "session-b",
		now: () => 0,
	});
	assert.deepEqual(buttonOps(card), [
		"manage:pick:session-a",
		"manage:pick:session-b",
		"manage:list",
		"manage:exit",
	]);
	const rendered = JSON.stringify(card);
	assert.match(rendered, /新名字/, "别名必须覆盖原标题");
	assert.match(rendered, /（当前）/);
	assert.match(
		rendered,
		/退出对话管理/,
		"面板必须带退出按钮",
	);
	const empty = sessionManageCard({ sessions: [], now: () => 0 });
	assert.match(JSON.stringify(empty), /暂无历史会话/);
	assert.ok(buttonOps(empty).includes("manage:exit"));
});

test("sessionManageDetailCard: the CURRENT session can be renamed but not deleted/moved/resumed", () => {
	const session = { id: "session-a", createdAt: 0, title: "T", cwd: "/srv/x" };
	const card = sessionManageDetailCard({ session, currentSessionId: "session-a", now: () => 0 });
	const ops = buttonOps(card);
	for (const expected of [
		"manage:rename:session-a",
		"manage:resume:session-a",
		"manage:move:session-a",
		"manage:delete:session-a",
		"manage:list",
		"manage:exit",
	]) {
		assert.ok(ops.includes(expected), `应有 ${expected}`);
	}
	const disabled = collectButtons(card)
		.filter((b) => b.disabled === true)
		.map((b) => (b.behaviors as Array<{ value: Json }>)[0]!.value.op)
		.sort();
	assert.deepEqual(disabled, [
		"manage:delete:session-a",
		"manage:move:session-a",
		"manage:resume:session-a",
	]);
	// Any other session keeps every action enabled.
	const free = collectButtons(
		sessionManageDetailCard({ session, currentSessionId: "session-other", now: () => 0 }),
	);
	assert.equal(free.some((b) => b.disabled === true), false);
});

test("sessionRenameCard: form submit carries the session id (URI-encoded)", () => {
	const card = sessionRenameCard({ session: { id: "lark-link:dm:oc_x:0", createdAt: 0 } }) as Json;
	const form = ((card.body as Json).elements as Json[]).find(
		(element) => element.tag === "form_container",
	) as Json | undefined;
	assert.ok(form, "重命名必须用表单输入");
	const onSubmit = (form!.onSubmit ?? []) as Array<{ value: Json }>;
	assert.equal(
		onSubmit[0]?.value?.op,
		`manage:rename:submit:${encodeURIComponent("lark-link:dm:oc_x:0")}`,
	);
	const input = ((form!.children ?? []) as Json[]).find((child) => child.tag === "input") as Json;
	assert.equal(input.name, "alias");
	assert.ok(buttonOps(card).some((op) => op.startsWith("manage:pick:")), "应能返回");
});

test("sessionMoveCard: project buttons carry id|target and a path form is offered", () => {
	const card = sessionMoveCard({
		session: { id: "session-a", createdAt: 0, cwd: "/srv/alpha" },
		targets: ["/srv/alpha", "/srv/beta"],
	});
	const ops = buttonOps(card);
	assert.equal(
		ops.includes(`manage:move:to:session-a|${encodeURIComponent("/srv/alpha")}`),
		false,
		"当前项目不作为迁移候选",
	);
	assert.ok(ops.includes(`manage:move:to:session-a|${encodeURIComponent("/srv/beta")}`));
	const elements = ((card as Json).body as Json).elements as Json[];
	const form = elements.find((element) => element.tag === "form_container") as Json | undefined;
	const onSubmit = (form?.onSubmit ?? []) as Array<{ value: Json }>;
	assert.equal(onSubmit[0]?.value?.op, "manage:move:submit:session-a");
	assert.match(JSON.stringify(card), /不会移动工作区里的任何文件/);
});

test("sessionDeleteConfirmCard: danger-styled confirm plus a way back", () => {
	const card = sessionDeleteConfirmCard({
		session: { id: "session-a", createdAt: 0, alias: "重要会话" },
	});
	assert.deepEqual(buttonOps(card), [
		"manage:delete:confirm:session-a",
		"manage:pick:session-a",
	]);
	const danger = collectButtons(card).find(
		(b) =>
			(b.behaviors as Array<{ value: Json }>)[0]!.value.op === "manage:delete:confirm:session-a",
	);
	assert.equal(danger?.type, "danger");
	const rendered = JSON.stringify(card);
	assert.match(rendered, /重要会话/);
	assert.match(rendered, /无法恢复/);
});

test("resumeCard: renders topic, last-progress summary, turn/tool counts", () => {
	const now = Date.now();
	const card = resumeCard([
		{
			id: "s-rich",
			createdAt: now - 60_000,
			lastActivityAt: now - 10_000,
			title: "修复玩家存档系统",
			summary: "读取、写入和回归测试均已完成",
			preset: "standard",
			userTurns: 4,
			toolCalls: 7,
		},
	], undefined, { now: () => now });
	const rendered = JSON.stringify(card);
	assert.match(rendered, /修复玩家存档系统/);
	assert.match(rendered, /读取、写入和回归测试均已完成/);
	assert.match(rendered, /4 轮提问/);
	assert.match(rendered, /7 次工具/);
	assert.match(rendered, /恢复 #1/);
});

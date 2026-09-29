import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommandPanelSync } from "../../../src/outbound/command-panel-sync.ts";

test("command panel: one command creates one live card then collapses it in place", async () => {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const sync = createCommandPanelSync({
		async createCard(payload) {
			calls.push({ method: "create", args: [payload] });
			return { data: { card_id: "card-1" } };
		},
		async deliverCard(cardId, chatId) {
			calls.push({ method: "deliver", args: [cardId, chatId] });
		},
		async updateCard(cardId, body) {
			calls.push({ method: "update", args: [cardId, body] });
		},
	});
	assert.equal(await sync.start("chat-1", "bridge:status:m1", "status"), true);
	assert.equal(await sync.append("chat-1", {
		id: "bridge:status:m1",
		command: "status",
		result: "connected",
	}), true);
	sync.clear();
	assert.deepEqual(calls.map((call) => call.method), ["create", "deliver", "update"]);
	const created = JSON.stringify(calls[0]?.args[0]);
	assert.match(created, /expanded\\\":true/);
	const updated = JSON.stringify(calls[2]?.args[1]);
	assert.match(updated, /expanded\\\":false/);
	assert.match(updated, /connected/);
});

test("command panel: separate commands create separate compactable cards", async () => {
	let cardNo = 0;
	const delivered: string[] = [];
	const sync = createCommandPanelSync({
		async createCard() { cardNo += 1; return { card_id: `card-${cardNo}` }; },
		async deliverCard(cardId) { delivered.push(cardId); },
		async updateCard() {},
	});
	assert.equal(await sync.append("chat-1", { id: "a", command: "status", result: "one" }), true);
	assert.equal(await sync.append("chat-1", { id: "b", command: "model", result: "two" }), true);
	assert.deepEqual(delivered, ["card-1", "card-2"]);
});

test("command panel: interactive card callbacks carry the owning CardKit id", async () => {
	let updated = "";
	const sync = createCommandPanelSync({
		async createCard() { return { card_id: "card-7" }; },
		async deliverCard() {},
		async updateCard(_cardId, body) { updated = body.card.data; },
	});
	await sync.start("chat-1", "bridge:model:m1", "model");
	assert.equal(await sync.showCard("chat-1", "bridge:model:m1", "model", {
		body: { elements: [{ tag: "button", behaviors: [{ type: "callback", value: { op: "model:x" } }] }] },
	}), true);
	sync.clear();
	assert.match(updated, /_panel_card_id/);
	assert.match(updated, /card-7/);
	assert.match(updated, /expanded\":true/);
});

test("command panel: callback-less cards keep their full content (regression: /help lost everything)", async () => {
	let rendered = "";
	const sync = createCommandPanelSync({
		async createCard(payload) {
			rendered = String((payload as { data?: string }).data ?? "");
			return { card_id: "card-help" };
		},
		async deliverCard() {},
		async updateCard(_cardId, body) { rendered = body.card.data; },
	});
	await sync.start("chat-1", "bridge:help:m1", "help");
	assert.equal(await sync.showCard("chat-1", "bridge:help:m1", "help", {
		schema: "2.0",
		body: {
			elements: [{
				tag: "markdown",
				content: "**可用命令**\n- /status 桥接状态\n- /mode 切换模式",
			}],
		},
	}), true);
	sync.clear();
	assert.match(rendered, /可用命令/);
	assert.match(rendered, /\/status 桥接状态/);
	assert.doesNotMatch(rendered, /操作已完成/);
});

test("command panel: multi-line command output is not flattened or clipped", async () => {
	let rendered = "";
	const sync = createCommandPanelSync({
		async createCard(payload) {
			rendered = String((payload as { data?: string }).data ?? "");
			return { card_id: "card-status" };
		},
		async deliverCard() {},
		async updateCard(_cardId, body) { rendered = body.card.data; },
	});
	await sync.start("chat-1", "bridge:status:m2", "status");
	const body = ["状态: connected", "WS 就绪: true", "outbox 待发: 0", "活跃会话: 2"].join("\n");
	assert.equal(await sync.append("chat-1", {
		id: "bridge:status:m2",
		command: "status",
		result: body,
	}), true);
	sync.clear();
	assert.match(rendered, /WS 就绪: true/);
	assert.match(rendered, /活跃会话: 2/);
});

test("command panel: oversized bodies fall back to the durable text channel", async () => {
	let rendered = "";
	const sync = createCommandPanelSync({
		async createCard(payload) {
			rendered = String((payload as { data?: string }).data ?? "");
			return { card_id: "card-big" };
		},
		async deliverCard() {},
		async updateCard(_cardId, body) { rendered = body.card.data; },
	});
	await sync.start("chat-1", "bridge:doctor:m3", "doctor");
	const huge = `BEGIN${"x".repeat(5000)}`;
	assert.equal(await sync.append("chat-1", {
		id: "bridge:doctor:m3",
		command: "doctor",
		result: huge,
	}), false, "超长正文必须回退到文本通道（返回 false）");
	sync.clear();
	assert.match(rendered, /单独发送/);
	assert.ok(!rendered.includes("BEGIN"), "超长正文不应被塞进面板卡片");
});

test("command panel: adopting a card keeps its sequence monotonic (regression: button click did nothing)", async () => {
	const sequences: number[] = [];
	const sync = createCommandPanelSync({
		async createCard() { return { card_id: "card-1" }; },
		async deliverCard() {},
		async updateCard(_cardId, body) { sequences.push(body.sequence); },
	});
	// /help renders into card-1 (first update → sequence 1).
	await sync.start("chat-1", "bridge:help:m1", "help");
	await sync.showCard("chat-1", "bridge:help:m1", "help", {
		body: { elements: [{ tag: "markdown", content: "help" }] },
	});
	// Clicking a button on that panel adopts the SAME card into a new command
	// state; CardKit silently discards a non-newer sequence, so the counter must
	// continue instead of restarting at 1.
	sync.adopt("chat-1", "bridge:menu:m1#menu", "card-1", "menu");
	await sync.showCard("chat-1", "bridge:menu:m1#menu", "menu", {
		body: { elements: [{ tag: "markdown", content: "menu" }] },
	});
	sync.clear();
	assert.equal(sequences.length, 2, `应有两次更新，实际 ${sequences.join(",")}`);
	assert.ok(
		sequences[1]! > sequences[0]!,
		`adopt 后必须发送更大的 sequence，实际 ${sequences.join(",")}`,
	);
});

test("command panel: CardKit business errors surface instead of looking like success", async () => {
	const sync = createCommandPanelSync({
		async createCard() { return { card_id: "card-bad" }; },
		async deliverCard() {},
		async updateCard() { return { code: 200861, msg: "unknown property" }; },
	});
	await sync.start("chat-1", "bridge:status:m5", "status");
	const ok = await sync.append("chat-1", {
		id: "bridge:status:m5",
		command: "status",
		result: "内容",
	});
	sync.clear();
	assert.equal(ok, false, "业务错误码必须让 append 返回 false，以便回退到文本通道");
});

test("command panel: failed entries render the red failure shell", async () => {
	let rendered = "";
	const sync = createCommandPanelSync({
		async createCard(payload) {
			rendered = String((payload as { data?: string }).data ?? "");
			return { card_id: "card-err" };
		},
		async deliverCard() {},
		async updateCard(_cardId, body) { rendered = body.card.data; },
	});
	await sync.start("chat-1", "bridge:workspace:m4", "workspace");
	assert.equal(await sync.append("chat-1", {
		id: "bridge:workspace:m4",
		command: "workspace",
		result: "目录不存在: /nope",
		status: "error",
	}), true);
	sync.clear();
	assert.match(rendered, /"red"/);
	assert.match(rendered, /目录不存在/);
});

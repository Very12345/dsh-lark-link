import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUserUsageStore } from "../../../src/application/user-usage.ts";

test("user usage: private chat counters are isolated by session key", () => {
	const file = join(mkdtempSync(join(tmpdir(), "lark-usage-")), "usage.json");
	let now = 100;
	const store = createUserUsageStore(file, () => now++);
	const message = (chatId: string, senderOpenId: string) => ({
		messageId: `m-${chatId}`,
		chatId,
		chatType: "p2p" as const,
		chatMode: "p2p" as const,
		senderOpenId,
		msgType: "text" as const,
		content: "{}",
		text: "hello",
		mentions: [],
		timestamp: now,
	});
	store.recordInbound("dm:chat-a", message("chat-a", "ou_a"));
	store.recordInbound("dm:chat-a", message("chat-a", "ou_a"));
	store.recordInbound("dm:chat-b", message("chat-b", "ou_b"));
	assert.deepEqual(
		store.list().map((x) => [x.sessionKey, x.inboundMessages]),
		[
			["dm:chat-b", 1],
			["dm:chat-a", 2],
		],
	);
	store.clear();
	assert.deepEqual(store.list(), []);
});

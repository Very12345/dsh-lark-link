import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRouteStore } from "../../../src/outbound/outbound-router.ts";
import { createConversationConfigStore } from "../../../src/sessions/conversation-config.ts";
import { createDedupeStore } from "../../../src/common/dedupe-store.ts";
import { createInboundWal } from "../../../src/inbound/inbound-wal.ts";
import { createUserUsageStore } from "../../../src/application/user-usage.ts";

test("app switch state: old bot routes, sessions, dedupe, WAL and usage clear together", () => {
	const dir = mkdtempSync(join(tmpdir(), "lark-app-switch-"));
	const routes = createRouteStore(join(dir, "routes.json"), () => 10);
	const conversations = createConversationConfigStore(join(dir, "conversations.json"));
	const dedupe = createDedupeStore(join(dir, "dedupe.json"), () => 10);
	const wal = createInboundWal({ dir: join(dir, "wal"), now: () => 10 });
	const usage = createUserUsageStore(join(dir, "usage.json"), () => 10);
	routes.upsert({
		sessionKey: "dm:old",
		chatId: "oc_old",
		chatType: "p2p",
		senderOpenId: "ou_old",
		updatedAt: 10,
	});
	conversations.set("dm:old", { activeSessionId: "session-old" });
	dedupe.add("message-old");
	wal.accept({
		messageId: "message-old",
		sessionKey: "dm:old",
		chatId: "oc_old",
		chatType: "p2p",
		senderOpenId: "ou_old",
		text: "old request",
	});
	usage.recordInbound("dm:old", {
		messageId: "message-old",
		chatId: "oc_old",
		chatType: "p2p",
		chatMode: "p2p",
		senderOpenId: "ou_old",
		msgType: "text",
		content: "{}",
		text: "old request",
		mentions: [],
		timestamp: 10,
	});

	routes.clear();
	conversations.clearAll();
	dedupe.clear();
	wal.clear();
	usage.clear();

	assert.deepEqual(routes.all(), []);
	assert.deepEqual(conversations.keys(), []);
	assert.equal(dedupe.seen("message-old"), false);
	assert.equal(wal.pendingCount(), 0);
	assert.deepEqual(usage.list(), []);
});

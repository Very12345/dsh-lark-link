import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	conversationKeyForSessionId,
	conversationKeyOf,
	createMemoryTaskRegistry,
	createTaskRegistry,
	taskSeqOf,
} from "../../../src/sessions/task-registry.ts";

test("task-registry: session ids peel down to the conversation key", () => {
	// Live shape is `lark-link:<taskKey>:<nonce>:<index>` — and the old inline
	// fallback could not parse it, so tool calls died with "无法定位当前飞书会话".
	assert.equal(conversationKeyForSessionId("lark-link:dm:oc_x#5:mu5kljazwrmw:1"), "dm:oc_x");
	assert.equal(
		conversationKeyForSessionId("lark-link:group:oc_g#18:mu6s2970vljy:0"),
		"group:oc_g",
	);
	// No index (older builds), then no nonce at all, then a bare task key.
	assert.equal(conversationKeyForSessionId("lark-link:dm:oc_x#5:mu5kljazwrmw"), "dm:oc_x");
	assert.equal(conversationKeyForSessionId("lark-link:dm:oc_x#5"), "dm:oc_x");
	assert.equal(conversationKeyForSessionId("dm:oc_x#5"), "dm:oc_x");
	// A chat id (underscore in `oc_…`) must never be mistaken for a nonce.
	assert.equal(
		conversationKeyForSessionId("lark-link:dm:oc_0683ce5398f608ba04700ea2cf04512e"),
		"dm:oc_0683ce5398f608ba04700ea2cf04512e",
	);
	assert.equal(conversationKeyForSessionId("p2p:oc_z"), "p2p:oc_z");
	// Non-Feishu sessions pass through unchanged; no route will match them.
	assert.equal(conversationKeyForSessionId("gui-session-1"), "gui-session-1");
});

test("task-registry: ids carry the conversation, and the newest task is active", () => {
	const registry = createMemoryTaskRegistry(() => 1_000);
	const key = "dm:oc_x";
	const first = registry.ensureActive(key);
	assert.equal(first.id, "dm:oc_x#1");
	assert.equal(first.seq, 1);
	assert.equal(registry.ensureActive(key).id, first.id, "重复调用不会新建任务");

	const second = registry.create(key, { fromTaskId: first.id });
	assert.equal(second.id, "dm:oc_x#2");
	assert.equal(registry.active(key)?.id, second.id, "新建任务立即成为当前任务");
	assert.deepEqual(
		registry.list(key).map((task) => task.seq),
		[2, 1],
		"列表按新→旧返回",
	);
	assert.equal(second.fromTaskId, first.id);
	assert.deepEqual(registry.list("dm:other"), [], "任务按会话隔离");
});

test("task-registry: switching, touching and dropping behave", () => {
	let clock = 100;
	const registry = createMemoryTaskRegistry(() => clock);
	const key = "dm:oc_x";
	const a = registry.create(key);
	const b = registry.create(key);
	assert.equal(registry.active(key)?.id, b.id);

	assert.equal(registry.switchTo(key, a.id)?.id, a.id);
	assert.equal(registry.active(key)?.id, a.id);
	clock = 200;
	registry.touch(key, a.id);
	assert.equal(registry.list(key).find((t) => t.id === a.id)?.lastActivityAt, 200);

	// Dropping the ACTIVE task falls back to the remaining one.
	registry.remove(key, a.id);
	assert.equal(registry.active(key)?.id, b.id);
	assert.equal(registry.list(key).length, 1);
});

test("task-registry: session ids are recorded per task, and the id helpers agree", () => {
	const registry = createMemoryTaskRegistry();
	const key = "group:oc_g";
	const task = registry.create(key, { label: "长任务" });
	assert.equal(task.label, "长任务");
	registry.setSessionId(key, task.id, "lark-link:group:oc_g:nonce:0");
	assert.equal(registry.list(key)[0]?.sessionId, "lark-link:group:oc_g:nonce:0");
	registry.setLabel(key, task.id, "改名后");
	assert.equal(registry.list(key)[0]?.label, "改名后");
	registry.setSessionId(key, task.id, undefined);
	assert.equal(registry.list(key)[0]?.sessionId, undefined);

	assert.equal(conversationKeyOf(task.id), key);
	assert.equal(conversationKeyOf(key), key, "没有 #n 时原样返回");
	assert.equal(taskSeqOf(task.id), 1);
	assert.equal(taskSeqOf(key), 0);
});

test("task-registry: persists across instances and keeps the owner identity", () => {
	const dir = mkdtempSync(join(tmpdir(), "tasks-"));
	try {
		const file = join(dir, "tasks.json");
		const first = createTaskRegistry(file, () => 5_000);
		first.setOwner("dm:oc_x", "ou_user", "小飞");
		const a = first.create("dm:oc_x");
		first.setSessionId("dm:oc_x", a.id, "session-1");
		const b = first.create("dm:oc_x");

		const reloaded = createTaskRegistry(file, () => 6_000);
		assert.equal(reloaded.active("dm:oc_x")?.id, b.id);
		assert.equal(reloaded.list("dm:oc_x").length, 2);
		assert.equal(
			reloaded.list("dm:oc_x").find((task) => task.id === a.id)?.sessionId,
			"session-1",
		);
		assert.deepEqual(reloaded.owner("dm:oc_x"), { id: "ou_user", name: "小飞" });
		assert.deepEqual(reloaded.conversations(), ["dm:oc_x"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createConversationManager } from "../../../src/sessions/conversation-manager.ts";
import { createMemoryDshBackend } from "../../../src/sessions/dsh-session-backend.ts";
import { createMemoryTaskRegistry } from "../../../src/sessions/task-registry.ts";
import type { FeishuInboundMessage } from "../../../src/common/types.ts";

const mkMsg = (text: string, messageId = "m1"): FeishuInboundMessage => ({
	messageId,
	chatId: "oc_x",
	chatType: "p2p",
	chatMode: "p2p",
	senderOpenId: "ou_user",
	msgType: "text",
	content: text,
	text,
	mentions: [],
	timestamp: Date.now(),
});

function makeManager(opts: { latencyMs?: number } = {}) {
	const backend = createMemoryDshBackend({
		autoReply: (key, text) => `${key}:${text}`,
		...(opts.latencyMs ? { latencyMs: opts.latencyMs } : {}),
	});
	const registry = createMemoryTaskRegistry();
	const events: Array<{ key: string; type: string }> = [];
	const active: Array<{ key: string; sessionId: string | undefined }> = [];
	const manager = createConversationManager({
		backend,
		registry,
		maxSessions: 8,
		idleTtlMs: 60_000,
		onEvent: (key, event) => events.push({ key, type: event.type }),
		onActiveSessionId: (key, sessionId) => active.push({ key, sessionId }),
	});
	return { backend, registry, manager, events, active };
}

test("tasks: /new opens a PARALLEL task instead of discarding the previous one", async () => {
	const { backend, manager, events } = makeManager();
	await manager.handleMessage(mkMsg("first"));
	const first = manager.activeTask("dm:oc_x")!;
	assert.equal(first.seq, 1);
	assert.ok(first.sessionId, "第一条消息立刻得到一个会话");

	// The second task is a NEW agent: the first one keeps its agent AND session.
	const second = manager.createTask("dm:oc_x");
	assert.equal(second.seq, 2);
	assert.equal(manager.activeTask("dm:oc_x")?.id, second.id);
	await manager.handleMessage(mkMsg("second", "m2"));

	assert.equal(manager.tasks("dm:oc_x").length, 2);
	assert.ok(backend.get(first.id), "第一个任务的 agent 仍然活着");
	assert.ok(backend.get(second.id), "第二个任务有自己的 agent");
	assert.notEqual(
		backend.get(first.id)?.sessionId,
		backend.get(second.id)?.sessionId,
		"两个任务各自的会话 id 不同",
	);
	assert.ok(events.some((e) => e.key === first.id), "第一个任务的事件以自己的键送出");
	assert.ok(events.some((e) => e.key === second.id), "第二个任务的事件以自己的键送出");
});

test("tasks: switching re-targets new messages and resumes the task's own session", async () => {
	const { backend, manager, events } = makeManager();
	await manager.handleMessage(mkMsg("first"));
	const first = manager.activeTask("dm:oc_x")!;
	manager.createTask("dm:oc_x");
	await manager.handleMessage(mkMsg("second", "m2"));

	const before = events.length;
	const switched = await manager.switchTask("dm:oc_x", first.id);
	assert.equal(switched.task.id, first.id);
	assert.equal(switched.running, false, "空闲任务切换后不是运行中");
	assert.equal(manager.activeTask("dm:oc_x")?.id, first.id);
	assert.equal(backend.get(first.id)?.sessionId, first.sessionId, "会话没有被换掉");

	await manager.handleMessage(mkMsg("third", "m3"));
	assert.equal(
		events.slice(before).some((e) => e.key === first.id),
		true,
		"切换后事件回到第一个任务",
	);
});

test("tasks: statusOf reports running during a turn and idle afterwards", async () => {
	const { manager } = makeManager({ latencyMs: 60 });
	const task = manager.createTask("dm:oc_x");
	void manager.handleMessage(mkMsg("go"));
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(manager.statusOf(task.id), "running", "回合进行中");
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(manager.statusOf(task.id), "idle", "回合结束后空闲");
	assert.equal(manager.statusOf("dm:oc_x#999"), "stopped", "未托管的任务是 stopped");
});

test("tasks: resumeTask binds a historical session to a task (and reuses its task)", async () => {
	const { backend, manager } = makeManager();
	const created = await manager.resumeTask("dm:oc_x", "lark-link:dm:oc_x:old:0");
	assert.equal(created.task.sessionId, "lark-link:dm:oc_x:old:0");
	assert.equal(created.agent.sessionId, "lark-link:dm:oc_x:old:0");

	// Resuming the SAME session again must not spawn a second agent on that log.
	const again = await manager.resumeTask("dm:oc_x", "lark-link:dm:oc_x:old:0");
	assert.equal(again.task.id, created.task.id, "复用已有任务");
	assert.equal(manager.tasks("dm:oc_x").length, 1);
	assert.ok(backend.get(again.task.id));
});

test("tasks: stopTask only cancels the task it names", async () => {
	const { backend, manager } = makeManager({ latencyMs: 80 });
	const a = manager.createTask("dm:oc_x");
	void manager.handleMessage(mkMsg("slow", "m-slow"));
	await new Promise((r) => setTimeout(r, 20));
	const b = manager.createTask("dm:oc_x");
	void manager.handleMessage(mkMsg("slow2", "m-slow2"));
	await new Promise((r) => setTimeout(r, 20));

	await manager.stopTask("dm:oc_x", b.id);
	assert.equal(manager.statusOf(b.id), "idle", "被停止的任务结束当前轮");
	assert.equal(
		manager.statusOf(a.id),
		"running",
		"其他任务不受影响（这正是并行任务的意义）",
	);
	assert.ok(backend.get(a.id), "a 的 agent 仍在");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventForwarder, type StreamTarget } from "../../../src/outbound/event-forwarder.ts";
import { createOutbox, type Outbox, type OutboxSender } from "../../../src/outbound/outbox.ts";
import { tempDir } from "../../../src/common/dedupe-store.ts";
import type { Route, RouteRef, TokenTotals } from "../../../src/common/types.ts";
import type { CardKitStreamHandle } from "../../../src/outbound/cardkit-stream.ts";

const route: Route = { sessionKey: "dm:ou_x", chatId: "oc_x", chatType: "p2p", updatedAt: 0 };
const routeRef: RouteRef = { sessionKey: "dm:ou_x", chatId: "oc_x", chatType: "p2p" };

function makeForwarder(opts: { streaming?: boolean; failStream?: boolean; finalizeThrows?: boolean } = {}) {
  const sent: unknown[] = [];
  const sender: OutboxSender = {
    async deliver(_env, payload) {
      sent.push(payload);
      return { ok: true };
    },
  };
  const outbox: Outbox = createOutbox({
    dir: tempDir("fw-"),
    sender,
    cfg: { maxAttempts: 5, backoffMaxMs: 100, retainDays: 7, pendingCap: 1000, blobThreshold: 24_000 },
  });
  outbox.rebuildFromDisk();
  outbox.start();

  const streamPatches: string[] = [];
  const streamStatuses: string[] = [];
  const streamPhases: Array<string | undefined> = [];
  const streamCounted: string[] = [];
  const streamReasoning: string[] = [];
  const streamTools: string[] = [];
  const streamUsage: Array<{ turn: TokenTotals; session: TokenTotals }> = [];
  const finalized: string[] = [];
  let doneCount = 0;
  let errorCount = 0;
  const fakeStream: CardKitStreamHandle = {
    cardId: "card-1",
    disposed: false,
    async status(t: string, opts?: { phase?: string }) {
      streamStatuses.push(t);
      streamPhases.push(opts?.phase);
    },
    async usage(totals: { turn: TokenTotals; session: TokenTotals }) {
      streamUsage.push(totals);
    },
    countGenerated(text: string) {
      streamCounted.push(text);
    },
    async reasoning(t: string) {
      streamReasoning.push(t);
    },
    async tool(t: string) {
      streamTools.push(t);
    },
    async image() {},
    async patch(t: string) {
      streamPatches.push(t);
    },
    async finalize(t: string) {
      finalized.push(t);
      if (opts.finalizeThrows) throw new Error("finalize down");
      return "card-1";
    },
  };
  const streamTarget: StreamTarget = {
    route: routeRef,
    ensureStream() {
      return opts.failStream ? undefined : fakeStream;
    },
    async fallbackText(text) {
      await outbox.enqueue({ dedupeKey: `fb:${Date.now()}`, laneKey: "dm:ou_x", route: routeRef, kind: "final", payload: { kind: "text", text } });
    },
    async markDone() {
      doneCount++;
    },
    async markError() {
      errorCount++;
    },
  };

  const warnings: string[] = [];
  const fw = createEventForwarder({
    outbox,
    routeFor: (key) => (key === "dm:ou_x" ? route : undefined),
    streamFor: () => streamTarget,
    cfg: () => ({ streamingEnabled: opts.streaming ?? true }),
    warn: (message) => warnings.push(message),
  });

  return { fw, outbox, sent, streamPatches, streamStatuses, streamPhases, streamCounted, streamReasoning, streamTools, streamUsage, warnings, finalized, doneCount: () => doneCount, errorCount: () => errorCount };
}

test("forwarder: a TASK key with no route is REPORTED, never dropped silently", async () => {
	// Regression: the manager emits task keys (`dm:ou_x#2`) while routes are keyed
	// by conversation, so a missing task→conversation mapping made every event
	// vanish — the bot simply never answered and nothing was logged.
	const { fw, warnings } = makeForwarder();
	await fw.onSessionEvent("dm:ou_x#2", { type: "assistant/message", text: "你好" });
	assert.equal(warnings.length, 1, `缺路由必须告警，实际 ${warnings.length}`);
	assert.match(warnings[0]!, /dm:ou_x#2/);
	// The conversation key itself stays silent (normal path).
	await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "你好" });
	assert.equal(warnings.length, 1, "正常路由不得告警");
});

test("forwarder: real usage accumulates per turn and per session, and a new turn only resets the turn total", async () => {
  const { fw, streamUsage } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  // Step 1 requests tools — its usage must NOT be swallowed by the early return.
  await fw.onSessionEvent("dm:ou_x", {
    type: "assistant/message",
    text: "",
    hasToolCalls: true,
    usage: {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
      totalTokens: 1600,
    },
  });
  // Step 2 is the answer step: no totalTokens, so it is derived (prompt + output).
  await fw.onSessionEvent("dm:ou_x", {
    type: "assistant/message",
    text: "完成",
    usage: { inputTokens: 2000, outputTokens: 200 },
  });
  let last = streamUsage.at(-1)!;
  assert.equal(last.turn.tokens, 1600 + 2200, `本回合应累计两步的真实用量，实际 ${last.turn.tokens}`);
  assert.equal(last.session.tokens, 3800, "会话累计等于本回合（首个回合）");
  assert.equal(last.turn.prompt, 1500 + 2000, "prompt = 未缓存输入 + 缓存读 + 缓存写");
  assert.equal(last.turn.cacheRead, 400);

  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "completed" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  last = streamUsage.at(-1)!;
  assert.equal(last.turn.tokens, 0, "新回合必须清零本回合用量");
  assert.equal(last.session.tokens, 3800, "会话累计必须跨回合保留（对齐 DSH 底部口径）");

  await fw.onSessionEvent("dm:ou_x", {
    type: "assistant/message",
    text: "第二回合",
    usage: { inputTokens: 500, outputTokens: 50 },
  });
  last = streamUsage.at(-1)!;
  assert.equal(last.turn.tokens, 550);
  assert.equal(last.session.tokens, 4350);
});

test("forwarder: a step without usage leaves both totals untouched (no phantom zeros)", async () => {
  const { fw, streamUsage } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  await fw.onSessionEvent("dm:ou_x", {
    type: "assistant/message",
    text: "应答",
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  const before = streamUsage.at(-1)!.session.tokens;
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "无用量步骤" });
  assert.equal(streamUsage.at(-1)!.session.tokens, before, "缺 usage 的步骤不得改动累计");
});

test("forwarder: one stream card tracks thinking, tools, output and completion", async () => {
  const { fw, streamStatuses, streamPhases, streamCounted, streamPatches, streamReasoning, streamTools, finalized, doneCount } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/reasoning", text: "先读取文件" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "", reasoning: "先读取文件", hasToolCalls: true });
  await fw.onSessionEvent("dm:ou_x", { type: "tool/call", name: "read", callId: "call-1", arguments: '{"file_path":"package.json","api_token":"secret"}' });
  await fw.onSessionEvent("dm:ou_x", { type: "tool/result", name: "tool-result", callId: "call-1", output: "package loaded" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/reasoning", text: "根据结果继续" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "", reasoning: "根据结果继续", hasToolCalls: true });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "答案" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "答案完成" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "completed" });
  // The header names the ACTUAL phase — 思考中 / 生成中 / 工具执行中 are three
  // different things — and never a tool name or the old "工具调用成功" wording.
  assert.match(streamStatuses[0]!, /思考中/);
  assert.ok(streamStatuses.some((status) => /生成中/.test(status)), "正文流式应有生成中");
  assert.ok(
    streamStatuses.some((status) => /工具执行中/.test(status)),
    "工具运行应有工具执行中",
  );
  assert.match(streamStatuses.at(-1)!, /对话结束/);
  assert.ok(
    !streamStatuses.some((status) => /read|bash|工具调用成功|思考成功|正在调用/.test(status)),
    `状态行不得出现具体工具名或旧文案：${streamStatuses.join(" | ")}`,
  );
  // The PHASE drives the token-rate display: tool execution and the settled turn
  // must be declared as such, and the tool's argument block is model output.
  assert.ok(
    streamPhases.filter((phase) => phase === "thinking").length >= 2,
    `应有思考阶段，实际 ${streamPhases.join(",")}`,
  );
  assert.ok(streamPhases.includes("generating"), "应有生成阶段");
  assert.ok(streamPhases.includes("tool"), "工具执行必须显式声明");
  assert.equal(streamPhases.at(-1), "done", "结束必须显式声明");
  assert.ok(
    streamCounted.some((text) => text.includes("package.json")),
    "工具调用参数应计入本次生成量",
  );
  assert.deepEqual(streamReasoning, ["先读取文件", "根据结果继续"]);
  assert.ok(streamTools.some((line) => /调用.*read/.test(line)));
  assert.ok(streamTools.some((line) => /file_path.*package\.json/s.test(line)));
  assert.ok(streamTools.some((line) => /api_token.*已脱敏/s.test(line)));
  assert.ok(streamTools.some((line) => /read.*成功/.test(line)));
  assert.ok(streamTools.some((line) => /package loaded/.test(line)));
  assert.deepEqual(streamPatches, ["答案", "答案完成", "答案完成"]);
  assert.deepEqual(finalized, ["答案完成"]);
  assert.equal(doneCount(), 1);
});

test("forwarder: silent failure finalizes the same card with a diagnosis", async () => {
  const { fw, streamStatuses, finalized, doneCount, errorCount } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  await fw.onSessionEvent("dm:ou_x", {
    type: "turn/end",
    reason: "error",
    error: { code: "provider_tool_protocol_invalid", message: "missing file_path" },
  });
  assert.match(streamStatuses.at(-1)!, /对话异常结束/);
  assert.match(streamStatuses.at(-1)!, /missing file_path/);
  assert.deepEqual(finalized, [""]);
  assert.equal(doneCount(), 0);
  // State-mapped receipt: a FAILED turn must be stamped ERROR, never DONE —
  // a failure is not a completion, and the reaction is the statement.
  assert.equal(errorCount(), 1);
});

test("forwarder: assistant/message settles the final text on the stream card", async () => {
  const { fw, finalized } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "hel" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "lo" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "hello" });
  assert.deepEqual(finalized, [], "output success is not the end of the Agent turn");
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "completed" });
  assert.deepEqual(finalized, ["hello"]);
});

test("forwarder: finalize failure falls through to the durable outbox (no content loss)", async () => {
  const { fw, sent } = makeForwarder({ finalizeThrows: true });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "durable content" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "completed" });
  await new Promise((r) => setTimeout(r, 200)); // let the outbox drain
  const texts = sent.filter((p) => (p as { kind: string }).kind === "text" && (p as { text: string }).text === "durable content");
  assert.equal(texts.length, 1, "finalize failure fell back to a durable text delivery");
});

test("forwarder: turn/end marks done (real output) but does NOT re-send final (pi bdbc0a2)", async () => {
  const { fw, sent, doneCount } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "hello" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(doneCount(), 1, "DONE issued for real output");
  const texts = sent.filter((p) => (p as { kind: string }).kind === "text");
  assert.equal(texts.length, 1, "exactly one delivery — no duplicate on turn/end");
});

test("forwarder: empty output becomes an explicit status, no DONE", async () => {
  const { fw, sent, doneCount } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 1, "empty output is observable instead of silent");
  assert.match((sent[0] as { text: string }).text, /无输出/);
  assert.equal(doneCount(), 0, "no DONE for empty output");
});

test("forwarder: 'No response.' becomes an explicit empty status", async () => {
  const { fw, sent, doneCount } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "No response." });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 1);
  assert.match((sent[0] as { text: string }).text, /无输出/);
  assert.equal(doneCount(), 0);
});

test("forwarder: each assistant/message is delivered as one message (多轮逐条发, 默认非流式)", async () => {
  const { fw, sent, outbox } = makeForwarder({ streaming: false });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "first" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "second" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete" });
  await new Promise((r) => setTimeout(r, 200));
  const texts = sent.filter((p) => (p as { kind: string }).kind === "text");
  assert.equal(texts.length, 2, "two rounds → two messages");
  assert.equal(outbox.pendingCount(), 0, "all delivered");
});

test("forwarder: streaming disabled => final goes through outbox only", async () => {
  const { fw, sent, finalized } = makeForwarder({ streaming: false });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "hello" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "hello" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(finalized.length, 0, "no stream card");
  assert.ok(sent.length >= 1, "outbox final delivered");
});

test("forwarder: session without route is ignored", async () => {
  const { fw, sent } = makeForwarder();
  await fw.onSessionEvent("other-session", { type: "assistant/message", text: "nope" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 0);
});

// ---- GH #9: turn/end 兜底 (rescue) ---------------------------------------
// The bridge lost an agent's completed reply because delivery relied on a
// single path: assistant/message → outbox.enqueue. If that one event is lost
// (plugin reload mid-turn, an enqueue throw, a route arriving late), turn/end
// used to do nothing and the user never got a reply. turn/end now carries the
// turn's final assistant text (finalText) and the forwarder enqueues it
// durably whenever nothing was delivered this turn.

test("forwarder: turn/end rescue enqueues finalText when no assistant/message was delivered (GH #9)", async () => {
  const { fw, sent, doneCount } = makeForwarder({ streaming: false });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/start" });
  // No assistant/message reached the forwarder (event lost / reload mid-turn).
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete", finalText: "skill installed" });
  await new Promise((r) => setTimeout(r, 200));
  const texts = sent.filter((p) => (p as { kind: string }).kind === "text");
  assert.equal(
    texts.some((t) => (t as { text: string }).text === "skill installed"),
    true,
    "turn/end rescue must durably deliver the final text",
  );
  assert.equal(doneCount(), 1, "rescued output still issues DONE");
});

test("forwarder: turn/end rescue does not duplicate an already-delivered assistant/message", async () => {
  const { fw, sent } = makeForwarder({ streaming: false });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "hello" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete", finalText: "hello" });
  await new Promise((r) => setTimeout(r, 200));
  const texts = sent.filter((p) => (p as { kind: string }).kind === "text" && (p as { text: string }).text === "hello");
  assert.equal(texts.length, 1, "exactly one delivery — rescue must not double-send");
});

test("forwarder: turn/end rescue skips empty and 'No response.' finals (no DONE)", async () => {
  const { fw, sent, doneCount } = makeForwarder({ streaming: false });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete", finalText: "" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete", finalText: "No response." });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 0, "nothing rescued for empty finals");
  assert.equal(doneCount(), 0, "no DONE without real output");
});

test("forwarder: turn/end rescue marks the triggering request delivered (independent confirmation path)", async () => {
  const deliveredKeys: string[] = [];
  const sender: OutboxSender = { async deliver() { return { ok: true }; } };
  const outbox: Outbox = createOutbox({
    dir: tempDir("fw-rescue-deliv-"),
    sender,
    cfg: { maxAttempts: 5, backoffMaxMs: 100, retainDays: 7, pendingCap: 1000, blobThreshold: 24_000 },
  });
  outbox.rebuildFromDisk();
  outbox.start();
  const fw = createEventForwarder({
    outbox,
    routeFor: (key) => (key === "dm:ou_x" ? route : undefined),
    streamFor: () => undefined,
    cfg: () => ({ streamingEnabled: false }),
    onDelivered: (key) => {
      deliveredKeys.push(key);
      return "m-rescued";
    },
  });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete", finalText: "late rescue" });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(deliveredKeys, ["dm:ou_x"], "rescue is a second, independent delivered path (GH #9)");
});

test("forwarder: finalizeSession flushes pending stream-only text", async () => {
  const { fw, sent } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "pending text" });
  await fw.finalizeSession("dm:ou_x");
  await new Promise((r) => setTimeout(r, 200));
  const texts = sent.filter((p) => (p as { kind: string }).kind === "text");
  assert.ok(texts.some((t) => (t as { text: string }).text === "pending text"));
});

test("forwarder: stream handle disposed mid-turn falls through to outbox for final delivery", async () => {
  const sent: unknown[] = [];
  const sender: OutboxSender = {
    async deliver(_env, payload) {
      sent.push(payload);
      return { ok: true };
    },
  };
  const outbox: Outbox = createOutbox({
    dir: tempDir("fw-disposed-"),
    sender,
    cfg: { maxAttempts: 5, backoffMaxMs: 100, retainDays: 7, pendingCap: 1000, blobThreshold: 24_000 },
  });
  outbox.rebuildFromDisk();
  outbox.start();

  const fakeStream: CardKitStreamHandle = {
    cardId: "",
    disposed: true, // e.g. createCard threw 400 on the first chunk
    async status() {},
    async usage() {},
    countGenerated() {},
    async reasoning() {},
    async tool() {},
    async image() {},
    async patch() {},
    async finalize() {
      throw new Error("Stream handle was disposed");
    },
  };
  const fw = createEventForwarder({
    outbox,
    routeFor: (key) => (key === "dm:ou_x" ? route : undefined),
    streamFor: () => ({
      route: routeRef,
      ensureStream: () => fakeStream,
      fallbackText: async () => {},
      markDone: async () => {},
      markError: async () => {},
    }),
    cfg: () => ({ streamingEnabled: true }),
  });

  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "chunk" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "hello fallback" });
  await new Promise((r) => setTimeout(r, 200));
  const texts = sent.filter((p) => (p as { kind: string }).kind === "text" && (p as { text: string }).text === "hello fallback");
  assert.equal(texts.length, 1, "disposed stream card must fall back to durable outbox");
});

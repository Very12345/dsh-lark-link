import { test } from "node:test";
import assert from "node:assert/strict";
import { createCardKitStream, CARD_SCHEMA, STREAM_ELEMENT_ID, STATUS_ELEMENT_ID, REASONING_ELEMENT_ID, TOOL_ELEMENT_ID } from "../../../src/outbound/cardkit-stream.ts";

/**
 * Real CardKit v1 API shapes (official docs, verified 2026-08):
 * - create:     POST /open-apis/cardkit/v1/cards
 *               body {data:{type:"card_json",data:"<stringified card JSON>"}}
 * - deliver:    im/v1/messages msg_type "interactive"
 *               content {"type":"card","data":{"card_id"}} (entity sends ONCE)
 * - stream text:PUT /cards/:id/elements/:element_id/content
 *               body {content:"<FULL text>",sequence,uuid?}
 * - settings:   PATCH /cards/:id/settings
 *               body {settings:"<stringified config>",sequence,uuid?}
 * - full update:PUT /cards/:id
 *               body {card:{type:"card_json",data:"..."},sequence,uuid?}
 * sequence is strictly increasing PER CARD across all operations.
 */

function fakeApi() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  let nextId = 1;
  let seqSeen: Array<{ op: string; sequence: number }> = [];
  return {
    calls,
    seqSeen,
    api: {
      async createCard(payload: unknown) {
        calls.push({ op: "create", args: [payload] });
        return { card_id: `card-${nextId++}` };
      },
      async deliverCard(cardId: string) {
        calls.push({ op: "deliver", args: [cardId] });
        return {};
      },
      async streamText(cardId: string, elementId: string, body: { sequence: number }) {
        calls.push({ op: "streamText", args: [cardId, elementId, body] });
        seqSeen.push({ op: "streamText", sequence: body.sequence });
        return {};
      },
      async patchSettings(cardId: string, body: { sequence: number }) {
        calls.push({ op: "settings", args: [cardId, body] });
        seqSeen.push({ op: "settings", sequence: body.sequence });
        return {};
      },
      async updateCard(cardId: string, body: { sequence: number }) {
        calls.push({ op: "update", args: [cardId, body] });
        seqSeen.push({ op: "update", sequence: body.sequence });
        return {};
      },
    },
  };
}

function createPayloadOf(calls: Array<{ op: string; args: unknown[] }>) {
  const createCall = calls.find((c) => c.op === "create")!;
  // Official shape: the request body is FLAT {type:"card_json", data:"<json string>"}
  // (POST /open-apis/cardkit/v1/cards request body, verified 2026-08). The
  // earlier {data:{type,data}} wrapper was rejected by the API → no card.
  const payload = createCall.args[0] as { type: string; data: string };
  assert.equal(payload.type, "card_json");
  return JSON.parse(payload.data) as Record<string, unknown>;
}

test("cardkit: first patch creates a streaming card entity and delivers it", async () => {
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, printFrequencyMs: 1, printStep: 3 });
  await stream.patch("hello");
  assert.ok(stream.cardId.length > 0);

  const card = createPayloadOf(calls);
  assert.equal(card.schema, CARD_SCHEMA);
  const config = card.config as { streaming_mode: boolean; update_multi?: boolean; streaming_config: { print_frequency_ms: { default: number }; print_step: { default: number } } };
  assert.equal(config.streaming_mode, true, "card created with streaming_mode on");
  assert.equal(config.update_multi, true, "card created with update_multi true");
  assert.equal(config.streaming_config.print_frequency_ms.default, 1);
  assert.equal(config.streaming_config.print_step.default, 3);
  const elements = (card.body as { elements: Array<{ tag: string; element_id?: string }> }).elements;
  assert.equal(elements.find((element) => element.element_id === STREAM_ELEMENT_ID)?.tag, "markdown");
  assert.equal(elements.find((element) => element.element_id === STATUS_ELEMENT_ID)?.tag, "markdown");
  assert.equal(elements.some((element) => element.tag === "collapsible_panel"), false, "empty panels stay hidden");

  // The card entity must be DELIVERED into the chat (im message with card_id) —
  // creating the entity alone shows nothing to the user.
  const deliver = calls.find((c) => c.op === "deliver")!;
  assert.equal(deliver.args[0], stream.cardId);
});

test("cardkit: status and answer share one live card", async () => {
  const { api, calls } = fakeApi();
  let fakeNow = 0;
  const stream = createCardKitStream({ api, minPushIntervalMs: 1, statusTickMs: 0, now: () => fakeNow });
  await stream.status("🧠 **思考中…**");
  const firstCard = createPayloadOf(calls) as { body: { elements: Array<{ tag: string; content?: string; element_id?: string; elements?: Array<{ element_id?: string }> }> } };
  assert.match(firstCard.body.elements.find((element) => element.element_id === STATUS_ELEMENT_ID)?.content ?? "", /思考中/);
  assert.equal(firstCard.body.elements.some((element) => element.tag === "collapsible_panel"), false);
  fakeNow += 10;
  await stream.status("🛠️ **正在调用工具** · `read`");
  fakeNow += 10;
  await stream.patch("正在分析");
  fakeNow += 10;
  await stream.reasoning("先读取文件，再核对图片。");
  fakeNow += 10;
  await stream.tool("▶️ 调用 `read`");
  fakeNow += 10;
  await stream.tool("✅ `read` 成功");
  fakeNow += 10;
  await stream.image("img_v3_generated", "生成预览");
  fakeNow += 10;
  await stream.status("✅ **已完成**");
  await stream.finalize("最终答案");

  assert.equal(calls.filter((call) => call.op === "create").length, 1, "one card entity per turn");
  assert.equal(calls.filter((call) => call.op === "deliver").length, 1, "one Feishu message per turn");
  const update = calls.filter((call) => call.op === "update").at(-1)!;
  const body = update.args[1] as { card: { data: string } };
  const finalCard = JSON.parse(body.card.data) as any;
  assert.match(finalCard.body.elements.find((element: any) => element.element_id === STATUS_ELEMENT_ID)?.content ?? "", /已完成/);
  assert.ok(finalCard.body.elements.some((element: any) => /最终答案/.test(element.content ?? "")));
  // Settled layout: [status, 外层总过程(可折叠), 结果 …] — the answer and any
  // generated image stay OUTSIDE the folded process.
  assert.ok(
    finalCard.body.elements.some((element: any) => /最终答案/.test(element.content ?? "")),
    "最终答案必须留在卡片外层可见",
  );
  const outer = finalCard.body.elements.find((element: any) =>
    element.header?.title?.content?.startsWith("过程 ·"),
  );
  // The header counts what is INSIDE the panel. The only text segment here is the
  // answer, which is kept OUTSIDE, so no 对话 round is reported.
  assert.match(outer?.header?.title?.content ?? "", /1 工具 · 1 思考/);
  // ONE collapsible level for the whole card: rounds are plain markdown blocks
  // inside this single panel, so several sub-panels can never stand open at once
  // (Feishu never reports panel expansion, so exclusivity must be structural).
  assert.equal(
    finalCard.body.elements.filter((element: any) => element.tag === "collapsible_panel").length,
    1,
    "全卡只能有一个可折叠面板",
  );
  const flat = (outer?.elements ?? []) as any[];
  assert.equal(
    flat.some((element) => element.tag === "collapsible_panel"),
    false,
    "面板内不得再有嵌套折叠",
  );
  const reasoningBlock = flat.find((element) => /思考 1/.test(element.content ?? ""));
  assert.match(reasoningBlock?.content ?? "", /```text/);
  assert.match(reasoningBlock?.content ?? "", /先读取文件/);
  assert.equal(reasoningBlock?.element_id, REASONING_ELEMENT_ID);
  const toolBlock = flat.find((element) => /工具 1/.test(element.content ?? ""));
  assert.equal(toolBlock?.element_id, TOOL_ELEMENT_ID);
  assert.match(toolBlock?.content ?? "", /read.*成功/);
  assert.equal(finalCard.body.elements.find((element: any) => element.tag === "img")?.img_key, "img_v3_generated");
});

test("cardkit: preserves interleaved reasoning, narration and tool rounds in chronological order", async () => {
  const { api, calls } = fakeApi();
  let fakeNow = 0;
  const stream = createCardKitStream({ api, minPushIntervalMs: 1, statusTickMs: 0, now: () => fakeNow });

  await stream.reasoning("先检查源码");
  fakeNow += 10;
  await stream.patch("我先读取配置。", true);
  fakeNow += 10;
  await stream.tool("▶️ 调用 `read`", { phase: "call", callId: "c1", title: "read" });
  fakeNow += 10;
  await stream.tool("✅ `read` 成功", { phase: "result", callId: "c1", title: "read" });
  fakeNow += 10;
  await stream.reasoning("根据配置继续检查");
  fakeNow += 10;
  await stream.patch("接着运行测试。", true);
  fakeNow += 10;
  await stream.tool("▶️ 调用 `bash`", { phase: "call", callId: "c2", title: "bash" });
  fakeNow += 10;
  await stream.tool("✅ `bash` 成功", { phase: "result", callId: "c2", title: "bash" });
  fakeNow += 10;
  await stream.patch("全部完成。", true);
  await stream.finalize("全部完成。");

  const update = calls.filter((call) => call.op === "update").at(-1)!;
  const body = update.args[1] as { card: { data: string } };
  const card = JSON.parse(body.card.data) as any;
  // Settled layout: ONE outer 过程 panel (everything intermediate) + the answer.
  const elements = card.body.elements.slice(1);
  assert.deepEqual(
    elements.map((element: any) => element.header?.title?.content ?? element.content),
    ["过程 · 2 轮对话 · 2 工具 · 2 思考", "全部完成。"],
  );
  const outer = elements[0];
  assert.equal(outer.tag, "collapsible_panel");
  assert.equal(outer.expanded, false);
  // Inside the ONE panel the timeline stays FLAT and INTERLEAVED:
  // 思考 → 叙述 → 工具 → 思考 → 叙述 → 工具. Plain labelled blocks, no nested
  // panels, so this single group is the only thing that can ever be expanded.
  const labels = outer.elements.map((element: any) => String(element.content));
  assert.equal(labels.length, 6, `轮次块数量应为 6，实际 ${labels.length}`);
  assert.match(labels[0]!, /^\*\*思考 1\*\*/);
  assert.equal(labels[1], "我先读取配置。");
  assert.match(labels[2]!, /^\*\*工具 1 · read\*\*/);
  assert.match(labels[3]!, /^\*\*思考 2\*\*/);
  assert.equal(labels[4], "接着运行测试。");
  assert.match(labels[5]!, /^\*\*工具 2 · bash\*\*/);
  assert.match(labels[2]!, /调用.*read[\s\S]*read.*成功/);
  assert.match(labels[5]!, /调用.*bash[\s\S]*bash.*成功/);
  assert.equal(
    card.body.elements.filter((element: any) => element.tag === "collapsible_panel").length,
    1,
    "全卡只能有一个可折叠面板",
  );
});

test("cardkit: oversized turn is compacted to fit the card budget", async () => {
  const { api, calls } = fakeApi();
  let fakeNow = 0;
  const stream = createCardKitStream({ api, minPushIntervalMs: 0, statusTickMs: 0, now: () => fakeNow });
  for (let i = 0; i < 12; i += 1) {
    await stream.tool(
      `▶️ 调用 \`tool${i}\`\n\`\`\`json\n{"blob":"${"x".repeat(4000)}"}\n\`\`\``,
      { phase: "call", callId: `c${i}`, title: `tool${i}` },
    );
    fakeNow += 10;
  }
  await stream.finalize("结果");
  const update = calls.filter((call) => call.op === "update").at(-1)!;
  const data = (update.args[1] as { card: { data: string } }).card.data;
  assert.ok(
    Buffer.byteLength(data, "utf8") <= 24_000,
    `压缩后必须落在卡片预算内，实际 ${Buffer.byteLength(data, "utf8")}`,
  );
  assert.match(data, /结果/, "压缩后仍保留最终答案");
});

test("cardkit: compaction favors the NEWEST round and reports the level", async () => {
  const compacted: Array<{ stage: number; scale: number; bytes: number }> = [];
  const { api, calls } = fakeApi();
  let fakeNow = 0;
  // A deliberately tiny budget: the same ladder that keeps a 24KB card readable
  // must degrade the OLDEST rounds first when it is squeezed.
  const stream = createCardKitStream({
    api,
    minPushIntervalMs: 0,
    statusTickMs: 0,
    maxCardBytes: 2_000,
    now: () => fakeNow,
    onCompacted: (info) => compacted.push(info),
  });
  for (let i = 0; i < 12; i += 1) {
    await stream.tool(
      `▶️ 调用 \`tool${i}\`\n\`\`\`json\n{"blob":"${"x".repeat(2_000)}"}\n\`\`\``,
      { phase: "call", callId: `c${i}`, title: `tool${i}` },
    );
    fakeNow += 10;
  }
  await stream.finalize("答案");
  const data = (calls.filter((call) => call.op === "update").at(-1)!.args[1] as {
    card: { data: string };
  }).card.data;
  assert.ok(Buffer.byteLength(data, "utf8") <= 2_000, `必须在预算内，实际 ${Buffer.byteLength(data, "utf8")}`);
  assert.ok(compacted.length >= 1, "触发压缩必须上报（否则线上无从判断是否降级）");
  assert.match(data, /答案/, "压缩不得牺牲最终答案");
  const card = JSON.parse(data) as any;
  const blocks = card.body.elements
    .flatMap((element: any) => (element.tag === "collapsible_panel" ? element.elements : []))
    .filter((element: any) => /^\*\*工具 \d+/.test(String(element.content ?? ""))) as any[];
  assert.ok(blocks.length > 8, `过程面板应保留多轮，实际 ${blocks.length}`);
  const newest = String(blocks.at(-1)!.content);
  const oldest = String(blocks[0]!.content);
  assert.match(newest, /tool11/, "最新一轮必须保留");
  assert.ok(
    newest.length > oldest.length,
    `最新一轮应比最旧一轮保留更多细节（${newest.length} vs ${oldest.length}）`,
  );
  assert.match(oldest, /细节已省略/, "最旧的轮次必须先被压掉正文");
});

test("cardkit: when even titles overflow, the OLDEST rounds are dropped whole", async () => {
  const compacted: Array<{ stage: number; scale: number; bytes: number }> = [];
  const { api, calls } = fakeApi();
  let fakeNow = 0;
  const stream = createCardKitStream({
    api,
    minPushIntervalMs: 0,
    statusTickMs: 0,
    maxCardBytes: 1_200,
    now: () => fakeNow,
    onCompacted: (info) => compacted.push(info),
  });
  for (let i = 0; i < 30; i += 1) {
    await stream.tool(`▶️ 调用 \`tool${i}\``, {
      phase: "call",
      callId: `c${i}`,
      title: `tool${i}`,
    });
    fakeNow += 10;
  }
  await stream.finalize("最后答案");
  const data = (calls.filter((call) => call.op === "update").at(-1)!.args[1] as {
    card: { data: string };
  }).card.data;
  assert.ok(Buffer.byteLength(data, "utf8") <= 1_200, `必须在预算内，实际 ${Buffer.byteLength(data, "utf8")}`);
  assert.ok(
    compacted.some((info) => info.stage >= 2),
    `应进入丢弃旧轮次的档位，实际上报 ${JSON.stringify(compacted)}`,
  );
  const card = JSON.parse(data) as any;
  const panels = card.body.elements.filter((element: any) => element.tag === "collapsible_panel");
  assert.equal(panels.length, 1, "全卡只能有一个可折叠面板");
  const blocks = panels[0].elements.filter((element: any) => /^\*\*工具 \d+/.test(String(element.content ?? "")));
  assert.ok(blocks.length < 30, `旧轮次应被整体丢弃，实际保留 ${blocks.length} 轮`);
  assert.match(String(blocks.at(-1)?.content ?? ""), /tool29/, "最新一轮在任何档位都必须保留");
  assert.match(data, /最后答案/, "最终答案永不参与压缩");
});

test("cardkit: rejected final card falls back to a minimal status+answer card", async () => {
  let rejectedFull = 0;
  const api = {
    async createCard() {
      return { card_id: "card-min" };
    },
    async deliverCard() {
      return {};
    },
    async streamText() {
      return {};
    },
    async patchSettings() {
      return {};
    },
    async updateCard(_cardId: string, body: { card: { data: string } }) {
      // Simulate CardKit rejecting anything carrying folded panels.
      if (body.card.data.includes("collapsible_panel")) {
        rejectedFull += 1;
        throw new Error("card content too large");
      }
      return {};
    },
  };
  const stream = createCardKitStream({ api, printFrequencyMs: 1 });
  await stream.tool("▶️ 调用 `read`", { phase: "call", callId: "c1", title: "read" });
  await stream.finalize("最终答案");
  assert.ok(rejectedFull >= 1, "满卡被拒");
  assert.equal(stream.disposed, true, "降级成功后句柄正常关闭（不抛错）");
});

test("cardkit: header shows REAL totals (turn + session) like DSH's footer, never a rate", async () => {
  const { api, calls } = fakeApi();
  let fakeNow = 0;
  const stream = createCardKitStream({ api, minPushIntervalMs: 0, statusTickMs: 0, now: () => fakeNow });
  const statusAt = (): string => {
    const all = calls
      .filter((call) => call.op === "streamText" && call.args[1] === STATUS_ELEMENT_ID)
      .map((call) => (call.args[2] as { content: string }).content);
    return all.at(-1) ?? "";
  };
  await stream.status("🧠 **思考中**", { phase: "thinking" });
  // Until accounting arrives the stream estimate is shown — marked ≈ so it can
  // never be read as a real number — and NO speed is ever rendered.
  for (let i = 0; i < 8; i += 1) {
    fakeNow += 500;
    await stream.patch("a".repeat(50));
  }
  await stream.status("🧠 **思考中**", { phase: "thinking" });
  assert.match(statusAt(), /≈\d/, `无真实用量时应显示估算，实际 ${statusAt()}`);
  assert.doesNotMatch(statusAt(), /tok\/s/, `不得再出现 token 时速，实际 ${statusAt()}`);

  // Real accounting replaces the estimate outright: `本回合 X · 会话 Y tok`.
  fakeNow += 1_000;
  await stream.usage({
    turn: { tokens: 19_300, prompt: 15_000, cacheRead: 0 },
    session: { tokens: 122_000, prompt: 110_000, cacheRead: 0 },
  });
  const live = statusAt();
  assert.match(live, /本回合 19\.3K/, `实际 ${live}`);
  assert.match(live, /会话 122K tok/, `实际 ${live}`);
  assert.match(live, /5s/, `头部必须保留耗时，实际 ${live}`);
  assert.doesNotMatch(live, /≈/, "真实用量到位后不得再显示估算");
  assert.doesNotMatch(live, /缓存命中/, "命中为 0 时不显示缓存命中，避免噪音");

  // A real cache hit then shows up as a share of the billed prompt.
  await stream.usage({
    turn: { tokens: 19_300, prompt: 15_000, cacheRead: 6_000 },
    session: { tokens: 122_000, prompt: 110_000, cacheRead: 22_000 },
  });
  assert.match(statusAt(), /缓存命中 20%/, `实际 ${statusAt()}`);

  // A settled turn keeps the totals (they are the headline of the finished card).
  await stream.status("✅ **对话结束**", { phase: "done" });
  await stream.finalize("done");
  const update = calls.filter((call) => call.op === "update").at(-1)!;
  const settled = JSON.parse((update.args[1] as { card: { data: string } }).card.data) as any;
  const settledStatus =
    settled.body.elements.find((element: any) => element.element_id === STATUS_ELEMENT_ID)
      ?.content ?? "";
  assert.match(settledStatus, /本回合 19\.3K · 会话 122K tok/, `结束态应保留总量，实际 ${settledStatus}`);
  assert.doesNotMatch(settledStatus, /tok\/s/, `结束态不得出现速率，实际 ${settledStatus}`);
});

test("cardkit: all-zero totals fall back to the estimate instead of claiming 0 tok", async () => {
  const { api, calls } = fakeApi();
  let fakeNow = 0;
  const stream = createCardKitStream({ api, minPushIntervalMs: 0, statusTickMs: 0, now: () => fakeNow });
  const statusAt = (): string =>
    calls
      .filter((call) => call.op === "streamText" && call.args[1] === STATUS_ELEMENT_ID)
      .map((call) => (call.args[2] as { content: string }).content)
      .at(-1) ?? "";
  for (let i = 0; i < 8; i += 1) {
    fakeNow += 500;
    await stream.patch("a".repeat(50));
  }
  // The forwarder hands its accumulators over at turn start, before any step has
  // reported usage — so all-zero totals mean "no reading yet", not "0 tokens".
  // A provider-side failure reports no usage at all, and rendering that as
  // `本回合 0 · 会话 0 tok` claims a measurement that never happened.
  await stream.usage({
    turn: { tokens: 0, prompt: 0, cacheRead: 0 },
    session: { tokens: 0, prompt: 0, cacheRead: 0 },
  });
  const live = statusAt();
  assert.doesNotMatch(live, /0 tok/, `零用量不得渲染成 0 tok，实际 ${live}`);
  assert.match(live, /≈\d/, `零用量应回退到估算，实际 ${live}`);
  await stream.finalize("done");
});

test("cardkit: no global patch cap — a long turn keeps streaming past 400 updates", async () => {
  const { api, calls } = fakeApi();
  let fakeNow = 0;
  const stream = createCardKitStream({ api, minPushIntervalMs: 0, statusTickMs: 0, now: () => fakeNow });
  await stream.status("🧠 **思考中**");
  // 600 element updates with no delay: the removed 400-patch safety valve used
  // to stop content updates mid-turn (finalize was left to deliver everything
  // at once). Throttling/backoff now carry that load instead.
  for (let i = 0; i < 600; i += 1) {
    fakeNow += 1_000;
    await stream.patch(`chunk-${i} `);
    await stream.status("🧠 **思考中**");
  }
  const patches = calls.filter(
    (call) => call.op === "streamText" && call.args[1] === STREAM_ELEMENT_ID,
  ).length;
  assert.ok(patches > 400, `长回合必须继续更新（>400），实际 ${patches}`);
  await stream.finalize("done");
});

test("cardkit: a full-text replace never inflates the fallback estimate", async () => {
  const { api, calls } = fakeApi();
  let fakeNow = 0;
  const stream = createCardKitStream({ api, minPushIntervalMs: 0, statusTickMs: 0, now: () => fakeNow });
  const statusAt = (): string =>
    calls
      .filter((call) => call.op === "streamText" && call.args[1] === STATUS_ELEMENT_ID)
      .map((call) => (call.args[2] as { content: string }).content)
      .at(-1) ?? "";
  const estimateOf = (text: string): number => {
    const match = /≈([\d.]+)(K?) tok/.exec(text);
    return match ? Number(match[1]) * (match[2] ? 1_000 : 1) : -1;
  };
  await stream.status("⏳ **正在生成**");
  for (let i = 0; i < 10; i += 1) {
    fakeNow += 500;
    await stream.patch("a".repeat(50));
  }
  // Content patches update the TEXT element; refresh the header to read the
  // estimate it would now render.
  await stream.status("⏳ **正在生成**");
  const before = estimateOf(statusAt());
  assert.ok(before > 0, `流式期间应有估算值，实际 ${statusAt()}`);
  // The settled message REPLACES the segment with a huge body. A replacement is
  // bookkeeping, not observed generation, so the estimate must not jump.
  fakeNow += 20;
  await stream.patch("中".repeat(6_000), true);
  await stream.status("⏳ **正在生成**");
  assert.equal(estimateOf(statusAt()), before, `整段替换不得抬高估算，实际 ${statusAt()}`);
  await stream.finalize("done");
});

test("cardkit: live status timer reports elapsed seconds", async () => {
  const { api, calls } = fakeApi();
  let fakeNow = 0;
  const stream = createCardKitStream({ api, minPushIntervalMs: 1, statusTickMs: 5, now: () => fakeNow });
  await stream.status("🧠 **思考中**");
  fakeNow = 2_100;
  await new Promise((resolve) => setTimeout(resolve, 18));
  const statusUpdates = calls
    .filter((call) => call.op === "streamText" && call.args[1] === STATUS_ELEMENT_ID)
    .map((call) => (call.args[2] as { content: string }).content);
  assert.ok(statusUpdates.some((content) => /2s/.test(content)), "timer pushed elapsed seconds");
  await stream.status("✅ **会话结束**");
  await stream.finalize("done");
});

test("cardkit: streamText sends FULL accumulated text with strictly increasing sequence", async () => {
  const { api, calls, seqSeen } = fakeApi();
  let fakeNow = 0;
  const stream = createCardKitStream({ api, printFrequencyMs: 1, now: () => fakeNow });
  await stream.patch("one ");       // create + deliver
  fakeNow += 10;
  await stream.patch("two ");       // streamText("one ")
  fakeNow += 10;
  await stream.patch("three");      // streamText("one two ")

  const streams = calls.filter((c) => c.op === "streamText");
  assert.equal(streams.length, 2);
  const first = streams[0]!.args[2] as { content: string; sequence: number };
  const second = streams[1]!.args[2] as { content: string; sequence: number };
  // The create happens on chunk 1; the first streamText fires on chunk 2 and
  // already carries the FULL accumulated text (typewriter prefix extension).
  assert.equal(first.content, "one two ", "FULL text (typewriter extends the prefix)");
  assert.equal(second.content, "one two three");
  assert.ok(second.sequence > first.sequence, "sequence strictly increasing");
  assert.equal(streams[0]!.args[1], STREAM_ELEMENT_ID, "element path targets the markdown element");
  assert.ok(seqSeen.every((s) => Number.isInteger(s.sequence) && s.sequence >= 1));
});

test("cardkit: finalize disables streaming then PUTs the full card", async () => {
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, printFrequencyMs: 1 });
  await stream.patch("a");
  const cardId = stream.cardId;
  await stream.finalize("full text");

  const settings = calls.find((c) => c.op === "settings")!;
  const settingsBody = settings.args[1] as { settings: string };
  const parsed = JSON.parse(settingsBody.settings) as { config: { streaming_mode: boolean } };
  assert.equal(parsed.config.streaming_mode, false, "streaming disabled first");

  const update = calls.find((c) => c.op === "update")!;
  const updateBody = update.args[1] as { card: { type: string; data: string } };
  assert.equal(updateBody.card.type, "card_json");
  const finalCard = JSON.parse(updateBody.card.data) as { body: { elements: Array<{ element_id?: string; content?: string }> } };
  assert.equal(finalCard.body.elements.find((element) => element.element_id === STREAM_ELEMENT_ID)?.content, "full text");
  assert.equal(update.args[0], cardId);
  assert.equal(stream.disposed, true);
});

test("cardkit: finalize sequence stays strictly increasing across settings+update", async () => {
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, printFrequencyMs: 1, now: () => 0 });
  await stream.patch("x");
  await stream.patch("y");
  await stream.finalize("full");
  const seqs = calls
    .filter((c) => c.op === "streamText" || c.op === "settings" || c.op === "update")
    .map((c) => (c.args[c.args.length - 1] as { sequence: number }).sequence);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "sequences strictly increase");
});

test("cardkit: create failure disposes (no crash) and surfaces onError", async () => {
  const api = {
    async createCard() {
      throw new Error("card api down");
    },
    async deliverCard() {
      throw new Error("unused");
    },
    async streamText() {
      throw new Error("unused");
    },
    async patchSettings() {
      throw new Error("unused");
    },
    async updateCard() {
      throw new Error("unused");
    },
  };
  let onError: unknown;
  const stream = createCardKitStream({ api, onError: (e) => (onError = e) });
  await stream.patch("x");
  assert.ok(onError, "error surfaced");
  assert.equal(stream.disposed, true);
  await assert.rejects(() => stream.finalize("y"));
});

test("cardkit: deliver failure after create disposes and surfaces", async () => {
  const calls: Array<{ op: string }> = [];
  const api = {
    async createCard() {
      calls.push({ op: "create" });
      return { card_id: "card-d1" };
    },
    async deliverCard() {
      calls.push({ op: "deliver" });
      throw new Error("im send failed");
    },
    async streamText() {
      calls.push({ op: "streamText" });
      return {};
    },
    async patchSettings() {
      return {};
    },
    async updateCard() {
      return {};
    },
  };
  let onError: unknown;
  const stream = createCardKitStream({ api, onError: (e) => (onError = e) });
  await stream.patch("x");
  assert.equal(stream.disposed, true, "undeliverable card is unusable → dispose");
  assert.ok(onError);
  assert.equal(calls.filter((c) => c.op === "streamText").length, 0);
});

test("cardkit: throttles streamText to printFrequencyMs", async () => {
  let fakeNow = 0;
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, printFrequencyMs: 100, now: () => fakeNow });
  await stream.patch("one");       // t=0 create
  fakeNow += 10;
  await stream.patch("two");       // t=10 throttled
  fakeNow += 200;
  await stream.patch("three");     // t=210 allowed
  assert.equal(calls.filter((c) => c.op === "streamText").length, 1);
});

test("cardkit: finalize RE-THROWS when the final PUT fails (caller falls back to outbox)", async () => {
  const api = {
    async createCard() {
      return { card_id: "card-9" };
    },
    async deliverCard() {
      return {};
    },
    async streamText() {
      return {};
    },
    async patchSettings() {
      return {};
    },
    async updateCard() {
      throw new Error("final PUT failed");
    },
  };
  let onError: unknown;
  const stream = createCardKitStream({ api, onError: (e) => (onError = e) });
  await stream.patch("content");
  await assert.rejects(() => stream.finalize("full text"), /final PUT failed/);
  assert.ok(onError, "error surfaced via onError");
  assert.equal(stream.disposed, true);
});

test("cardkit: finalize with NO prior patches creates a non-streaming card, delivers it, and re-throws on failure", async () => {
  const failApi = {
    async createCard() {
      throw new Error("create failed");
    },
    async deliverCard() {
      return {};
    },
    async streamText() {
      return {};
    },
    async patchSettings() {
      return {};
    },
    async updateCard() {
      return {};
    },
  };
  const stream = createCardKitStream({ api: failApi });
  await assert.rejects(() => stream.finalize("x"), /create failed/);

  // Success path: plain card created + delivered, no streaming config.
  const { api, calls } = fakeApi();
  const stream2 = createCardKitStream({ api });
  const id = await stream2.finalize("done text");
  assert.ok(id.startsWith("card-"));
  const card = createPayloadOf(calls);
  const config = card.config as { streaming_mode?: boolean } | undefined;
  assert.notEqual(config?.streaming_mode, true, "no streaming mode on a finalized-only card");
  const elements = (card.body as { elements: Array<{ element_id?: string; content?: string }> }).elements;
  assert.equal(elements.find((element) => element.element_id === STREAM_ELEMENT_ID)?.content, "done text");
  assert.equal(calls.find((c) => c.op === "deliver")?.args[0], id);
});

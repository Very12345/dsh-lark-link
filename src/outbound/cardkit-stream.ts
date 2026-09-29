// CardKit schema 2.0 streaming card client (ADR-8). Implements the OFFICIAL
// CardKit v1 flow (verified against open.feishu.cn docs, 2026-08):
//
//   1. POST /open-apis/cardkit/v1/cards
//      body {type:"card_json", data:"<stringified card JSON>"} (FLAT)
//      → {data:{card_id}} — creates a card ENTITY with streaming_mode on.
//   2. im/v1/messages (msg_type "interactive",
//      content {"type":"card","data":{"card_id"}}) — delivers the entity into
//      the chat. An entity can be sent EXACTLY ONCE, so this happens right
//      after creation.
//   3. PUT /cards/:card_id/elements/:element_id/content
//      body {content:"<FULL text>",sequence,uuid?} — streaming typewriter
//      updates. The API expects the full accumulated text; when the old text
//      is a prefix of the new one the client extends it with a typewriter
//      effect, so the handle accumulates chunk deltas itself.
//   4. finalize: PATCH /cards/:card_id/settings
//      body {settings:"<stringified {config:{streaming_mode:false}}>"} —
//      cosmetic (swallow errors) — then PUT /cards/:card_id
//      body {card:{type:"card_json",data:"…"},sequence} with the final
//      content. The final PUT is the durable delivery: its failure MUST
//      propagate so the caller (event-forwarder) falls back to the outbox.
//
// `sequence` must be strictly increasing across EVERY operation on the same
// card — one shared counter per handle. Ported pattern from pi-feishu-lark's
// cardkit-stream.ts, corrected to the documented payload shapes.

import { randomUUID } from "node:crypto";
import type { TokenTotals } from "../common/types.ts";
import {
	cacheHitPercent,
	formatTokenCount,
} from "../common/token-usage.ts";

export interface CardKitApi {
  /** POST /open-apis/cardkit/v1/cards — create a card entity. */
  createCard(payload: unknown): Promise<
    { card_id?: string; data?: { card_id?: string } } | undefined
  >;
  /** im/v1/messages — deliver the card entity into its chat (once per entity). */
  deliverCard(cardId: string): Promise<unknown>;
  /** PUT /cards/:id/elements/:elementId/content — full-text streaming update. */
  streamText(
    cardId: string,
    elementId: string,
    body: { content: string; sequence: number; uuid: string },
  ): Promise<unknown>;
  /** PATCH /cards/:id/settings — e.g. turn streaming_mode off. */
  patchSettings(
    cardId: string,
    body: { settings: string; sequence: number; uuid: string },
  ): Promise<unknown>;
  /** PUT /cards/:id — full card update (final content). */
  updateCard(
    cardId: string,
    body: {
      card: { type: "card_json"; data: string };
      sequence: number;
      uuid: string;
    },
  ): Promise<unknown>;
}

export interface CardKitStreamOptions {
  api: CardKitApi;
  /** Minimum ms between server-side REST API pushes (default 800ms to stay within Feishu chat rate limit). */
  minPushIntervalMs?: number;
  /** ms for client-side typewriter rendering speed in card json (default 120ms). */
  printFrequencyMs?: number;
  /** print_step for the client typewriter (config at create time). */
  printStep?: number;
  /** Live elapsed-time refresh interval. Set 0 to disable (tests). */
  statusTickMs?: number;
  /** Serialized-card budget override (default {@link MAX_CARD_BYTES}). Lets a
   *  test drive the compaction ladder without generating 24KB of content. */
  maxCardBytes?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
  /**
   * Called once whenever the card has to COMPACT to fit the budget (and once
   * more if the level changes later in the turn), so a long turn's degradation
   * is observable in the host log instead of being silently guessed at.
   */
  onCompacted?: (info: { stage: number; scale: number; bytes: number }) => void;
}

/** Phase label carried by the live header (思考中 / 生成中 / 工具执行中 / 对话结束). */
export type StatusPhase = "thinking" | "generating" | "tool" | "done";

export interface CardKitStreamHandle {
  cardId: string;
  /** Replace the live status line without appending it to answer text. The
   *  forwarder supplies the phase LABEL; `phase` stays accepted for call-site
   *  compatibility (it used to gate a per-episode token rate). */
  status(text: string, opts?: { phase?: StatusPhase }): Promise<void>;
  /**
   * Replace the header's token accounting with REAL totals accumulated from
   * `assistant/message.usage`: this turn's own total and the session's running
   * total. Until this is called the header falls back to a stream estimate.
   */
  usage(totals: { turn: TokenTotals; session: TokenTotals }): Promise<void>;
  /** Count model-generated content that did NOT arrive as stream deltas — the
   *  argument block of a tool call is output too. Feeds the FALLBACK estimate
   *  only; real accounting arrives through usage(). */
  countGenerated(text: string): void;
  /** Append or replace the current reasoning round in the chronological timeline. */
  reasoning(text: string, replace?: boolean): Promise<void>;
  /** Start/update one tool call in the chronological timeline. */
  tool(text: string, options?: CardKitToolOptions): Promise<void>;
  /** Embed an uploaded Feishu image in the same live answer card. */
  image(imageKey: string, alt?: string): Promise<void>;
  /** Append or replace answer text; the handle sends FULL accumulated text. */
  patch(text: string, replace?: boolean): Promise<void>;
  /** Finalize: disable streaming, PUT full content. Returns final card id. */
  finalize(fullText: string): Promise<string>;
  /** Send a plain-text fallback when cards are unavailable. */
  fallbackText?: (text: string) => Promise<unknown>;
  disposed: boolean;
}

export interface CardKitToolOptions {
  callId?: string;
  title?: string;
  phase?: "call" | "result";
}

const CARD_SCHEMA = "2.0";
/** CJK / kana / hangul ranges counted as one token per character. */
const CJK_CHAR =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/;
/** Serialized-card budget — a CardKit platform limit, not a policy knob. */
const MAX_CARD_BYTES = 24_000;
/** Characters of detail kept for the NEWEST folded round at full quality. */
const DEFAULT_DETAIL_LIMIT = 900;
/** Every step of AGE halves the allowance: the newest round keeps 900 chars,
 *  the one before it 450, then 225 … down to 0 (titles only). */
const DETAIL_DECAY = 0.5;
/** Binary-search passes used to fit one stage (8 ≈ 0.4% resolution). */
const DETAIL_FIT_STEPS = 8;
/** Last-resort card: a longer answer belongs on the durable text channel. */
const MINIMAL_CARD_ANSWER_LIMIT = 10_000;
/** Per-age body allowance BEFORE scaling (index 0 = the newest round). */
const DETAIL_LADDER: ReadonlyArray<number> = Array.from({ length: 12 }, (_unused, age) =>
  Math.max(0, Math.round(DEFAULT_DETAIL_LIMIT * DETAIL_DECAY ** age)),
);

/** How much detail ONE serialization pass keeps. */
interface CardPlan {
  /** Character budget per round, indexed by AGE (0 = the newest round). */
  detailLimits: ReadonlyArray<number>;
  /** Keep the final answer only and drop intermediate narration. */
  dropNarration: boolean;
  /** Rounds at or beyond this age are dropped entirely (Infinity = keep all). */
  keepRounds: number;
}

/**
 * Compaction stages, tried in order until the card fits the budget.
 *
 * The order encodes the reader's priority: the LATEST state is the last thing to
 * lose detail, because what the user opens the card for is "what is the AI doing
 * right now". Stage 1 shrinks every round's body allowance (newest keeps the
 * most), stage 2 drops intermediate narration, and the rest drop the OLDEST
 * rounds' bodies and then the rounds themselves. The status line with its token
 * totals and the live/answer text are never compressed by any stage.
 */
const COMPACT_STAGES: ReadonlyArray<{ dropNarration: boolean; keepRounds: number }> = [
  { dropNarration: false, keepRounds: Number.POSITIVE_INFINITY },
  { dropNarration: true, keepRounds: Number.POSITIVE_INFINITY },
  { dropNarration: true, keepRounds: 8 },
  { dropNarration: true, keepRounds: 4 },
  { dropNarration: true, keepRounds: 2 },
  { dropNarration: true, keepRounds: 1 },
];
/** element ids are 1–20 chars per CardKit rules. */
const STREAM_ELEMENT_ID = "stream_md";
const STATUS_ELEMENT_ID = "status_md";
const REASONING_ELEMENT_ID = "reasoning_md";
const TOOL_ELEMENT_ID = "tool_md";

type TimelineSegment =
  | { kind: "reasoning"; id: string; content: string; ordinal: number; order: number }
  | { kind: "tool"; id: string; content: string; ordinal: number; order: number; callId?: string; title?: string }
  | { kind: "text"; id: string; content: string; ordinal: number; order: number }
  | { kind: "image"; imageKey: string; alt: string; order: number };

/** Timeline members that get folded into a "过程" panel (thinking + tools). */
type ProcessSegment = Extract<TimelineSegment, { kind: "reasoning" | "tool" }>;

export function createCardKitStream(
  opts: CardKitStreamOptions,
): CardKitStreamHandle {
  let cardId: string | undefined;
  let seq = 0; // strictly increasing across ALL ops on this card
  const lastPatchAt = new Map<string, number>();
  let disposed = false;
  let createPromise: Promise<void> | undefined;
  // CardKit requires one strictly ordered sequence across structural updates,
  // element patches and finalization. A boolean lock used to DROP an update
  // whenever the status timer was in flight; a real FIFO never loses it.
  let operationTail: Promise<void> = Promise.resolve();
  let backoffUntil = 0;
  // Preserve the real Agent event order. The old implementation had one
  // accumulator per kind, flattening R1 → tool1 → text1 → R2 into buckets.
  const timeline: TimelineSegment[] = [];
  let nextTimelineOrdinal = 1;
  let reasoningCount = 0;
  let toolCount = 0;
  let textCount = 0;
  let statusText = "";
  let structureSignature = "";
  /** Compaction level last reported (observability fires on CHANGE only). */
  let compactStage = -1;
  /** Text segment that carries the ANSWER once the turn has settled. */
  let finalSegmentId: string | undefined;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const minInterval = opts.minPushIntervalMs ?? opts.printFrequencyMs ?? 800;
  const maxCardBytes = opts.maxCardBytes ?? MAX_CARD_BYTES;
  /** Detail scale that fit last time (1 = uncompacted), seeding the next search. */
  let lastFittedScale = 1;
  const statusTickMs = opts.statusTickMs === undefined ? 1000 : Math.max(0, opts.statusTickMs);
  let statusTimer: ReturnType<typeof setInterval> | undefined;

  const nextSeq = (): number => {

    seq += 1;
    return seq;
  };


  const elapsedSeconds = (): number => Math.max(0, Math.floor((now() - startedAt) / 1000));
  /**
   * Fallback estimate for one piece of GENERATED text (assistant output +
   * reasoning): CJK costs ~1 token per character, everything else ~1 per 4.
   *
   * This is ONLY a fallback. DSH reports real accounting on every step's
   * `assistant/message` (`usage: {inputTokens, outputTokens, cacheReadTokens…}`)
   * and THAT is what the header shows; the estimate keeps the header meaningful
   * for adapters that report none.
   */
  const estimateTokens = (text: string): number => {
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
      if (CJK_CHAR.test(ch)) cjk += 1;
      else other += 1;
    }
    return cjk + Math.ceil(other / 4);
  };
  /** Whole-turn generated estimate — used only when no real usage arrived. */
  let generatedTokens = 0;
  /**
   * Real accounting pushed by the forwarder: this turn's own total and the
   * session's running total. Undefined until a step reports usage.
   */
  let tokenTotals: { turn: TokenTotals; session: TokenTotals } | undefined;

  /**
   * Record model-generated content into the fallback estimate. `replace` calls
   * are deliberately NOT routed here: they may re-deliver a whole message that
   * was already counted.
   */
  const recordGeneration = (deltaTokens: number): void => {
    generatedTokens += deltaTokens;
  };

  /**
   * Header suffix: elapsed time plus token accounting.
   *
   * Real accounting renders the way DSH's own WebUI footer does —
   * `12s · 本回合 19.3K · 会话 122K tok`, plus `缓存命中 N%` once anything was
   * served from cache. Only when no adapter reported usage does it degrade to
   * the stream-derived estimate, marked `≈` so it can never be mistaken for a
   * real number — including the case where the only totals pushed so far are
   * zeros (a failed turn reports no usage at all, and claiming "0 tok" would be
   * a fabricated reading). Token SPEED is gone on purpose: it needed a
   * per-episode denominator, flickered while generating and read as noise — a
   * total is what a reader can act on.
   */
  const progressSuffix = (): string => {
    const parts = [`**${elapsedSeconds()}s**`];
    const totals =
      tokenTotals && (tokenTotals.turn.tokens > 0 || tokenTotals.session.tokens > 0)
        ? tokenTotals
        : undefined;
    if (totals) {
      parts.push(
        `本回合 ${formatTokenCount(totals.turn.tokens)} · 会话 ${formatTokenCount(totals.session.tokens)} tok`,
      );
      const hit = cacheHitPercent(totals.session);
      if (hit !== undefined) parts.push(`缓存命中 ${hit}%`);
    } else if (generatedTokens > 0) {
      parts.push(`≈${formatTokenCount(generatedTokens)} tok`);
    }
    return ` · ${parts.join(" · ")}`;
  };
  // Header line: the phase label (思考中 / 生成中 / 工具执行中 / 对话结束), the
  // elapsed time and the token totals.
  const renderedStatus = (): string =>
    `${statusText || "🧠 **思考中**"}${progressSuffix()}`;
  const reasoningCode = (content: string): string => {
    const safe = content.replace(/```/g, "｀｀｀").trim();
    return safe ? `\`\`\`text\n${safe}\n\`\`\`` : "*等待模型返回可展示的思考内容…*";
  };
  const clip = (value: string, limit: number): string => {
    const text = String(value || "");
    if (limit <= 0) return "";
    return text.length <= limit
      ? text
      : `${text.slice(0, limit)}\n…（已省略 ${text.length - limit} 字符）`;
  };
  /**
   * One round inside a folded run: a LABELLED markdown block, deliberately not
   * another collapsible panel. That keeps the nesting at two levels
   * (总过程 → 轮次组 → 内容), which every Feishu client renders reliably.
   */
  const segmentBlock = (segment: ProcessSegment, detailLimit: number): unknown => {
    const label =
      segment.kind === "reasoning"
        ? `思考 ${segment.ordinal}`
        : `工具 ${segment.ordinal}${segment.title ? ` · ${segment.title}` : ""}`;
    const body = clip(segment.content, detailLimit);
    const rendered =
      segment.kind === "reasoning"
        ? body
          ? reasoningCode(body)
          : "*细节已省略*"
        : body || "*细节已省略*";
    return {
      tag: "markdown",
      element_id: segment.id,
      content: `**${label}**\n${rendered}`,
    };
  };
  /**
   * The whole intermediate process folded into ONE collapsible panel.
   *
   * There is deliberately only ONE collapsible level: nested run panels used to
   * let several sub-panels stand open at once, and Feishu's `collapsible_panel`
   * expansion is client-local (no callback), so "one open at a time" cannot be
   * enforced server-side. Flattening every round into this single panel gets
   * that behaviour by construction, and renders more reliably (nesting depth 1).
   */
  const outerPanel = (elements: unknown[], plan: CardPlan): unknown => {
    const tools = timeline.filter((segment) => segment.kind === "tool").length;
    const thinks = timeline.filter((segment) => segment.kind === "reasoning").length;
    const messages = plan.dropNarration
      ? 0
      : timeline.filter((segment) => segment.kind === "text" && segment.id !== finalSegmentId).length;
    const parts: string[] = [];
    if (messages > 0) parts.push(`${messages} 轮对话`);
    if (tools > 0) parts.push(`${tools} 工具`);
    if (thinks > 0) parts.push(`${thinks} 思考`);
    return {
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: { tag: "plain_text", content: `过程 · ${parts.join(" · ")}` },
        icon: {
          tag: "standard_icon",
          token: "down-small-ccm_outlined",
          size: "16px 16px",
        },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      border: { color: "grey", corner_radius: "5px" },
      elements,
    };
  };
  const segmentId = (kind: "reasoning" | "tool" | "text", count: number): string => {
    if (count === 1) {
      if (kind === "reasoning") return REASONING_ELEMENT_ID;
      if (kind === "tool") return TOOL_ELEMENT_ID;
      return STREAM_ELEMENT_ID;
    }
    const prefix = kind === "reasoning" ? "reason" : kind === "tool" ? "tool" : "text";
    return `${prefix}_${count}`;
  };
  const currentStructure = (): string => timeline
    .map((segment) => segment.kind === "image" ? `i:${segment.order}` : `${segment.kind[0]}:${segment.id}`)
    .join("|");
  /**
   * Card body: status header, every process round folded into ONE panel, then the
   * visible output (the settled answer, or the text currently being written, plus
   * any generated image).
   *
   * Detail is budgeted by AGE (see DETAIL_LADDER): the newest round keeps the most
   * characters, older rounds are progressively clipped and the oldest lose their
   * rows first — a shrinking budget must never cost the reader the CURRENT state.
   */
  const cardElements = (plan: CardPlan): unknown[] => {
    const header: unknown = {
      tag: "markdown",
      content: renderedStatus(),
      element_id: STATUS_ELEMENT_ID,
    };
    const processSegments = timeline.filter(
      (segment): segment is ProcessSegment =>
        segment.kind === "reasoning" || segment.kind === "tool",
    );
    const ageOf = new Map<string, number>();
    processSegments.forEach((segment, index) =>
      ageOf.set(segment.id, processSegments.length - 1 - index),
    );
    /** -1 = the round is dropped by the age cap (title included). */
    const detailFor = (segment: ProcessSegment): number => {
      const age = ageOf.get(segment.id) ?? 0;
      if (age >= plan.keepRounds) return -1;
      return plan.detailLimits[Math.min(age, plan.detailLimits.length - 1)] ?? 0;
    };
    const body: unknown[] = [];
    for (const segment of timeline) {
      if (segment.kind === "text") {
        const isFinal = segment.id === finalSegmentId;
        if (plan.dropNarration && !isFinal) continue;
        body.push({
          tag: "markdown",
          content: segment.content || " ",
          element_id: segment.id,
        });
      } else if (segment.kind === "image") {
        body.push({
          tag: "img",
          img_key: segment.imageKey,
          alt: { tag: "plain_text", content: segment.alt || "生成图片" },
          mode: "fit_horizontal",
          preview: true,
        });
      } else {
        const limit = detailFor(segment);
        if (limit < 0) continue;
        body.push(segmentBlock(segment, limit));
      }
    }
    // The fold exists DURING the turn as well, so the process can be collapsed
    // while it streams: every intermediate step goes into the outer 过程 panel,
    // while the visible output — the settled answer, or the text currently being
    // written — plus any generated image stays outside it. The card therefore
    // never restructures when the turn settles.
    const isImage = (element: unknown): boolean =>
      (element as { tag?: string }).tag === "img";
    const textIndices: number[] = [];
    body.forEach((element, index) => {
      if ((element as { tag?: string }).tag === "markdown") textIndices.push(index);
    });
    let visibleText: number | undefined;
    if (finalSegmentId !== undefined) {
      visibleText = textIndices.find(
        (index) => (body[index] as { element_id?: string }).element_id === finalSegmentId,
      );
    }
    if (visibleText === undefined) visibleText = textIndices.at(-1);
    const visible = body.filter(
      (element, index) => index === visibleText || isImage(element),
    );
    const process = body.filter(
      (element, index) => index !== visibleText && !isImage(element),
    );
    return process.length > 0
      ? [header, outerPanel(process, plan), ...visible]
      : [header, ...visible];
  };

  /** Card `config` block — shared by the full card and the last-resort card. */
  const cardConfig = (streaming: boolean): Record<string, unknown> => ({
    update_multi: true,
    ...(streaming
      ? {
          streaming_mode: true,
          streaming_config: {
            print_frequency_ms: { default: opts.printFrequencyMs ?? 120 },
            print_step: { default: opts.printStep ?? 3 },
            print_strategy: "fast",
          },
        }
      : { streaming_mode: false }),
  });

  const buildCardJson = (streaming: boolean, plan: CardPlan): string =>
    JSON.stringify({
      schema: CARD_SCHEMA,
      config: cardConfig(streaming),
      body: {
        elements: cardElements(plan),
      },
    });

  /** Plan for one compaction stage at a given detail scale (0 = titles only). */
  const planAt = (stage: number, scale: number): CardPlan => {
    const { dropNarration, keepRounds } = COMPACT_STAGES[stage]!;
    return {
      detailLimits: DETAIL_LADDER.map((limit) => Math.round(limit * scale)),
      dropNarration,
      keepRounds,
    };
  };

  const fitsBudget = (json: string): boolean =>
    Buffer.byteLength(json, "utf8") <= maxCardBytes;

  /**
   * Largest detail scale of ONE stage that fits the budget, or undefined when
   * even scale 0 (bodies fully dropped) overflows.
   *
   * The binary search is what makes this FINE-grained: instead of jumping
   * between a few coarse presets (900 → 300 → 120 → 0), the largest allowance
   * that still fits survives, so a 23.9KB card keeps meaningfully more detail
   * than a 12KB one.
   */
  const fitStage = (
    stage: number,
    streaming: boolean,
  ): { json: string; scale: number } | undefined => {
    const build = (scale: number): string => buildCardJson(streaming, planAt(stage, scale));
    // Content only GROWS within a turn, so the scale that fit last time is a
    // valid upper bound — probing it first keeps the common case at two
    // serializations instead of always rediscovering the boundary from full detail.
    const top = Math.min(1, lastFittedScale);
    const full = build(top);
    if (fitsBudget(full)) {
      lastFittedScale = top;
      return { json: full, scale: top };
    }
    const floor = build(0);
    if (!fitsBudget(floor)) {
      lastFittedScale = 1; // even titles-only overflows: let the caller advance
      return undefined;
    }
    let lo = 0;
    let hi = top;
    let best = { json: floor, scale: 0 };
    for (let step = 0; step < DETAIL_FIT_STEPS; step += 1) {
      const mid = (lo + hi) / 2;
      const json = build(mid);
      if (fitsBudget(json)) {
        best = { json, scale: mid };
        lo = mid; // fits — try to keep MORE detail
      } else {
        hi = mid; // too large — compress harder
      }
    }
    lastFittedScale = best.scale;
    return best;
  };

  /** Report a compaction level CHANGE only (serialization runs per segment). */
  const reportCompaction = (stage: number, scale: number, bytes: number): void => {
    if (stage === 0 && scale >= 1) return; // nothing was compacted
    if (stage === compactStage) return;
    compactStage = stage;
    opts.onCompacted?.({ stage, scale, bytes });
  };

  /**
   * Serialize the card, COMPACTING until it fits CardKit's budget.
   *
   * A long turn (dozens of tool rounds with fenced arguments) overshoots the
   * card-size limit, and a rejected PUT used to freeze the card mid-stream with
   * no answer. Stages are tried in reader-priority order (see COMPACT_STAGES)
   * and every one of them leaves the status line and the visible answer intact —
   * the card must always answer "what is the AI doing right now".
   */
  const cardJson = (streaming: boolean): string => {
    for (let stage = 0; stage < COMPACT_STAGES.length; stage += 1) {
      const fitted = fitStage(stage, streaming);
      if (!fitted) continue;
      reportCompaction(stage, fitted.scale, Buffer.byteLength(fitted.json, "utf8"));
      return fitted.json;
    }
    // Nothing fit: keep the status plus the visible answer, clip the answer to
    // what a card can hold and let the durable text channel carry the rest.
    const bare = minimalCardJson(
      finalAnswerText().slice(0, MINIMAL_CARD_ANSWER_LIMIT),
      streaming,
    );
    reportCompaction(COMPACT_STAGES.length, 0, Buffer.byteLength(bare, "utf8"));
    return bare;
  };

  /** The answer text the settled card must keep visible. */
  const finalAnswerText = (): string => {
    const target = finalSegmentId
      ? timeline.find((segment) => segment.kind === "text" && segment.id === finalSegmentId)
      : timeline.filter((segment) => segment.kind === "text").at(-1);
    return target && target.kind === "text" ? target.content : "";
  };

  /**
   * Last-resort card (status + answer only) when the full card was rejected.
   * `streaming` keeps the typewriter config alive for an in-turn fallback.
   */
  const minimalCardJson = (answer: string, streaming = false): string =>
    JSON.stringify({
      schema: CARD_SCHEMA,
      config: cardConfig(streaming),
      body: {
        elements: [
          { tag: "markdown", content: renderedStatus(), element_id: STATUS_ELEMENT_ID },
          { tag: "markdown", content: answer || " ", element_id: STREAM_ELEMENT_ID },
        ],
      },
    });

  const createPayload = (streaming: boolean): unknown => ({
    // FLAT body per the official create doc: {type:"card_json", data:"<json>"}
    // — NOT wrapped under a `data` envelope (that shape 400s and the card
    // never appears).
    type: "card_json" as const,
    data: cardJson(streaming),
  });

  const extractCardId = (
    res: { card_id?: string; data?: { card_id?: string } } | undefined,
  ): string | undefined => res?.card_id ?? res?.data?.card_id;

  const startStatusTimer = (): void => {
    if (statusTimer || statusTickMs <= 0) return;
    statusTimer = setInterval(() => {
      if (!disposed && cardId) void pushElement(STATUS_ELEMENT_ID, renderedStatus());
    }, statusTickMs);
    statusTimer.unref?.();
  };
  const stopStatusTimer = (): void => {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = undefined;
  };

  const enqueueOperation = async <T>(op: () => Promise<T>): Promise<T> => {
    const run = operationTail.then(op, op);
    operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const ensureCard = async (): Promise<void> => {
    if (disposed) return;
    if (cardId !== undefined) return;
    if (createPromise) return createPromise;
    createPromise = enqueueOperation(async () => {
      if (cardId !== undefined || disposed) return;
      try {
        const created = await opts.api.createCard(createPayload(true));
        cardId = extractCardId(created);
        if (!cardId) throw new Error("CardKit create returned no card_id");
        await opts.api.deliverCard(cardId);
        structureSignature = currentStructure();
        const stamp = now();
        lastPatchAt.set(STATUS_ELEMENT_ID, stamp);
        for (const segment of timeline) {
          if (segment.kind !== "image") lastPatchAt.set(segment.id, stamp);
        }
        startStatusTimer();
      } catch (err) {
        opts.onError?.(err);
        disposed = true;
        stopStatusTimer();
      }
    }).finally(() => {
      createPromise = undefined;
    });
    return createPromise;
  };

  const syncStructure = async (): Promise<void> => {
    await ensureCard();
    if (!cardId || disposed || structureSignature === currentStructure()) return;
    await enqueueOperation(async () => {
      if (!cardId || disposed || structureSignature === currentStructure()) return;
      try {
        await opts.api.updateCard(cardId, {
          card: { type: "card_json", data: cardJson(true) },
          sequence: nextSeq(),
          uuid: randomUUID(),
        });
        structureSignature = currentStructure();
        const stamp = now();
        for (const segment of timeline) {
          if (segment.kind !== "image") lastPatchAt.set(segment.id, stamp);
        }
      } catch (err) {
        // Keep structureSignature stale so the next event retries the full
        // structure instead of permanently hiding later tool rounds.
        opts.onError?.(err);
      }
    });
  };

  async function pushElement(elementId: string, content: string): Promise<void> {
    await ensureCard();
    if (!cardId || disposed) return;
    await enqueueOperation(async () => {
      if (!cardId || disposed) return;
      const currentTime = now();
      if (
        currentTime < backoffUntil ||
        currentTime - (lastPatchAt.get(elementId) ?? 0) < minInterval
      )
        return;
      lastPatchAt.set(elementId, currentTime);
      try {
        await opts.api.streamText(cardId, elementId, {
          content,
          sequence: nextSeq(),
          uuid: randomUUID(),
        });
      } catch (err) {
        const errStr = String(err);
        if (
          errStr.includes("230020") ||
          errStr.includes("rate limit") ||
          errStr.includes("429")
        ) {
          backoffUntil = now() + 1500;
        }
        opts.onError?.(err);
      }
    });
  }

  return {
    // Live getters — the closure fields mutate after creation (never snapshot).
    get cardId() {
      return cardId ?? "";
    },
    get disposed() {
      return disposed;
    },
    async status(text) {
      statusText = String(text || "").trim();
      await ensureCard();
      await pushElement(STATUS_ELEMENT_ID, renderedStatus());
    },
    async usage(totals) {
      if (disposed) return;
      // Store by reference: the forwarder owns the accumulators and hands over
      // freshly folded objects, so nothing needs copying here.
      tokenTotals = { turn: totals.turn, session: totals.session };
      await ensureCard();
      // Same per-element throttle as every other status update (800ms), so a
      // multi-step turn costs at most one extra PUT per step.
      await pushElement(STATUS_ELEMENT_ID, renderedStatus());
    },
    countGenerated(text) {
      if (disposed) return;
      const tokens = estimateTokens(String(text || ""));
      if (tokens > 0) recordGeneration(tokens);
    },
    async reasoning(text, replace = false) {
      if (disposed) return;
      let segment = timeline.at(-1);
      if (segment?.kind !== "reasoning") {
        reasoningCount += 1;
        segment = {
          kind: "reasoning",
          id: segmentId("reasoning", reasoningCount),
          content: "",
          ordinal: reasoningCount,
          order: nextTimelineOrdinal++,
        };
        timeline.push(segment);
      }
      const reasoningDelta = String(text || "");
      if (replace) {
        // Bookkeeping only — a full replacement is not observed generation.
        segment.content = reasoningDelta;
      } else {
        segment.content += reasoningDelta;
        recordGeneration(estimateTokens(reasoningDelta));
      }
      await syncStructure();
      await pushElement(segment.id, reasoningCode(segment.content));
    },
    async tool(text, options = {}) {
      if (disposed) return;
      let segment: Extract<TimelineSegment, { kind: "tool" }> | undefined;
      if (options.phase === "result" && options.callId) {
        segment = timeline.findLast((entry): entry is Extract<TimelineSegment, { kind: "tool" }> =>
          entry.kind === "tool" && entry.callId === options.callId);
      }
      if (!segment && options.phase !== "call") {
        const last = timeline.at(-1);
        if (last?.kind === "tool") segment = last;
      }
      if (!segment) {
        toolCount += 1;
        segment = {
          kind: "tool",
          id: segmentId("tool", toolCount),
          content: "",
          ordinal: toolCount,
          order: nextTimelineOrdinal++,
          callId: options.callId,
          title: options.title,
        };
        timeline.push(segment);
      }
      if (options.title && !segment.title) segment.title = options.title;
      const normalized = String(text || "").trim();
      segment.content += `${segment.content && normalized ? "\n\n" : ""}${normalized}`;
      await syncStructure();
      await pushElement(segment.id, segment.content || "*等待工具返回…*");
    },
    async image(imageKey, alt = "生成图片") {
      if (disposed || !imageKey) return;
      timeline.push({
        kind: "image",
        imageKey: String(imageKey),
        alt: String(alt || "生成图片"),
        order: nextTimelineOrdinal++,
      });
      await syncStructure();
    },
    async patch(text, replace = false) {
      if (disposed) return;
      let segment = timeline.at(-1);
      if (segment?.kind !== "text") {
        textCount += 1;
        segment = {
          kind: "text",
          id: segmentId("text", textCount),
          content: "",
          ordinal: textCount,
          order: nextTimelineOrdinal++,
        };
        timeline.push(segment);
      }
      const patchDelta = String(text || "");
      if (replace) {
        // Bookkeeping only — a full replacement is not observed generation.
        segment.content = patchDelta;
      } else {
        segment.content += patchDelta;
        recordGeneration(estimateTokens(patchDelta));
      }
      await syncStructure();
      await pushElement(segment.id, segment.content || " ");
    },
    async finalize(fullText) {
      if (disposed) {
        if (!cardId) throw new Error("CardKit stream handle was disposed (creation failed)");
        return cardId;
      }
      stopStatusTimer();
      // Drain every queued status/structure/content operation. The old
      // one-second polling window allowed finalize to race an earlier PUT,
      // producing out-of-order sequences and a final card missing tool rows.
      await operationTail;

      if (fullText) {
        let segment = timeline.at(-1);
        if (segment?.kind !== "text") {
          textCount += 1;
          segment = {
            kind: "text",
            id: segmentId("text", textCount),
            content: "",
            ordinal: textCount,
            order: nextTimelineOrdinal++,
          };
          timeline.push(segment);
        }
        segment.content = fullText;
        // Marks the ANSWER: it stays visible while every intermediate step folds
        // into the outer 过程 panel (see cardElements).
        finalSegmentId = segment.id;
      } else {
        const lastText = timeline.filter((segment) => segment.kind === "text").at(-1);
        if (lastText) finalSegmentId = lastText.id;
      }
      if (!cardId) {
        // Never streamed a chunk — create a plain (non-streaming) card with
        // the full content and deliver it. Failure PROPAGATES so the caller
        // falls back to the durable outbox (content must not be lost).
        try {
          const created = await opts.api.createCard(createPayload(false));
          cardId = extractCardId(created);
          if (!cardId) throw new Error("CardKit create returned no card_id");
          await opts.api.deliverCard(cardId);
          disposed = true;
          return cardId;
        } catch (err) {
          opts.onError?.(err);
          disposed = true;
          throw err;
        }
      }
      const id = cardId;
      // 1) Turn streaming OFF (PATCH settings) — cosmetic, swallow failure.
      try {
        await opts.api.patchSettings(id, {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: nextSeq(),
          uuid: randomUUID(),
        });
      } catch (err) {
        opts.onError?.(err);
      }
      // 2) PUT the full content — the durable delivery. Failure propagates.
      try {
        await opts.api.updateCard(id, {
          card: { type: "card_json", data: cardJson(false) },
          sequence: nextSeq(),
          uuid: randomUUID(),
        });
      } catch (err) {
        // If update failed with rate limit, wait 600ms and retry once
        const errStr = String(err);
        if (errStr.includes("230020") || errStr.includes("rate limit") || errStr.includes("429")) {
          await new Promise((r) => setTimeout(r, 600));
          try {
            await opts.api.updateCard(id, {
              card: { type: "card_json", data: cardJson(false) },
              sequence: nextSeq(),
              uuid: randomUUID(),
            });
            disposed = true;
            return id;
          } catch (retryErr) {
            opts.onError?.(retryErr);
            disposed = true;
            throw retryErr;
          }
        }
        // Oversized or otherwise rejected card: try a MINIMAL card (status +
        // answer) so the turn still ends visibly INSIDE the card. Answers too
        // long for a card are re-thrown instead — the durable text channel is a
        // better home for them than a truncated card.
        const answer = finalAnswerText();
        if (Buffer.byteLength(answer, "utf8") <= MINIMAL_CARD_ANSWER_LIMIT) {
          try {
            await opts.api.updateCard(id, {
              card: { type: "card_json", data: minimalCardJson(answer) },
              sequence: nextSeq(),
              uuid: randomUUID(),
            });
            opts.onError?.(err);
            disposed = true;
            return id;
          } catch (minimalErr) {
            opts.onError?.(minimalErr);
          }
        }
        opts.onError?.(err);
        disposed = true;
        throw err;
      }
      disposed = true;
      return id;
    },
  };

}

export { CARD_SCHEMA, STREAM_ELEMENT_ID, STATUS_ELEMENT_ID, REASONING_ELEMENT_ID, TOOL_ELEMENT_ID };

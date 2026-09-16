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
  now?: () => number;
  onError?: (err: unknown) => void;
}

export interface CardKitStreamHandle {
  cardId: string;
  /** Replace the live phase/status line without appending it to answer text. */
  status(text: string): Promise<void>;
  /** Append or replace reasoning inside the collapsed reasoning panel. */
  reasoning(text: string, replace?: boolean): Promise<void>;
  /** Append one line to the collapsed tool-activity panel. */
  tool(text: string): Promise<void>;
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

const CARD_SCHEMA = "2.0";
/** element ids are 1–20 chars per CardKit rules. */
const STREAM_ELEMENT_ID = "stream_md";
const STATUS_ELEMENT_ID = "status_md";
const REASONING_ELEMENT_ID = "reasoning_md";
const TOOL_ELEMENT_ID = "tool_md";
/** Safety valve: stop patching beyond this many API calls; finalize covers it. */
const MAX_STREAM_PATCHES = 400;

export function createCardKitStream(
  opts: CardKitStreamOptions,
): CardKitStreamHandle {
  let cardId: string | undefined;
  let seq = 0; // strictly increasing across ALL ops on this card
  const lastPatchAt = new Map<string, number>();
  let patchCount = 0;
  let disposed = false;
  let inFlight = false;
  let backoffUntil = 0;
  let acc = ""; // accumulated text — the API takes FULL text every push
  let reasoningAcc = "";
  let toolAcc = "";
  const imagesAcc: Array<{ imageKey: string; alt: string }> = [];
  let statusText = "";
  let structureSignature = "";
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const minInterval = opts.minPushIntervalMs ?? opts.printFrequencyMs ?? 800;
  const statusTickMs = opts.statusTickMs === undefined ? 1000 : Math.max(0, opts.statusTickMs);
  let statusTimer: ReturnType<typeof setInterval> | undefined;

  const nextSeq = (): number => {

    seq += 1;
    return seq;
  };


  const elapsedSeconds = (): number => Math.max(0, Math.floor((now() - startedAt) / 1000));
  const renderedStatus = (): string => statusText
    ? `${statusText} · **${elapsedSeconds()}s**`
    : `🧠 **思考中** · **${elapsedSeconds()}s**`;
  const reasoningCode = (): string => {
    const safe = reasoningAcc.replace(/```/g, "｀｀｀").trim();
    return safe ? `\`\`\`text\n${safe}\n\`\`\`` : "*等待模型返回可展示的思考内容…*";
  };
  const panel = (title: string, elementId: string, content: string): unknown => ({
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: { tag: "plain_text", content: title },
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      border: { color: "grey", corner_radius: "5px" },
      elements: [{ tag: "markdown", content, element_id: elementId }],
    });
  const currentStructure = (): string => `${reasoningAcc ? "r" : ""}${toolAcc ? "t" : ""}i${imagesAcc.length}`;
  const cardElements = (): unknown[] => {
    const elements: unknown[] = [
      { tag: "markdown", content: renderedStatus(), element_id: STATUS_ELEMENT_ID },
    ];
    if (reasoningAcc) elements.push(panel("思考过程 · 成功", REASONING_ELEMENT_ID, reasoningCode()));
    if (toolAcc) elements.push(panel("工具调用", TOOL_ELEMENT_ID, toolAcc));
    elements.push({ tag: "markdown", content: acc || " ", element_id: STREAM_ELEMENT_ID });
    for (const image of imagesAcc) elements.push({
      tag: "img",
      img_key: image.imageKey,
      alt: { tag: "plain_text", content: image.alt || "生成图片" },
      mode: "fit_horizontal",
      preview: true,
    });
    return elements;
  };

  const cardJson = (streaming: boolean): string =>
    JSON.stringify({
      schema: CARD_SCHEMA,
      config: {
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
          : {
              streaming_mode: false,
            }),
      },
      body: {
        elements: cardElements(),
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

  const ensureCard = async (): Promise<void> => {
    if (disposed) return;
    if (cardId !== undefined || inFlight) return;
    inFlight = true;
    try {
      const created = await opts.api.createCard(createPayload(true));
      cardId = extractCardId(created);
      if (!cardId) throw new Error("CardKit create returned no card_id");
      await opts.api.deliverCard(cardId);
      patchCount++;
      structureSignature = currentStructure();
      const stamp = now();
      lastPatchAt.set(STATUS_ELEMENT_ID, stamp);
      lastPatchAt.set(REASONING_ELEMENT_ID, stamp);
      lastPatchAt.set(STREAM_ELEMENT_ID, stamp);
      startStatusTimer();
    } catch (err) {
      opts.onError?.(err);
      disposed = true;
      stopStatusTimer();
    } finally {
      inFlight = false;
    }
  };

  const syncStructure = async (): Promise<void> => {
    await ensureCard();
    if (!cardId || disposed || structureSignature === currentStructure()) return;
    let waitCount = 0;
    while (inFlight && waitCount < 20) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      waitCount++;
    }
    if (inFlight || !cardId || disposed) return;
    inFlight = true;
    try {
      await opts.api.updateCard(cardId, {
        card: { type: "card_json", data: cardJson(true) },
        sequence: nextSeq(),
        uuid: randomUUID(),
      });
      structureSignature = currentStructure();
      patchCount++;
      const stamp = now();
      if (reasoningAcc) lastPatchAt.set(REASONING_ELEMENT_ID, stamp);
      if (toolAcc) lastPatchAt.set(TOOL_ELEMENT_ID, stamp);
    } catch (err) {
      opts.onError?.(err);
    } finally {
      inFlight = false;
    }
  };

  async function pushElement(elementId: string, content: string): Promise<void> {
    await ensureCard();
    if (!cardId || disposed) return;
    if (inFlight || patchCount >= MAX_STREAM_PATCHES) return;
    const currentTime = now();
    if (currentTime < backoffUntil || currentTime - (lastPatchAt.get(elementId) ?? 0) < minInterval) return;
    inFlight = true;
    lastPatchAt.set(elementId, currentTime);
    try {
      await opts.api.streamText(cardId, elementId, {
        content,
        sequence: nextSeq(),
        uuid: randomUUID(),
      });
      patchCount++;
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes("230020") || errStr.includes("rate limit") || errStr.includes("429")) {
        backoffUntil = now() + 1500;
      }
      opts.onError?.(err);
    } finally {
      inFlight = false;
    }
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
    async reasoning(text, replace = false) {
      if (disposed) return;
      reasoningAcc = replace ? String(text || "") : reasoningAcc + String(text || "");
      await syncStructure();
      await pushElement(REASONING_ELEMENT_ID, reasoningCode());
    },
    async tool(text) {
      if (disposed) return;
      toolAcc += `${toolAcc ? "\n" : ""}${String(text || "").trim()}`;
      await syncStructure();
      await pushElement(TOOL_ELEMENT_ID, toolAcc);
    },
    async image(imageKey, alt = "生成图片") {
      if (disposed || !imageKey) return;
      imagesAcc.push({ imageKey: String(imageKey), alt: String(alt || "生成图片") });
      await syncStructure();
    },
    async patch(text, replace = false) {
      if (disposed) return;
      acc = replace ? String(text || "") : acc + String(text || "");
      await ensureCard();
      await pushElement(STREAM_ELEMENT_ID, acc || " ");
    },
    async finalize(fullText) {
      if (disposed) {
        if (!cardId) throw new Error("CardKit stream handle was disposed (creation failed)");
        return cardId;
      }
      stopStatusTimer();
      // Wait for any inFlight network patch to settle before finalizing
      let waitCount = 0;
      while (inFlight && waitCount < 20) {
        await new Promise((r) => setTimeout(r, 50));
        waitCount++;
      }

      if (fullText) acc = fullText;
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

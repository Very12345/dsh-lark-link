// EventForwarder: the bridge's outbound "assistant → Feishu" pipeline.
// Consumes DSH session events (assistant/chunk for streaming, assistant/message
// for the durable final, turn/end for completion) and pushes them either into
// the volatile LiveChannel (streaming card) or the persistent Outbox (final +
// DONE reaction).
//
// Harness-agnostic: receives normalized DSH events through an injected
// subscribe function so this module stays unit-testable without DSH.

import type {
  GoalSnapshotState,
  Route,
  RouteRef,
  TodoItemState,
  TokenTotals,
  TokenUsageSnapshot,
} from "../common/types.ts";
import { EMPTY_TOKEN_TOTALS, accumulateTokens } from "../common/token-usage.ts";
import type { Outbox } from "./outbox.ts";
import type { CardKitStreamHandle } from "./cardkit-stream.ts";
import type { TaskCardSyncer } from "./task-card-syncer.ts";

/** A normalized slice of the DSH session event surface we care about. */
export type BridgeSessionEvent =
  | { type: "turn/start" }
  | { type: "assistant/reasoning"; text: string }
  | { type: "assistant/chunk"; text: string }
  | {
      type: "assistant/message";
      text: string;
      reasoning?: string;
      hasToolCalls?: boolean;
      /** Real accounting for this step (absent when the adapter reported none). */
      usage?: TokenUsageSnapshot;
    }
  | { type: "turn/end"; reason: string; finalText?: string; error?: { message: string; code?: string } }
  | { type: "tool/call"; name: string; callId?: string; arguments?: string }
  | { type: "tool/result"; name: string; callId?: string; output?: string; error?: { name?: string; code?: string; message?: string } }
  | { type: "todo/write"; todos: TodoItemState[] }
  | { type: "goal/change"; goal: GoalSnapshotState };

export interface StreamTarget {
  route: RouteRef;
  /** Create (or reuse) a streaming card handle for this turn. */
  ensureStream(): CardKitStreamHandle | undefined;
  /** Send a plain-text reply through the outbox (no card). */
  fallbackText(text: string): Promise<void>;
  /** Mark the turn complete (DONE reaction on the trigger message). */
  markDone(messageId?: string): Promise<void>;
  /** Mark the turn failed (ERROR reaction on the trigger message). */
  markError(messageId?: string): Promise<void>;
}

export interface ForwarderConfig {
  streamingEnabled: boolean;
}

export interface EventForwarderDeps {
  outbox: Outbox;
  /** Live task and goal board card syncer (optional). */
  taskCardSyncer?: TaskCardSyncer;
  /** Map a session event to the Feishu route it belongs to. */
  routeFor(sessionKey: string): Route | undefined;
  /** Live streaming target per session (volatile). */
  streamFor(sessionKey: string): StreamTarget | undefined;
  /** Config getter — read per event (hot-reload friendly). */
  cfg: () => ForwarderConfig;
  /**
   * Diagnostic hook. A missing route used to be a silent drop: a task key that
   * the host failed to map back to its conversation produced NO reply and NO
   * log line, which is exactly how "the bot ignored me" bugs hide.
   */
  warn?: (message: string) => void;
  /**
   * Called when a session's durable (per-turn) output is enqueued into the
   * outbox. Lets the inbound WAL mark the triggering user request delivered —
   * the durable output IS the proof the turn completed, so that request won't
   * be re-triggered after a crash. Best-effort; failures are swallowed.
   */
  onDelivered?(sessionKey: string): string | undefined;
}


export interface EventForwarder {
  /** Feed one normalized DSH session event for a session key. */
  onSessionEvent(sessionKey: string, event: BridgeSessionEvent): Promise<void>;
  /** Finalize any in-flight streaming cards for a session. */
  finalizeSession(sessionKey: string): Promise<void>;
  /**
   * What a session is doing RIGHT NOW — used when the user switches to a task:
   * the briefing must include the answer that is still being written, and a
   * running task must keep streaming into its own card.
   */
  snapshot(sessionKey: string): {
    /** Text delivered so far in the current turn (streamed or settled). */
    text: string;
    /** Forwarder stage (thinking / answering / tool / ended / …). */
    stage: string;
    /** The session has a live streaming card right now. */
    streaming: boolean;
    /** The session's current turn has settled. */
    settled: boolean;
  } | undefined;
}

interface SessionState {
  stream?: CardKitStreamHandle;
  acc: string;
  lastFlushAt: number;
  /** True once any non-empty assistant text has been delivered this turn. */
  hasOutput: boolean;
  /** True once markDone has been issued (avoid duplicates). */
  doneIssued: boolean;
  /** True once markError has been issued (avoid duplicates). */
  errorIssued: boolean;
  stage: string;
  finalText: string;
  delivered: boolean;
  toolNames: Map<string, string>;
  reasoningRounds: number;
  reasoningInStep: boolean;
  /** Exact Feishu message consumed by this FIFO agent turn. */
  triggerMessageId?: string;
  /**
   * Token accounting accumulated from `assistant/message.usage`. TWO scopes are
   * tracked because the card shows both: the turn's own total (what this reply
   * cost) and the session's running total (what the context has grown to — the
   * number DSH's own WebUI footer shows). `turnTokens` resets on turn/start;
   * `sessionTokens` lives as long as this session's forwarding state, so /new
   * or a rotated agent starts from zero, exactly like a fresh DSH session.
   */
  turnTokens: TokenTotals;
  sessionTokens: TokenTotals;
}

function truncate(value: string, limit = 900): string {
  const text = String(value || "").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断 ${text.length - limit} 字符）`;
}

function safeToolArguments(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const scrub = (value: unknown, key = ""): unknown => {
      if (/secret|token|password|authorization|cookie|api[_-]?key/i.test(key)) return "[已脱敏]";
      if (typeof value === "string") return value.length > 700 ? `${value.slice(0, 700)}…` : value;
      if (Array.isArray(value)) return value.slice(0, 12).map((item) => scrub(item));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v, k)]));
      return value;
    };
    return truncate(JSON.stringify(scrub(JSON.parse(raw)), null, 2));
  } catch {
    return truncate(raw);
  }
}

function fencedDetail(value: string, language = "text"): string {
  const safe = truncate(value).replace(/```/g, "｀｀｀");
  return safe ? "\n```" + language + "\n" + safe + "\n```" : "";
}

export function createEventForwarder(deps: EventForwarderDeps): EventForwarder {
  const state = new Map<string, SessionState>();
  const queues = new Map<string, Promise<void>>();

  const emptyState = (): SessionState => ({
    acc: "",
    lastFlushAt: Date.now(),
    hasOutput: false,
    doneIssued: false,
    errorIssued: false,
    stage: "",
    finalText: "",
    delivered: false,
    toolNames: new Map(),
    reasoningRounds: 0,
    reasoningInStep: false,
    turnTokens: EMPTY_TOKEN_TOTALS,
    sessionTokens: EMPTY_TOKEN_TOTALS,
  });

  /**
   * Re-render the header with the current token totals. Called whenever a step
   * reported real usage, and right after a card is (re)created mid-turn so a
   * fresh card never loses the session total. No-op without a live card.
   */
  async function pushTokens(st: SessionState): Promise<void> {
    if (!st.stream || st.stream.disposed) return;
    await st.stream.usage({ turn: st.turnTokens, session: st.sessionTokens });
  }

  const routeRefFor = (route: Route): RouteRef => ({
    sessionKey: route.sessionKey,
    chatId: route.chatId,
    chatType: route.chatType,
    threadMessageId: route.threadMessageId,
  });

  async function handleSessionEvent(sessionKey: string, event: BridgeSessionEvent): Promise<void> {
    const route = deps.routeFor(sessionKey);
    if (!route) {
      // Nothing to forward — but never quietly: a task key without a route means
      // the host failed to map task → conversation (see routeForTaskKey).
      deps.warn?.(
        String(sessionKey).includes("#")
          ? `no Feishu route for task ${sessionKey} — task→conversation routing is broken, output was dropped`
          : `no Feishu route for ${sessionKey}`,
      );
      return;
    }

    const st = state.get(sessionKey) ?? emptyState();
    state.set(sessionKey, st);

    switch (event.type) {
      case "turn/start":
        // New turn: reset per-turn delivery state. doneIssued/hasOutput/acc
        // must not leak across turns — otherwise only the FIRST turn of a
        // session ever gets its DONE reaction (pi lesson: 每轮都要打 DONE).
        st.hasOutput = false;
        st.doneIssued = false;
        st.errorIssued = false;
        st.acc = "";
        st.finalText = "";
        st.delivered = false;
        st.toolNames.clear();
        st.reasoningRounds = 0;
        st.reasoningInStep = false;
        st.triggerMessageId = undefined;
        st.stream = undefined;
        st.stage = "thinking";
        // A new turn starts a NEW turn total; the session total deliberately
        // survives (it mirrors DSH's own session-scoped footer number).
        st.turnTokens = EMPTY_TOKEN_TOTALS;
        if (deps.cfg().streamingEnabled) {
          const stream = deps.streamFor(sessionKey)?.ensureStream();
          if (stream && !stream.disposed) {
            st.stream = stream;
            // The header names the ACTUAL phase — thinking, generating and tool
            // execution are three different things.
            await stream.status("🧠 **思考中**", { phase: "thinking" });
            await pushTokens(st);
          }
        }
        break;
      case "assistant/chunk": {
        // Streaming is volatile preview only (ADR-8); the durable per-turn
        // delivery happens on assistant/message. When an app explicitly
        // disables streaming, chunks are ignored entirely.
        const { streamingEnabled } = deps.cfg();
        if (!streamingEnabled) return;
        st.acc += event.text;
        if (!st.stream || st.stream.disposed) {
          const stream = deps.streamFor(sessionKey)?.ensureStream();
          if (stream && !stream.disposed) st.stream = stream;
        }
        if (st.stream && !st.stream.disposed) {
          if (st.stage !== "answering") {
            st.stage = "answering";
            await st.stream.status("✍️ **生成中**", { phase: "generating" });
          }
          await st.stream.patch(event.text);
        }
        break;
      }

      case "assistant/message": {
        // Accounting arrives WITH the step's message, so fold it FIRST — before
        // any early return below (a tool-requesting step reports usage too, and
        // dropping it there would under-count every multi-step turn).
        if (event.usage) {
          st.turnTokens = accumulateTokens(st.turnTokens, event.usage);
          st.sessionTokens = accumulateTokens(st.sessionTokens, event.usage);
          await pushTokens(st);
        }
        const text = st.acc.length > event.text.length ? st.acc : event.text;
        st.acc = "";
        if (event.reasoning && st.stream && !st.stream.disposed && !st.reasoningInStep) {
          st.reasoningRounds += 1;
          await st.stream.reasoning(event.reasoning);
        }
        st.reasoningInStep = false;
        // A tool-use step also emits assistant/message. It is an intermediate
        // model step, not the end of the Agent turn: keep the card alive and
        // wait for tool/call → tool/result → the next model step.
        if (event.hasToolCalls) {
          if (st.stream && !st.stream.disposed) {
            // Some models narrate the next action before emitting tool calls.
            // Keep that ordinary assistant text in its real timeline position
            // instead of dropping it or moving it to the final answer bucket.
            if (text.trim()) await st.stream.patch(text, true);
            st.stage = "thought";
            // The step ended by requesting tools: the model will think again as
            // soon as the results land.
            await st.stream.status("🧠 **思考中**", { phase: "thinking" });
          }
          return;
        }
        if (!text || text.trim() === "" || text === "No response.") return;
        st.hasOutput = true;
        st.finalText = text;
        if (deps.cfg().streamingEnabled && st.stream && !st.stream.disposed) {
          st.stage = "output-success";
          await st.stream.patch(text, true);
          await st.stream.status("✍️ **生成中**", { phase: "generating" });
          return;
        }
        await deps.outbox.enqueue({
          dedupeKey: `${sessionKey}:assistant:${text.length}:${Date.now()}`,
          laneKey: sessionKey,
          route: routeRefFor(route),
          kind: "assistant-output",
          payload: { kind: "text", text },
        });
        st.delivered = true;
        st.triggerMessageId = deps.onDelivered?.(sessionKey);
        break;
      }
      case "turn/end": {
        st.acc = "";
        const rescue = String(event.finalText ?? "").trim();
        const final = st.finalText || (rescue !== "No response." ? rescue : "");
        if (final) st.hasOutput = true;
        if (st.hasOutput && !st.delivered) {
          if (st.stream && !st.stream.disposed) {
            try {
              st.stage = "ended";
              await st.stream.patch(final, true);
              await st.stream.status("✅ **对话结束**", { phase: "done" });
              await st.stream.finalize(final);
              st.stream = undefined;
              st.delivered = true;
              st.triggerMessageId = deps.onDelivered?.(sessionKey);
            } catch {
              st.stream = undefined;
            }
          }
          if (!st.delivered) {
            try {
              await deps.outbox.enqueue({
                dedupeKey: `${sessionKey}:final:${final.length}:${Date.now()}`,
                laneKey: sessionKey,
                route: routeRefFor(route),
                kind: "assistant-output",
                payload: { kind: "text", text: final },
              });
              st.delivered = true;
              st.triggerMessageId = deps.onDelivered?.(sessionKey);
            } catch {
              // Boot replay remains available when durable delivery fails.
            }
          }
        }
        const failed = ["rejected", "failed", "error"].includes(event.reason);
        if (!st.hasOutput) {
          const detail = event.error?.message?.trim();
          const status = failed
            ? `❌ **对话异常结束**${detail ? `\n\n\`${detail.slice(0, 300)}\`` : ""}`
            : "⚪ **对话结束（无输出）**";
          const target = deps.streamFor(sessionKey);
          if (st.stream && !st.stream.disposed) {
            try {
              st.stage = failed ? "failed" : "empty";
              await st.stream.status(status, { phase: "done" });
              await st.stream.finalize("");
            } catch {
              await target?.fallbackText(status);
            }
          } else if (deps.cfg().streamingEnabled) {
            await target?.fallbackText(status);
          }
          st.stream = undefined;
        }
        const target = deps.streamFor(sessionKey);
        // State-mapped receipt: ERROR on failure, DONE on completion — a
        // delivered-then-failed turn must not be celebrated with DONE.
        if (failed) {
          if (!st.errorIssued) {
            st.errorIssued = true;
            await target?.markError(st.triggerMessageId);
          }
        } else if (target && st.delivered && !st.doneIssued) {
          st.doneIssued = true;
          await target.markDone(st.triggerMessageId);
        }
        break;
      }
      case "tool/call": {
        if (!deps.cfg().streamingEnabled) break;
        if (!st.stream || st.stream.disposed) st.stream = deps.streamFor(sessionKey)?.ensureStream();
        if (st.stream && !st.stream.disposed) {
          if (event.callId) st.toolNames.set(event.callId, event.name);
          st.stage = "tool";
          // The argument block is model OUTPUT too. It feeds the ESTIMATE only —
          // the header prefers real accounting and just falls back to the
          // estimate for adapters that report none.
          if (event.arguments) st.stream.countGenerated(event.arguments);
          const args = safeToolArguments(event.arguments);
          await st.stream.tool(
            `▶️ 调用 \`${event.name || "unknown"}\`${args ? fencedDetail(args, "json") : ""}`,
            { phase: "call", callId: event.callId, title: event.name || "unknown" },
          );
          await st.stream.status("🛠️ **工具执行中**", { phase: "tool" });
        }
        break;
      }

      case "assistant/reasoning": {
        if (!deps.cfg().streamingEnabled) return;
        if (!st.stream || st.stream.disposed) st.stream = deps.streamFor(sessionKey)?.ensureStream();
        if (st.stream && !st.stream.disposed) {
          st.stage = "thinking";
          await st.stream.status("🧠 **思考中**", { phase: "thinking" });
          if (!st.reasoningInStep) {
            st.reasoningRounds += 1;
            st.reasoningInStep = true;
            await st.stream.reasoning(event.text);
          } else {
            await st.stream.reasoning(event.text);
          }
        }
        break;
      }
      case "tool/result": {
        if (!deps.cfg().streamingEnabled) break;
        if (!st.stream || st.stream.disposed) st.stream = deps.streamFor(sessionKey)?.ensureStream();
        if (st.stream && !st.stream.disposed) {
          const toolName = event.callId && st.toolNames.get(event.callId)
            || (event.name === "tool-result" ? "unknown" : event.name)
            || "unknown";
          if (event.callId) st.toolNames.delete(event.callId);
          st.stage = event.error ? "tool-error" : "thinking";
          const resultDetail = event.error?.message || event.output || "";
          await st.stream.tool(
            event.error
              ? `❌ \`${toolName}\` 失败${event.error.code ? ` · \`${event.error.code}\`` : ""}${resultDetail ? fencedDetail(resultDetail) : ""}`
              : `✅ \`${toolName}\` 成功${resultDetail ? fencedDetail(resultDetail) : ""}`,
            { phase: "result", callId: event.callId, title: toolName },
          );
          // A finished tool round returns control to the model: it is thinking
          // again (success/failure detail stays inside the folded panel).
          await st.stream.status("🧠 **思考中**", { phase: "thinking" });
        }
        break;
      }
      case "todo/write":
      case "goal/change":
        // Internal DSH state updates (not sent as Feishu task cards).
        break;
    }
  }

  function onSessionEvent(sessionKey: string, event: BridgeSessionEvent): Promise<void> {
    const next = (queues.get(sessionKey) ?? Promise.resolve()).then(
      () => handleSessionEvent(sessionKey, event),
      () => handleSessionEvent(sessionKey, event),
    );
    queues.set(sessionKey, next.catch(() => undefined));
    return next;
  }

  async function finalizeSession(sessionKey: string): Promise<void> {
    await queues.get(sessionKey)?.catch(() => undefined);
    const st = state.get(sessionKey);
    if (!st) return;
    if (st.acc.length > 0 && st.hasOutput === false) {
      // Streaming-only accumulated text never settled by a message_end.
      const route = deps.routeFor(sessionKey);
      if (route) {
        await deps.outbox.enqueue({
          dedupeKey: `${sessionKey}:finalize:${Date.now()}`,
          laneKey: sessionKey,
          route: routeRefFor(route),
          kind: "assistant-output",
          payload: { kind: "text", text: st.acc },
        });
      }
    }
    if (st.stream) {
      try {
        await st.stream.finalize("");
      } catch {
        // ignore
      }
      st.stream = undefined;
    }
    state.delete(sessionKey);
    queues.delete(sessionKey);
  }

  return {
    onSessionEvent,
    finalizeSession,
    snapshot(sessionKey) {
      const st = state.get(sessionKey);
      if (!st) return undefined;
      return {
        text: st.finalText || st.acc,
        stage: st.stage,
        streaming: Boolean(st.stream && !st.stream.disposed),
        settled: ["ended", "failed", "empty"].includes(st.stage),
      };
    },
  };
}

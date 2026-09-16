// EventForwarder: the bridge's outbound "assistant → Feishu" pipeline.
// Consumes DSH session events (assistant/chunk for streaming, assistant/message
// for the durable final, turn/end for completion) and pushes them either into
// the volatile LiveChannel (streaming card) or the persistent Outbox (final +
// DONE reaction).
//
// Harness-agnostic: receives normalized DSH events through an injected
// subscribe function so this module stays unit-testable without DSH.

import type { GoalSnapshotState, Route, RouteRef, TodoItemState } from "../common/types.ts";
import type { Outbox } from "./outbox.ts";
import type { CardKitStreamHandle } from "./cardkit-stream.ts";
import type { TaskCardSyncer } from "./task-card-syncer.ts";

/** A normalized slice of the DSH session event surface we care about. */
export type BridgeSessionEvent =
  | { type: "turn/start" }
  | { type: "assistant/reasoning"; text: string }
  | { type: "assistant/chunk"; text: string }
  | { type: "assistant/message"; text: string; reasoning?: string; hasToolCalls?: boolean }
  | { type: "turn/end"; reason: string; finalText?: string; error?: { message: string; code?: string } }
  | { type: "tool/call"; name: string; callId?: string }
  | { type: "tool/result"; name: string; callId?: string; error?: { name: string; code: string } }
  | { type: "todo/write"; todos: TodoItemState[] }
  | { type: "goal/change"; goal: GoalSnapshotState };

export interface StreamTarget {
  route: RouteRef;
  /** Create (or reuse) a streaming card handle for this turn. */
  ensureStream(): CardKitStreamHandle | undefined;
  /** Send a plain-text reply through the outbox (no card). */
  fallbackText(text: string): Promise<void>;
  /** Mark the turn complete (DONE reaction on the trigger message). */
  markDone(): Promise<void>;
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
   * Called when a session's durable (per-turn) output is enqueued into the
   * outbox. Lets the inbound WAL mark the triggering user request delivered —
   * the durable output IS the proof the turn completed, so that request won't
   * be re-triggered after a crash. Best-effort; failures are swallowed.
   */
  onDelivered?(sessionKey: string): void;
}


export interface EventForwarder {
  /** Feed one normalized DSH session event for a session key. */
  onSessionEvent(sessionKey: string, event: BridgeSessionEvent): Promise<void>;
  /** Finalize any in-flight streaming cards for a session. */
  finalizeSession(sessionKey: string): Promise<void>;
}

interface SessionState {
  stream?: CardKitStreamHandle;
  acc: string;
  lastFlushAt: number;
  /** True once any non-empty assistant text has been delivered this turn. */
  hasOutput: boolean;
  /** True once markDone has been issued (avoid duplicates). */
  doneIssued: boolean;
  stage: string;
  finalText: string;
  delivered: boolean;
  toolNames: Map<string, string>;
}

export function createEventForwarder(deps: EventForwarderDeps): EventForwarder {
  const state = new Map<string, SessionState>();
  const queues = new Map<string, Promise<void>>();

  const emptyState = (): SessionState => ({
    acc: "",
    lastFlushAt: Date.now(),
    hasOutput: false,
    doneIssued: false,
    stage: "",
    finalText: "",
    delivered: false,
    toolNames: new Map(),
  });

  const routeRefFor = (route: Route): RouteRef => ({
    sessionKey: route.sessionKey,
    chatId: route.chatId,
    chatType: route.chatType,
    threadMessageId: route.threadMessageId,
  });

  async function handleSessionEvent(sessionKey: string, event: BridgeSessionEvent): Promise<void> {
    const route = deps.routeFor(sessionKey);
    if (!route) return; // no Feishu route for this session — nothing to forward

    const st = state.get(sessionKey) ?? emptyState();
    state.set(sessionKey, st);

    switch (event.type) {
      case "turn/start":
        // New turn: reset per-turn delivery state. doneIssued/hasOutput/acc
        // must not leak across turns — otherwise only the FIRST turn of a
        // session ever gets its DONE reaction (pi lesson: 每轮都要打 DONE).
        st.hasOutput = false;
        st.doneIssued = false;
        st.acc = "";
        st.finalText = "";
        st.delivered = false;
        st.toolNames.clear();
        st.stream = undefined;
        st.stage = "thinking";
        if (deps.cfg().streamingEnabled) {
          const stream = deps.streamFor(sessionKey)?.ensureStream();
          if (stream && !stream.disposed) {
            st.stream = stream;
            await stream.status("🧠 **思考中…**");
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
            await st.stream.status("✍️ **正在生成回复…**");
          }
          await st.stream.patch(event.text);
        }
        break;
      }

      case "assistant/message": {
        const text = st.acc.length > event.text.length ? st.acc : event.text;
        st.acc = "";
        if (event.reasoning && st.stream && !st.stream.disposed) {
          await st.stream.reasoning(event.reasoning, true);
        }
        // A tool-use step also emits assistant/message. It is an intermediate
        // model step, not the end of the Agent turn: keep the card alive and
        // wait for tool/call → tool/result → the next model step.
        if (event.hasToolCalls) {
          if (st.stream && !st.stream.disposed) {
            st.stage = "thought";
            await st.stream.status("✅ **思考成功**");
          }
          return;
        }
        if (!text || text.trim() === "" || text === "No response.") return;
        st.hasOutput = true;
        st.finalText = text;
        if (deps.cfg().streamingEnabled && st.stream && !st.stream.disposed) {
          st.stage = "output-success";
          await st.stream.patch(text, true);
          await st.stream.status("✅ **输出成功**");
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
        deps.onDelivered?.(sessionKey);
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
              await st.stream.status("✅ **会话结束**");
              await st.stream.finalize(final);
              st.stream = undefined;
              st.delivered = true;
              deps.onDelivered?.(sessionKey);
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
              deps.onDelivered?.(sessionKey);
            } catch {
              // Boot replay remains available when durable delivery fails.
            }
          }
        }
        if (!st.hasOutput) {
          const failed = ["rejected", "failed", "error"].includes(event.reason);
          const detail = event.error?.message?.trim();
          const status = failed
            ? `❌ **会话异常结束，未产出回复**${detail ? `\n\n\`${detail.slice(0, 300)}\`` : ""}`
            : "⚪ **会话结束，但没有文本输出**";
          const target = deps.streamFor(sessionKey);
          if (st.stream && !st.stream.disposed) {
            try {
              st.stage = failed ? "failed" : "empty";
              await st.stream.status(status);
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
        if (target && st.delivered && !st.doneIssued) {
          st.doneIssued = true;
          await target.markDone();
        }
        break;
      }
      case "tool/call": {
        if (!deps.cfg().streamingEnabled) break;
        if (!st.stream || st.stream.disposed) st.stream = deps.streamFor(sessionKey)?.ensureStream();
        if (st.stream && !st.stream.disposed) {
          if (event.callId) st.toolNames.set(event.callId, event.name);
          st.stage = "tool";
          await st.stream.tool(`▶️ 调用 \`${event.name || "unknown"}\``);
          await st.stream.status(`🛠️ **正在调用工具** · \`${event.name || "unknown"}\``);
        }
        break;
      }

      case "assistant/reasoning": {
        if (!deps.cfg().streamingEnabled) return;
        if (!st.stream || st.stream.disposed) st.stream = deps.streamFor(sessionKey)?.ensureStream();
        if (st.stream && !st.stream.disposed) {
          st.stage = "thinking";
          await st.stream.status("🧠 **思考中**");
          await st.stream.reasoning(event.text);
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
          await st.stream.tool(event.error
            ? `❌ \`${toolName}\` 失败${event.error.code ? ` · \`${event.error.code}\`` : ""}`
            : `✅ \`${toolName}\` 成功`);
          await st.stream.status(event.error
            ? `⚠️ **工具调用失败** · \`${toolName}\``
            : `✅ **工具调用成功** · \`${toolName}\``);
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

  return { onSessionEvent, finalizeSession };
}

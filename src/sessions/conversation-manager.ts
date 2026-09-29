// ConversationManager: per-conversation TASK orchestration (ADR-5).
//
// A Feishu conversation used to own exactly one DSH agent, so a second request
// had to wait and "/new" threw the previous conversation away. It now owns an
// ordered set of TASKS (task-registry.ts): each task is its own agent + session
// with its own FIFO queue and its own event fan-out, one task is ACTIVE (what an
// ordinary message reaches), and the rest keep running untouched.
//
// The routing key everything downstream speaks (outbound forwarder, streaming
// cards, watchdog) is the TASK id in registry mode:
//   dm:oc_x#3
// and the CONVERSATION key when no registry was configured (single-task
// behaviour — the pre-parallel semantics, used by tests and minimal embedders).
//
// Harness-agnostic (depends on DshSessionBackend + TaskRegistry only).

import type {
	DshSessionBackend,
	AgentHandle,
	SessionEventOut,
	AttachmentInput,
} from "./dsh-session-backend.ts";
import type { FeishuInboundMessage } from "../common/types.ts";
import { stripLeadingMentions } from "../application/command-router.ts";
import {
	conversationKeyOf,
	createMemoryTaskRegistry,
	type TaskRecord,
	type TaskRegistry,
} from "./task-registry.ts";

/** What a conversation can see about one of its tasks. */
export type TaskStatus = "running" | "idle" | "stopped";

export interface ConversationManagerDeps {
	backend: DshSessionBackend;
	/**
	 * Task bookkeeping (parallel tasks + active pointer + owner identity).
	 * Omitted → an in-memory registry with ONE task per conversation, whose
	 * routing key IS the conversation key: single-task behaviour, byte-for-byte
	 * the pre-parallel semantics (used by tests and minimal embedders).
	 */
	registry?: TaskRegistry;
	/** Max concurrently hosted agents; idle ones are evicted beyond the cap. */
	maxSessions: number;
	idleTtlMs: number;
	/** Bridge fan-out: every session event, keyed by ROUTING key. */
	onEvent?: (routingKey: string, event: SessionEventOut) => void;
	/** The session a conversation now shows as "current" (display/diagnostics). */
	onActiveSessionId?: (conversationKey: string, sessionId: string | undefined) => void;
	logger?: { info(msg: string): void; warn(msg: string): void };
	now?: () => number;
}

export interface ConversationManager {
	/** Handle an inbound Feishu message: enqueue into the ACTIVE task's FIFO. */
	handleMessage(
		msg: FeishuInboundMessage,
		attachments?: AttachmentInput[],
	): Promise<void>;
	/** Key for a message (dm:* for p2p, group:* for group chats). */
	keyFor(msg: FeishuInboundMessage): string;
	/** Tasks of one conversation, newest first. */
	tasks(key: string): TaskRecord[];
	activeTask(key: string): TaskRecord | undefined;
	ownerOf(key: string): { id?: string; name?: string };
	/** running = mid-turn, idle = hosted but waiting, stopped = not hosted. */
	statusOf(routingKey: string): TaskStatus;
	/** Live handle of one task (undefined when it is not hosted). */
	agentFor(routingKey: string): AgentHandle | undefined;
	/** /new — open a NEW task; the previous one keeps running. */
	createTask(key: string, opts?: { label?: string }): TaskRecord;
	/** Make one task the message target and bring it back to life. */
	switchTask(
		key: string,
		taskId: string,
	): Promise<{ task: TaskRecord; agent?: AgentHandle; running: boolean }>;
	/** Stop ONE task's current turn (default: the active task). */
	stopTask(key: string, taskId?: string): Promise<void>;
	/** Bind a HISTORICAL session to a task and make it current (/tasks 切换). */
	resumeTask(
		key: string,
		sessionId: string,
		opts?: { preset?: string; label?: string },
	): Promise<{ task: TaskRecord; agent: AgentHandle }>;
	/** Legacy /resume surface: returns the resumed agent (see resumeTask). */
	resume(
		key: string,
		sessionId: string,
		opts?: { preset?: string },
	): Promise<AgentHandle>;
	/** Forget a task (its DSH session is managed by /manage). */
	dropTask(key: string, taskId: string): Promise<void>;
	/** Cancel the active task's turn (does not touch other tasks). */
	stop(key: string): Promise<void>;
	/** Dispose every task of one conversation (next message rebuilds under new config). */
	dispose(key: string): Promise<void>;
	/** Bump the conversation onto a fresh task (kept for /new compatibility). */
	rotate(key: string): Promise<void>;
	/** Reap idle agents; returns disposed count. */
	sweep(): number;
	size(): number;
	keys(): string[];
	taskIds(): string[];
	disposeAll(): Promise<void>;
}

/** The id whose workspace a conversation is isolated under. */
export function ownerIdForMessage(msg: FeishuInboundMessage): string {
	return msg.chatType === "p2p" ? msg.senderOpenId : msg.chatId;
}

export function createConversationManager(
	deps: ConversationManagerDeps,
): ConversationManager {
	const registry = deps.registry ?? createMemoryTaskRegistry(deps.now);
	/**
	 * Routing key of a task: the task id in registry mode, the CONVERSATION key
	 * in the legacy single-task mode — so every downstream store keyed by a
	 * conversation (outbox lanes, routes, WAL) keeps seeing the same string.
	 */
	const routeKey = (task: TaskRecord): string =>
		deps.registry ? task.id : conversationKeyOf(task.id);
	const queues = new Map<string, Promise<unknown>>(); // routing key -> serial chain
	const hooks = new Map<string, () => void>(); // routing key -> detach
	const hooksAgent = new Map<string, string>(); // routing key -> agentId

	const keyFor = (msg: FeishuInboundMessage): string =>
		msg.chatType === "p2p" ? `dm:${msg.chatId}` : `group:${msg.chatId}`;

	const enqueueSerial = <T>(routingKey: string, task: () => Promise<T>): Promise<T> => {
		const prev = queues.get(routingKey) ?? Promise.resolve();
		const next = prev.then(task, task); // run regardless of the prior outcome
		queues.set(
			routingKey,
			next.catch(() => undefined),
		);
		return next;
	};

	const ensureUnderCap = async (): Promise<void> => {
		if (deps.backend.size() < deps.maxSessions) return;
		deps.backend.disposeIdle(0); // dispose all idle first
		if (deps.backend.size() >= deps.maxSessions) {
			// Everything busy: brief wait for a slot, then dispose idle again.
			await new Promise((r) => setTimeout(r, 250));
			deps.backend.disposeIdle(0);
		}
	};

	const attachHook = (routingKey: string, agent: AgentHandle): void => {
		const prevAgentId = hooksAgent.get(routingKey);
		if (hooks.has(routingKey) && prevAgentId === agent.agentId) return;
		hooks.get(routingKey)?.();
		const detach = agent.onEvent((e) => deps.onEvent?.(routingKey, e));
		hooks.set(routingKey, detach);
		hooksAgent.set(routingKey, agent.agentId);
	};

	const dropHook = (routingKey: string): void => {
		hooks.get(routingKey)?.();
		hooks.delete(routingKey);
		hooksAgent.delete(routingKey);
	};

	/** Get-or-create the agent of one task and subscribe its fan-out. */
	const ensureTaskAgent = async (key: string, task: TaskRecord): Promise<AgentHandle> => {
		await ensureUnderCap();
		const routingKey = routeKey(task);
		const agent = await deps.backend.ensureAgent(routingKey);
		registry.setSessionId(key, task.id, agent.sessionId);
		attachHook(routingKey, agent);
		deps.onActiveSessionId?.(key, agent.sessionId);
		return agent;
	};

	/** Bring a task's PERSISTED session back to life (its log continues). */
	const resumeTaskAgent = async (
		key: string,
		task: TaskRecord,
		opts?: { preset?: string },
	): Promise<AgentHandle> => {
		const routingKey = routeKey(task);
		if (!task.sessionId) return ensureTaskAgent(key, task);
		const live = deps.backend.get(routingKey);
		if (live && live.sessionId === task.sessionId) {
			attachHook(routingKey, live);
			return live;
		}
		await ensureUnderCap();
		const agent = await deps.backend.resumeAgent(routingKey, task.sessionId, opts);
		registry.setSessionId(key, task.id, agent.sessionId);
		attachHook(routingKey, agent);
		deps.onActiveSessionId?.(key, agent.sessionId);
		return agent;
	};

	const findTask = (taskId: string): TaskRecord | undefined =>
		registry
			.list(conversationKeyOf(taskId))
			.find((task) => task.id === taskId);

	const stopTaskById = async (taskId?: string): Promise<void> => {
		if (!taskId) return;
		const task = findTask(taskId);
		const agent = deps.backend.get(task ? routeKey(task) : taskId);
		if (agent) await agent.cancel();
	};

	const manager: ConversationManager = {
		keyFor,
		async handleMessage(msg, attachments) {
			const key = keyFor(msg);
			// Owner identity is recorded here (not at task creation) so the
			// isolation hash has the real open_id from the very first message.
			registry.setOwner(key, ownerIdForMessage(msg), msg.senderName);
			const rawText = msg.text ?? msg.content ?? "";
			const text = stripLeadingMentions(rawText) || rawText;
			// Resolve the ACTIVE task now: /tasks may switch it while this
			// message waits in the queue of an older task.
			const task = registry.ensureActive(key);
			registry.touch(key, task.id);
			await enqueueSerial(routeKey(task), async () => {
				try {
					// Resolve the agent INSIDE the FIFO task: a preceding failed
					// turn may have auto-rotated while later messages were queued.
					const agent = await ensureTaskAgent(key, task);
					await agent.followup(text, attachments);
				} catch (err) {
					deps.logger?.warn(`followup failed for ${task.id}: ${String(err)}`);
				}
			});
		},
		tasks: (key) => registry.list(key),
		activeTask: (key) => registry.active(key),
		ownerOf: (key) => registry.owner(key),
		statusOf(routingKey) {
			const agent = deps.backend.get(routingKey);
			if (!agent) return "stopped";
			return agent.isIdle() ? "idle" : "running";
		},
		agentFor: (routingKey) => deps.backend.get(routingKey),
		createTask(key, opts) {
			const previous = registry.active(key);
			const task = registry.create(key, {
				...(opts?.label ? { label: opts.label } : {}),
				...(previous ? { fromTaskId: previous.id } : {}),
			});
			deps.onActiveSessionId?.(key, undefined);
			return task;
		},
		async switchTask(key, taskId) {
			const task = registry.switchTo(key, taskId);
			if (!task) throw new Error(`未知任务: ${taskId}`);
			let agent: AgentHandle | undefined;
			try {
				agent = task.sessionId
					? await resumeTaskAgent(key, task)
					: await ensureTaskAgent(key, task);
			} catch (err) {
				deps.logger?.warn(`switchTask ${taskId} failed: ${String(err)}`);
			}
			return {
				task: registry.active(key) ?? task,
				...(agent ? { agent } : {}),
				running: agent ? !agent.isIdle() : false,
			};
		},
		async stopTask(key, taskId) {
			await stopTaskById(taskId ?? registry.active(key)?.id);
		},
		async resumeTask(key, sessionId, opts) {
			// Reuse the task that already owns this session: two live agents on one
			// log would fight over the same file.
			const existing = registry.list(key).find((task) => task.sessionId === sessionId);
			const previous = registry.active(key);
			const task =
				existing ??
				registry.create(key, {
					...(opts?.label ? { label: opts.label } : {}),
					...(previous ? { fromTaskId: previous.id } : {}),
				});
			registry.switchTo(key, task.id);
			if (!existing) registry.setSessionId(key, task.id, sessionId);
			const active = registry.active(key) ?? task;
			const agent = await resumeTaskAgent(key, active, opts);
			return { task: active, agent };
		},
		async resume(key, sessionId, opts) {
			const { agent } = await manager.resumeTask(key, sessionId, opts);
			return agent;
		},
		async dropTask(key, taskId) {
			const task = findTask(taskId);
			const routingKey = task ? routeKey(task) : taskId;
			dropHook(routingKey);
			queues.delete(routingKey);
			registry.remove(key, taskId);
			await deps.backend.dispose(routingKey);
		},
		async stop(key) {
			await stopTaskById(registry.active(key)?.id);
		},
		async dispose(key) {
			for (const task of registry.list(key)) {
				const routingKey = routeKey(task);
				dropHook(routingKey);
				queues.delete(routingKey);
				await deps.backend.dispose(routingKey);
			}
		},
		async rotate(key) {
			manager.createTask(key);
		},
		sweep() {
			return deps.backend.disposeIdle(deps.idleTtlMs);
		},
		size: () => deps.backend.size(),
		keys: () => registry.conversations(),
		taskIds: () =>
			registry.conversations().flatMap((key) => registry.list(key).map((task) => task.id)),
		async disposeAll() {
			for (const detach of hooks.values()) detach();
			hooks.clear();
			hooksAgent.clear();
			await deps.backend.disposeAll();
			queues.clear();
		},
	};
	return manager;
}

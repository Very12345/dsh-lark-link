// Task registry: many PARALLEL tasks per Feishu conversation.
//
// A conversation used to own exactly one DSH agent, so "/new" meant "throw the
// previous conversation away" and a second request had to wait for the first to
// finish. Each conversation now carries an ordered set of TASKS: a new task is
// just a new agent + session, the conversation has one ACTIVE task (what an
// ordinary message reaches), and the others keep running.
//
// The task id doubles as the bridge's internal routing key:
//   dm:oc_x#3   →   task 3 of conversation dm:oc_x
// .. which is what makes per-task queues, per-task event fan-out and per-task
// streaming cards possible without touching the conversation-level stores
// (dedupe, inbound WAL, quotas).
//
// Persisted as JSON so tasks survive restarts: the session id is recovered from
// the conversation-config override the DSH adapter already maintains per key.

import { readFileSync, writeFileSync } from "node:fs";

export interface TaskRecord {
	/** Routing key — also the sessionKey the backend/forwarder use. */
	id: string;
	/** 1-based ordinal within its conversation (stable, shown to the user). */
	seq: number;
	/** Bridge-side name (/manage rename). */
	label?: string;
	createdAt: number;
	lastActivityAt: number;
	/** DSH session id once the task has produced one. */
	sessionId?: string;
	/** The task this one replaced (/new keeps it for the record). */
	fromTaskId?: string;
}

export interface ConversationTasks {
	/** Owner id (Feishu open_id / chat id) — the isolation hash input. */
	ownerId?: string;
	ownerName?: string;
	activeId?: string;
	tasks: TaskRecord[];
}

export interface TaskRegistry {
	conversationKeyOf(taskId: string): string;
	taskSeqOf(taskId: string): number;
	/** All tasks of one conversation, newest first. */
	list(conversationKey: string): TaskRecord[];
	/** The task an ordinary inbound message reaches (created on first use). */
	active(conversationKey: string): TaskRecord | undefined;
	ensureActive(conversationKey: string): TaskRecord;
	create(conversationKey: string, opts?: { label?: string; fromTaskId?: string }): TaskRecord;
	switchTo(conversationKey: string, taskId: string): TaskRecord | undefined;
	touch(conversationKey: string, taskId: string): void;
	setSessionId(conversationKey: string, taskId: string, sessionId?: string): void;
	setLabel(conversationKey: string, taskId: string, label?: string): void;
	remove(conversationKey: string, taskId: string): void;
	/** Owner identity of a conversation (recorded from its first message). */
	owner(conversationKey: string): { id?: string; name?: string };
	setOwner(conversationKey: string, ownerId?: string, ownerName?: string): void;
	conversations(): string[];
}

/** Strip the `#seq` suffix: the routing key of the conversation that owns it. */
export function conversationKeyOf(taskId: string): string {
	const match = /#(\d+)$/.exec(String(taskId ?? ""));
	return match ? String(taskId).slice(0, match.index) : String(taskId ?? "");
}

/**
 * A bridge session id is `lark-link:<taskKey>:<runNonce>:<index>` — and the
 * taskKey may itself carry `#n` suffixes. Tools receive that id and need the
 * CONVERSATION key for their route lookup, which lives one or two `:` segments
 * earlier. The old inline fallback stripped only ONE trailing `:segment`, which
 * never matched `<nonce>:<index>` (the index is a single digit), so a route
 * lookup could fail with "无法定位当前飞书会话" while the conversation existed —
 * e.g. for a resumed task or a disposed idle agent whose reverse map entry is
 * gone. Accepts ids with or without the `lark-link:` prefix and task keys.
 */
export function conversationKeyForSessionId(sessionId: string): string {
	const raw = String(sessionId ?? "");
	const body = raw.startsWith("lark-link:")
		? raw.slice("lark-link:".length)
		: raw;
	// The bridge's own shape is unambiguous: `<key>:<nonce>:<index>`.
	const withoutIndex = body.replace(/:[a-z0-9]{8,}:\d+$/, "");
	if (withoutIndex !== body) return conversationKeyOf(withoutIndex);
	// Ids without the index (older builds) or a bare task key: peel a nonce-like
	// tail only when what remains still looks like a conversation key, so a chat
	// id (`dm:oc_0683…`) is never mistaken for `<key>:<nonce>`.
	const legacy = /^((?:dm|p2p|group):[^:]+):[a-z0-9]{8,}$/.exec(body);
	if (legacy?.[1]) return conversationKeyOf(legacy[1]);
	return conversationKeyOf(body);
}

/** Ordinal of a task id (`dm:x#2` → 2), or 0 when it carries none. */
export function taskSeqOf(taskId: string): number {
	const match = /#(\d+)$/.exec(String(taskId ?? ""));
	return match ? Number(match[1]) : 0;
}

/**
 * In-memory registry — used by tests and by hosts that never configured one.
 * Tasks still work; only the persistence across restarts is missing.
 */
export function createMemoryTaskRegistry(now: () => number = Date.now): TaskRegistry {
	return createTaskRegistry("", now, true);
}

export function createTaskRegistry(
	file: string,
	now: () => number = Date.now,
	memoryOnly = false,
): TaskRegistry {
	let data: Record<string, ConversationTasks> = {};
	let prunePersist = false;
	if (!memoryOnly) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, ConversationTasks>;
			if (parsed && typeof parsed === "object") data = parsed;
			// A CONVERSATION key never contains `#`. A top-level key that does is a
			// nested group minted by the old failed-turn rotation (rotate() called
			// with a task key): no message can ever route to it, so it lingers as
			// an empty conversation that panels list but nothing can delete. Drop
			// them on load so the junk heals itself after an upgrade.
			for (const key of Object.keys(data)) {
				if (key.includes("#")) {
					delete data[key];
					prunePersist = true;
				}
			}
		} catch {
			// first run — no file yet
		}
	}

	const persist = (): void => {
		if (memoryOnly) return;
		try {
			writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
		} catch {
			// best-effort: a failed write must never break a turn
		}
	};
	// The load-time prune above must reach the FILE too, not just memory: wait
	// for the next mutation and the litter survives restarts indefinitely.
	if (prunePersist) persist();

	const row = (conversationKey: string): ConversationTasks =>
		data[conversationKey] ?? { tasks: [] };

	const save = (conversationKey: string, value: ConversationTasks): void => {
		data[conversationKey] = value;
		persist();
	};

	const create = (
		conversationKey: string,
		opts: { label?: string; fromTaskId?: string } = {},
	): TaskRecord => {
		const current = row(conversationKey);
		const seq = current.tasks.reduce((max, task) => Math.max(max, task.seq), 0) + 1;
		const at = now();
		const task: TaskRecord = {
			id: `${conversationKey}#${seq}`,
			seq,
			createdAt: at,
			lastActivityAt: at,
			...(opts.label ? { label: opts.label } : {}),
			...(opts.fromTaskId ? { fromTaskId: opts.fromTaskId } : {}),
		};
		save(conversationKey, {
			...current,
			activeId: task.id,
			tasks: [...current.tasks, task],
		});
		return task;
	};

	return {
		conversationKeyOf,
		taskSeqOf,
		list: (conversationKey) => [...row(conversationKey).tasks].reverse(),
		active(conversationKey) {
			const current = row(conversationKey);
			return current.activeId
				? current.tasks.find((task) => task.id === current.activeId)
				: undefined;
		},
		ensureActive(conversationKey) {
			return this.active(conversationKey) ?? create(conversationKey);
		},
		create,
		switchTo(conversationKey, taskId) {
			const current = row(conversationKey);
			const target = current.tasks.find((task) => task.id === taskId);
			if (!target) return undefined;
			save(conversationKey, { ...current, activeId: target.id });
			return target;
		},
		touch(conversationKey, taskId) {
			const current = row(conversationKey);
			const tasks = current.tasks.map((task) =>
				task.id === taskId ? { ...task, lastActivityAt: now() } : task,
			);
			save(conversationKey, { ...current, tasks });
		},
		setSessionId(conversationKey, taskId, sessionId) {
			const current = row(conversationKey);
			const tasks = current.tasks.map((task) => {
				if (task.id !== taskId) return task;
				const next = { ...task };
				if (sessionId) next.sessionId = sessionId;
				else delete next.sessionId;
				return next;
			});
			save(conversationKey, { ...current, tasks });
		},
		setLabel(conversationKey, taskId, label) {
			const current = row(conversationKey);
			const tasks = current.tasks.map((task) => {
				if (task.id !== taskId) return task;
				const next = { ...task };
				if (label) next.label = label;
				else delete next.label;
				return next;
			});
			save(conversationKey, { ...current, tasks });
		},
		remove(conversationKey, taskId) {
			const current = row(conversationKey);
			const tasks = current.tasks.filter((task) => task.id !== taskId);
			const activeId =
				current.activeId === taskId
					? tasks.at(-1)?.id
					: current.activeId;
			save(conversationKey, {
				...current,
				tasks,
				...(activeId ? { activeId } : { activeId: undefined }),
			});
		},
		owner: (conversationKey) => {
			const current = row(conversationKey);
			return { id: current.ownerId, name: current.ownerName };
		},
		setOwner(conversationKey, ownerId, ownerName) {
			const current = row(conversationKey);
			if (current.ownerId === ownerId && current.ownerName === ownerName) return;
			save(conversationKey, {
				...current,
				...(ownerId ? { ownerId } : {}),
				...(ownerName ? { ownerName } : {}),
			});
		},
		conversations: () => Object.keys(data),
	};
}

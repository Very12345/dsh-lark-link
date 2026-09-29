// Workspace session listing for the Feishu-side /resume command.
//
// Lists the HISTORICAL DSH sessions of one workspace (cwd) so a Feishu chat can
// pick one up again. Two layered sources (same discipline as doctor's export):
//
//   1. sessionPersistence service (preferred): headers carry createdAt, cwd,
//      agentPreset and origin — exact cwd equality, subagent children excluded.
//   2. filesystem scan (fallback): <DSH_HOME>/sessions/<projectKey(cwd)>/<encoded-id>/
//      session.jsonl.zstd, decoded + mtime-sorted. The projectKey encoding is
//      ported VERBATIM from dsh-session-persistence-jsonl (lossy by design —
//      separators collapse, unsafe code units escape as ~XXXX) so the scan
//      lands in exactly the directory DSH writes.
//
// Harness-agnostic: the service is injected as a narrow structural interface.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Header-like row of the DSH sessionPersistence service (structural slice). */
export interface SessionHeaderLike {
	id: string;
	createdAt: number;
	cwd?: string;
	agentPreset?: string;
	origin?: string;
	title?: string;
}

export interface WorkspaceSessionInfo {
	id: string;
	/** epoch ms — header createdAt (service) or log mtime (scan). */
	createdAt: number;
	/** stored agentPreset — present on the service source only. */
	preset?: string;
	/** Human-readable session title (if available). */
	title?: string;
	/** Compact last-progress preview extracted from persisted messages. */
	summary?: string;
	/** Counts shown in the picker overview. */
	userTurns?: number;
	toolCalls?: number;
	/** Last durable event timestamp, when the log exposes one. */
	lastActivityAt?: number;
	/** Cheap v3 snapshot count, used to read a bounded tail. */
	eventCount?: number;
	source: "service" | "scan";
}

export interface PersistenceListSource {
	/**
	 * DSH <= v2 returned headers directly. DSH v3 returns persistence
	 * snapshots (`{ header, revision }`). Accept both so the bridge can follow
	 * the host independently of its session-format generation.
	 */
	list(
		signal?: AbortSignal,
	): Promise<
		readonly (
			| SessionHeaderLike
			| { readonly header: SessionHeaderLike; readonly revision?: unknown }
		)[]
	>;
	inspect?(id: string, signal?: AbortSignal): Promise<{ meta?: unknown; events?: readonly unknown[] } | undefined>;
	load?(id: string): Promise<{ header?: unknown; events?: readonly unknown[] } | undefined>;
	readFrom?(id: string, fromSeq: number): Promise<{ meta?: unknown; events?: readonly unknown[] } | undefined>;
	open?(
		id: string,
		access: "read",
	): Promise<{
		read(offset?: number, length?: number): Promise<{ events: readonly unknown[] }>;
		close(): Promise<void>;
	}>;
}

/** Resolve the harness home used by stock DSH and the webagent deployment. */
export function resolveDshHome(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	const explicit = env.DSH_HOME?.trim();
	if (explicit) return explicit;
	const webagentHome = env.WEBAGENT_HOME?.trim();
	if (webagentHome) return join(webagentHome, "deepseek-harness");
	return join(home, ".dsh");
}

/** Resolve the session store used by stock DSH and the webagent deployment. */
export function resolveSessionsRoot(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	return join(resolveDshHome(env, home), "sessions");
}


export interface ListWorkspaceSessionsDeps {
	/** DSH sessions root — <DSH_HOME>/sessions. */
	sessionsRoot: string;
	/** the workspace whose sessions to list. */
	cwd: string;
	/** live sessionPersistence service (optional — scan fallback otherwise). */
	persistence?: PersistenceListSource;
	/** Optional title resolver for session ids. */
	titleFor?: (sessionId: string) => string | undefined;
	/** ids to hide (e.g. this conversation's CURRENT session). */
	exclude?: string[];
	/** cap (default 10). */
	limit?: number;
}

/**
 * Extract a human-readable title from a session's events:
 * 1. session/title event (highest precedence)
 * 2. first user message text (deterministic fallback)
 */
export function extractTitleFromEvents(events: readonly unknown[]): string | undefined {
	return extractOverviewFromEvents(events).title;
}

export interface SessionOverview {
	title?: string;
	summary?: string;
	userTurns: number;
	toolCalls: number;
	lastActivityAt?: number;
}

const oneLine = (value: string, limit: number): string =>
	value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, limit);

const messageText = (event: unknown): string => {
	const ev = event as {
		data?: {
			content?: Array<{ type?: string; text?: string }>;
			message?: { content?: Array<{ type?: string; text?: string }> };
		};
	};
	const blocks = ev.data?.message?.content ?? ev.data?.content ?? [];
	return blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text?.trim())
		.filter(Boolean)
		.join(" ");
};

/** Extract a compact picker overview without invoking an LLM. */
export function extractOverviewFromEvents(events: readonly unknown[]): SessionOverview {
	let explicitTitle: string | undefined;
	let firstUser: string | undefined;
	let lastUser: string | undefined;
	let lastAssistant: string | undefined;
	let userTurns = 0;
	let toolCalls = 0;
	let lastActivityAt: number | undefined;

	if (!Array.isArray(events) || events.length === 0) {
		return { userTurns: 0, toolCalls: 0 };
	}
	for (const event of events) {
		const ev = event as {
			type?: string;
			time?: number;
			data?: { title?: string };
		};
		if (typeof ev.time === "number") {
			lastActivityAt = Math.max(lastActivityAt ?? 0, ev.time);
		}
		if (ev.type === "session/title" && ev.data?.title) {
			const title = oneLine(ev.data.title, 36);
			if (title) explicitTitle = title;
		} else if (ev.type === "user/message") {
			const text = messageText(event);
			if (text) {
				userTurns++;
				const clean = text.replace(/^\/[a-zA-Z0-9_-]+\s*/, "").trim() || text;
				firstUser ??= oneLine(clean, 36);
				lastUser = oneLine(clean, 90);
			}
		} else if (ev.type === "assistant/message") {
			const text = messageText(event);
			if (text) lastAssistant = oneLine(text, 90);
		} else if (ev.type === "tool/call") {
			toolCalls++;
		}
	}
	return {
		...(explicitTitle || firstUser ? { title: explicitTitle ?? firstUser } : {}),
		...(lastAssistant || lastUser ? { summary: lastAssistant ?? `待处理：${lastUser}` } : {}),
		userTurns,
		toolCalls,
		...(lastActivityAt === undefined ? {} : { lastActivityAt }),
	};
}

/**
 * Port of dsh-session-persistence-jsonl's projectKey: `/`, `\` and `:` become
 * `-` (consecutive runs collapse), safe `[A-Za-z0-9._-]` passes, everything
 * else escapes as `~XXXX` (uppercase hex code unit); wrapped `--…--` with the
 * readable part bounded to 251 chars and `root` when empty.
 */
export function projectKeyOf(cwd: string): string {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const ch = cwd[i] as string;
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** Decode an encoded session dir name (`~003A` → `:` etc.). */
export function decodeSessionDirName(name: string): string {
	return name.replace(/~([0-9A-Fa-f]{4})/g, (_m, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

/** List historical sessions of one workspace, newest first, capped. */
export async function listWorkspaceSessions(
	deps: ListWorkspaceSessionsDeps,
): Promise<WorkspaceSessionInfo[]> {
	const limit = deps.limit ?? 10;
	const exclude = new Set(deps.exclude ?? []);
	let rows: WorkspaceSessionInfo[] = [];

	// Source 1: the persistence service — headers give exact cwd + origin.
	if (deps.persistence?.list) {
		try {
			const snapshots = await deps.persistence.list();
			const headers = snapshots.map((entry) =>
				"header" in entry ? entry.header : entry,
			);
			rows = headers
				.filter(
					(h) =>
						h.cwd === deps.cwd &&
						h.origin !== "subagent" &&
						!exclude.has(h.id),
				)
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, limit)
				.map<WorkspaceSessionInfo>((h) => {
					const snapshot = snapshots.find((entry) =>
						"header" in entry ? entry.header.id === h.id : entry.id === h.id,
					) as { eventCount?: number } | undefined;
					const title = deps.titleFor?.(h.id) ?? h.title;
					return {
						id: h.id,
						createdAt: h.createdAt,
						...(h.agentPreset ? { preset: h.agentPreset } : {}),
						...(title ? { title } : {}),
						...(typeof snapshot?.eventCount === "number"
							? { eventCount: snapshot.eventCount }
							: {}),
						source: "service",
					};
				});
		} catch {
			// fall through to the filesystem scan
		}
	}

	// Source 2: filesystem scan of <sessionsRoot>/<projectKey(cwd)>/.
	if (rows.length === 0) {
		const dir = join(deps.sessionsRoot, projectKeyOf(deps.cwd));
		if (existsSync(dir)) {
			for (const name of readdirSync(dir)) {
				const sessionDir = join(dir, name);
				// Current DSH uses a format-versioned filename. Keep the legacy name
				// for installations that have not migrated yet.
				const log = ["session.v3.jsonl.zstd", "session.jsonl.zstd"]
					.map((filename) => join(sessionDir, filename))
					.find((candidate) => existsSync(candidate));
				if (!log) continue;
				let mtime: number;
				try {
					mtime = statSync(log).mtimeMs;
				} catch {
					continue; // no materialized log — not resumable
				}
				const id = decodeSessionDirName(name);
				if (exclude.has(id)) continue;
				const title = deps.titleFor?.(id);
				rows.push({ id, createdAt: mtime, ...(title ? { title } : {}), source: "scan" });
			}
			rows.sort((a, b) => b.createdAt - a.createdAt);
			rows = rows.slice(0, limit);
		}
	}

	// Resolve titles from persistence events if not already present
	if (deps.persistence && rows.length > 0) {
		await Promise.allSettled(
			rows.map(async (row) => {
				let overview: SessionOverview | undefined;
				if (deps.titleFor) {
					const t = deps.titleFor(row.id);
					if (t) row.title = t;
				}
				try {
					let events: readonly unknown[] | undefined;
					if (deps.persistence?.open) {
						const handle = await deps.persistence.open(row.id, "read");
						try {
							const count = row.eventCount;
							if (typeof count === "number" && count > 240) {
								const [head, tail] = await Promise.all([
									handle.read(0, 120),
									handle.read(Math.max(0, count - 120), 120),
								]);
								events = [...head.events, ...tail.events];
							} else {
								events = (await handle.read(0, count ?? 400)).events;
							}
						} finally {
							await handle.close();
						}
					} else if (deps.persistence?.inspect) {
						const res = await deps.persistence.inspect(row.id);
						events = res?.events;
					} else if (deps.persistence?.load) {
						const res = await deps.persistence.load(row.id);
						events = res?.events;
					} else if (deps.persistence?.readFrom) {
						const res = await deps.persistence.readFrom(row.id, 0);
						events = res?.events;
					}
					if (events) {
						overview = extractOverviewFromEvents(events);
						row.title ??= overview.title;
						row.summary = overview.summary;
						row.userTurns = overview.userTurns;
						row.toolCalls = overview.toolCalls;
						row.lastActivityAt = overview.lastActivityAt;
					}
				} catch {
					// best-effort
				}
			}),
		);
	}

	return rows;
}



// Session administration for the bridge's conversation-management panel.
//
// Three operations, implemented against the jsonl persistence layout the bridge
// already reads (see workspace-sessions.ts):
//
//   locate  <sessionsRoot>/<projectKey(cwd)>/<encodedId>/session.v3.jsonl.zstd
//   delete  the persistence service's delete when the host exposes one, else
//           exactly that one session directory
//   move    copy the session dir into the TARGET project dir, rewrite the copy's
//           header `cwd` (the header IS the log's first line), verify, and only
//           then drop the source — a failure at any earlier point leaves the
//           original session exactly as it was
//
// Rename is deliberately NOT here: DSH's title service only renames a session
// that is live in its store, so historical sessions carry the bridge's own alias
// (session-aliases.ts).
//
// Harness-agnostic: nothing here imports DSH.

import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { decodeSessionDirName, projectKeyOf } from "./workspace-sessions.ts";

/**
 * Session log filenames. DSH moved v3 → v4 in the 0.2 line, and a FIXED list made
 * every session look missing there — the GUI kept listing them while delete
 * failed with 找不到该会话的持久化日志 (and the archived-gate census reported the
 * whole list as dangling). Match the SHAPE instead; rank the known names so a
 * directory holding several formats resolves newest-first.
 */
const LOG_PATTERN = /^session(?:\.[a-z0-9]+)?\.jsonl\.zstd$/;
const LOG_RANK = [
	"session.v4.jsonl.zstd",
	"session.v3.jsonl.zstd",
	"session.jsonl.zstd",
];
/** DSH's open-session lock; a moved copy must never carry a stale one. */
const LOCK_NAME = "session.lock";

export interface SessionLocation {
	id: string;
	/** Absolute session directory. */
	dir: string;
	/** Absolute project (workspace) directory that holds it. */
	projectDir: string;
	/** Log filename inside `dir`. */
	logName: string;
	/** `cwd` from the stored header, when readable. */
	cwd?: string;
}

export interface SessionAdminDeps {
	/** DSH sessions root — <DSH_HOME>/sessions. */
	sessionsRoot: string;
	/** True while DSH still holds the session; every mutation refuses. */
	isLive?: (sessionId: string) => boolean;
	/** Persistence delete when the host exposes one. */
	serviceDelete?: (sessionId: string) => Promise<void> | void;
	/** Report a service-side delete failure that the disk removal then survived. */
	onServiceDeleteError?: (sessionId: string, err: unknown) => void;
}

export interface MoveSessionResult {
	id: string;
	from: string;
	to: string;
	/** Workspace the session now belongs to. */
	cwd: string;
}

const logPathIn = (dir: string): { logName: string; path: string } | undefined => {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => LOG_PATTERN.test(name));
	} catch {
		return undefined;
	}
	if (names.length === 0) return undefined;
	const rank = (name: string): number => {
		const index = LOG_RANK.indexOf(name);
		return index === -1 ? LOG_RANK.length : index;
	};
	names.sort((a, b) => rank(a) - rank(b));
	const logName = names[0] as string;
	return { logName, path: join(dir, logName) };
};

/** Read the stored header — the FIRST line of the (zstd) log. */
export function readSessionHeader(logFile: string): Record<string, unknown> | undefined {
	try {
		const text = zstdDecompressSync(readFileSync(logFile)).toString("utf8");
		const newlineAt = text.indexOf("\n");
		const head = (newlineAt === -1 ? text : text.slice(0, newlineAt)).trim();
		if (!head) return undefined;
		const parsed = JSON.parse(head) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Rewrite ONLY the header's `cwd`. Every later line is an event and must stay
 * byte-identical, so the header line is patched in place rather than
 * re-serialized from parsed events. Written through a temp file + rename so a
 * crash mid-write cannot truncate the session log.
 */
export function rewriteSessionCwd(logFile: string, cwd: string): void {
	const text = zstdDecompressSync(readFileSync(logFile)).toString("utf8");
	const newlineAt = text.indexOf("\n");
	const head = newlineAt === -1 ? text : text.slice(0, newlineAt);
	const rest = newlineAt === -1 ? "" : text.slice(newlineAt);
	const header = JSON.parse(head) as Record<string, unknown>;
	if (header.type !== "session") throw new Error("不是会话头记录，拒绝改写");
	header.cwd = cwd;
	const tmp = `${logFile}.rewrite`;
	writeFileSync(tmp, zstdCompressSync(Buffer.from(JSON.stringify(header) + rest, "utf8")));
	renameSync(tmp, logFile);
}

/** Find one session directory by id. Project directories are scanned, never
 *  decoded: the projectKey encoding is lossy (separators collapse to `-`). */
export function locateSession(
	deps: SessionAdminDeps,
	sessionId: string,
): SessionLocation | undefined {
	const root = deps.sessionsRoot;
	if (!sessionId || !existsSync(root)) return undefined;
	for (const projectName of readdirSync(root)) {
		const projectDir = join(root, projectName);
		let dirNames: string[];
		try {
			if (!statSync(projectDir).isDirectory()) continue;
			dirNames = readdirSync(projectDir);
		} catch {
			continue;
		}
		for (const dirName of dirNames) {
			if (decodeSessionDirName(dirName) !== sessionId) continue;
			const dir = join(projectDir, dirName);
			const log = logPathIn(dir);
			if (!log) continue;
			const header = readSessionHeader(log.path);
			const cwd = typeof header?.cwd === "string" ? header.cwd : undefined;
			return {
				id: sessionId,
				dir,
				projectDir,
				logName: log.logName,
				...(cwd ? { cwd } : {}),
			};
		}
	}
	return undefined;
}

/** Delete one persisted session (refuses while DSH still holds it). */
export async function deleteSession(
	deps: SessionAdminDeps,
	sessionId: string,
): Promise<SessionLocation> {
	const located = locateSession(deps, sessionId);
	if (!located) throw new Error("找不到该会话的持久化日志");
	if (deps.isLive?.(sessionId)) throw new Error("该会话仍由 DSH 正在使用，请先在网页端停止它");
	if (deps.serviceDelete) {
		try {
			await deps.serviceDelete(sessionId);
		} catch (err) {
			// Some hosts throw for a session their index never registered (ghosts
			// left behind by older builds). The log directory is what every list
			// reads, so the removal below must still run — report and continue
			// instead of leaving an undeletable row.
			deps.onServiceDeleteError?.(sessionId, err);
		}
	}
	// Whatever the service did (some hosts only drop their own row), the log
	// directory must be gone — otherwise /resume would list a ghost.
	if (existsSync(located.dir)) rmSync(located.dir, { recursive: true, force: true });
	return located;
}

/**
 * Move one session into the project directory of `targetCwd` (迁移项目). Copy →
 * patch the copy's header → verify → drop the source, so a failure before the
 * last step leaves the original untouched and removes the partial copy.
 */
export function moveSessionToProject(
	deps: SessionAdminDeps,
	sessionId: string,
	targetCwd: string,
): MoveSessionResult {
	const cwd = String(targetCwd ?? "").trim();
	if (!cwd) throw new Error("目标项目路径不能为空");
	const located = locateSession(deps, sessionId);
	if (!located) throw new Error("找不到该会话的持久化日志");
	if (deps.isLive?.(sessionId)) throw new Error("该会话仍由 DSH 正在使用，请先在网页端停止它");
	if (located.cwd === cwd) throw new Error("该会话已经属于这个项目");

	const targetProjectDir = join(deps.sessionsRoot, projectKeyOf(cwd));
	const targetDir = join(targetProjectDir, basename(located.dir));
	if (existsSync(targetDir)) throw new Error("目标项目下已存在同名会话");
	mkdirSync(targetProjectDir, { recursive: true });
	cpSync(located.dir, targetDir, { recursive: true });
	try {
		const targetLog = join(targetDir, located.logName);
		rewriteSessionCwd(targetLog, cwd);
		if (readSessionHeader(targetLog)?.cwd !== cwd) {
			throw new Error("迁移后校验失败（header.cwd 未生效）");
		}
		rmSync(join(targetDir, LOCK_NAME), { force: true });
	} catch (err) {
		rmSync(targetDir, { recursive: true, force: true });
		throw err;
	}
	rmSync(located.dir, { recursive: true, force: true });
	return { id: sessionId, from: located.dir, to: targetDir, cwd };
}

/**
 * Known projects (workspaces) under the sessions root, newest first.
 *
 * A project directory's NAME cannot be decoded back to its cwd (the encoding is
 * lossy), so each project is labelled with the cwd stored in the header of its
 * most recently written session.
 */
export function listProjectCwds(deps: SessionAdminDeps, limit = 12): string[] {
	const root = deps.sessionsRoot;
	if (!existsSync(root)) return [];
	const found: Array<{ cwd: string; at: number }> = [];
	for (const projectName of readdirSync(root)) {
		const projectDir = join(root, projectName);
		let dirNames: string[];
		try {
			dirNames = readdirSync(projectDir);
		} catch {
			continue;
		}
		let best: { cwd: string; at: number } | undefined;
		for (const dirName of dirNames) {
			const log = logPathIn(join(projectDir, dirName));
			if (!log) continue;
			const cwd = readSessionHeader(log.path)?.cwd;
			if (typeof cwd !== "string" || !cwd) continue;
			let at = 0;
			try {
				at = statSync(log.path).mtimeMs;
			} catch {
				// keep 0 — still a valid candidate, just not the newest
			}
			if (!best || at > best.at) best = { cwd, at };
		}
		if (best) found.push(best);
	}
	return found
		.sort((a, b) => b.at - a.at)
		.slice(0, limit)
		.map((entry) => entry.cwd);
}

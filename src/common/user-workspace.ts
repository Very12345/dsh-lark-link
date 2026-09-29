// Per-user workspace isolation.
//
// One bridge instance serves many Feishu users, and they all used to share one
// workspace root — so two people's tasks could read, overwrite or delete each
// other's files, and `/workspace` in one chat changed the ground under another.
// Every user (or group) now gets its own subtree, derived from a SHORT STABLE
// hash of its id:  dsh-workspace/<5 letters>/
//
// The hash is deliberately short (5 letters, 26^5 ≈ 11.8M buckets) because it is
// part of a path a human may read; it is an isolation device, not a security
// boundary — access control stays with the allowlist.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, win32 } from "node:path";

/** How many letters the per-user directory name has. */
export const USER_DIR_LENGTH = 5;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Stable 5-letter directory name for one owner id.
 *
 * sha256 → base26: deterministic across restarts and platforms, and never
 * produces path separators, dots (so no `.`/`..` surprises) or case-collision
 * ambiguity.
 */
export function userWorkspaceId(ownerId: string): string {
	const digest = createHash("sha256").update(String(ownerId ?? "")).digest();
	let out = "";
	// Consume 4 bytes per letter: 2^32 is not a multiple of 26, so use mod per
	// digit — a negligible bias is irrelevant for a directory name.
	for (let i = 0; i < USER_DIR_LENGTH; i += 1) {
		const chunk =
			((digest[i * 4] ?? 0) << 24) |
			((digest[i * 4 + 1] ?? 0) << 16) |
			((digest[i * 4 + 2] ?? 0) << 8) |
			(digest[i * 4 + 3] ?? 0);
		out += LETTERS[(chunk >>> 0) % LETTERS.length];
	}
	return out;
}

/** The owner's own root under the bridge workspace base. */
export function userWorkspaceRoot(base: string, ownerId: string): string {
	return join(base, userWorkspaceId(ownerId));
}

/** True when `target` is `root` itself or lives underneath it. */
export function isInsideWorkspace(root: string, target: string): boolean {
	const useWin = win32.isAbsolute(root) || win32.isAbsolute(target);
	const rel = useWin ? win32.relative(root, target) : relative(root, target);
	if (rel === "") return true;
	if (rel.startsWith("..")) return false;
	return !isAbsolute(rel) && !win32.isAbsolute(rel);
}

/**
 * Resolve the workspace a user is allowed to work in.
 *
 * `explicit` (an override the user set with /workspace) wins ONLY when it stays
 * inside the isolation root — otherwise the root is returned, so a stale or
 * hand-edited override can never hand one user another's directory.
 */
export function resolveIsolatedWorkspace(
	base: string,
	ownerId: string,
	explicit?: string,
): string {
	const root = userWorkspaceRoot(base, ownerId);
	if (explicit && isInsideWorkspace(root, explicit)) return explicit;
	return root;
}

/** Create the isolation root on demand (agent creation needs an existing cwd). */
export function ensureWorkspaceDir(dir: string): string {
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// Best effort: DSH reports a missing cwd itself if it really cannot be used.
	}
	return dir;
}

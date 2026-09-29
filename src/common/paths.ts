// Cross-platform workspace path resolution (GH #7).
//
// The /workspace command and the lark_send_local_file tool used to test
// absoluteness with `startsWith("/")` — a Unix-only heuristic. On Windows
// every absolute path starts with a drive letter (`D:\…`) or a UNC share
// (`\\server\…`), so the command rejected EVERY path with 无效路径 and the
// file tool joined drive paths under the workspace root and then rejected
// them as out-of-workspace.
//
// node:path already knows: isAbsolute() is platform-correct, and win32
// absoluteness is additionally recognized on every platform so a Windows-style
// path typed into a Linux-hosted bridge surfaces as "directory not found"
// instead of a garbage joined path. Containment uses relative() — prefix
// string matching breaks on case/separator variance.

import { dirname, isAbsolute, join, resolve, relative, win32 } from "node:path";
import { homedir } from "node:os";

/** True for a path that is absolute on the CURRENT platform OR Windows-shaped
 * (drive letter / UNC) — a superset check so drive paths never get joined
 * under a Unix cwd (GH #7). */
export function isAbsoluteAny(p: string): boolean {
	return isAbsolute(p) || win32.isAbsolute(p);
}

/**
 * Resolve a /workspace argument against the current workspace (GH #7).
 * - `~` / `~/…` expands to the user's home directory
 * - absolute (posix OR windows drive/UNC) stays verbatim (normalized)
 * - anything else joins onto curWs
 */
export function resolveWorkspaceTarget(arg: string, curWs: string): string {
	const expanded =
		arg === "~" || arg.startsWith("~/")
			? join(homedir(), arg.slice(arg.startsWith("~/") ? 2 : 1))
			: arg;
	if (!isAbsoluteAny(expanded)) return resolve(join(curWs, expanded));
	// Windows-shaped on a posix host (or vice versa): normalize in ITS shape
	// and return verbatim — never let resolve() fold it under a foreign root.
	if (win32.isAbsolute(expanded) && !isAbsolute(expanded))
		return win32.normalize(expanded);
	return resolve(expanded);
}

/**
 * Resolve a file path for the lark_send_local_file tool and check that it
 * stays inside the workspace root (GH #7).
 * Returns { abs, ok } — ok=false means the path escapes the workspace and
 * must be rejected (拒绝: 路径不在工作区内).
 */
/** Max sub-directory buttons rendered in one workspace-browser view. */
export const BROWSER_ENTRY_LIMIT = 40;

/**
 * Parent directory, or undefined when `p` already IS a filesystem root.
 * `dirname()` is platform-correct: it maps "/" → "/" on posix and "C:\\" →
 * "C:\\" (and UNCs to their share root) on Windows, so the browser can offer
 * ".." exactly while ascending is still possible.
 */
export function parentDirectory(p: string): string | undefined {
	const dir = dirname(p);
	return dir === p ? undefined : dir;
}

/**
 * Validate ONE directory name typed by the user (new-folder form / text form).
 * Rejects anything that could escape the intended parent or break a path:
 * separators, "." / "..", control characters, Windows-reserved punctuation and
 * overlong names. Throws with a user-facing message.
 */
export function sanitizeDirectoryName(value: string): string {
	const name = String(value ?? "").trim();
	if (!name) throw new Error("文件夹名称不能为空");
	if (name === "." || name === "..") throw new Error("文件夹名称无效");
	if (/[\\/]/.test(name)) throw new Error("文件夹名称不能包含路径分隔符");
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("文件夹名称不能包含控制字符");
	if (/[<>:"|?*]/.test(name)) throw new Error('文件夹名称不能包含 < > : " | ? * 等字符');
	if (name.length > 100) throw new Error("文件夹名称过长（最多 100 字符）");
	return name;
}

/**
 * Decode a URI-encoded path carried by a card callback op. Card actions split
 * the op at the FIRST ":" and conversation keys/paths contain colons, so paths
 * travel encoded; malformed input falls back to the raw value.
 */
export function decodeOpPath(value: string): string {
	const raw = String(value ?? "");
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

export function resolveInWorkspacePath(
	p: string,
	root: string,
): { abs: string; ok: boolean } {
	const abs = isAbsoluteAny(p) ? resolveWorkspaceTarget(p, root) : resolve(join(root, p));
	// Containment via relative(): safe against case and separator variance.
	// Pick the family that matches the inputs so drive-letter roots compare
	// correctly even when the host is posix.
	const useWin = win32.isAbsolute(root) || win32.isAbsolute(abs);
	const rel = useWin ? win32.relative(root, abs) : relative(root, abs);
	const ok =
		rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !win32.isAbsolute(rel));
	return { abs, ok };
}

// Bridge-side display aliases for DSH sessions — the "重命名" of the
// conversation-management panel.
//
// Why not DSH's own title service: `SessionTitleService.rename()` requires the
// session to be LIVE in the host store (`ctx.sessions.get(id) === session`,
// otherwise it throws), while the management panel works on HISTORICAL
// sessions. So the bridge keeps its own alias — the panel and /resume render it
// in place of the derived title — and a rename additionally updates the real
// DSH title whenever the target IS live (see index.ts).
//
// Persisted like every other bridge store (plain JSON, best-effort writes).

import { readFileSync, writeFileSync } from "node:fs";

export interface SessionAliasStore {
	get(sessionId: string): string | undefined;
	/** Validate + persist one alias; throws with a user-facing message. */
	set(sessionId: string, alias: string): string;
	clear(sessionId?: string): void;
	all(): Record<string, string>;
}

/** Cap shown in the rename form's error message. */
export const MAX_ALIAS_CHARS = 48;

/** Normalize one alias (single line, trimmed, bounded). Throws when empty. */
export function sanitizeAlias(value: string): string {
	const alias = String(value ?? "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	if (!alias) throw new Error("名称不能为空");
	if (alias.length > MAX_ALIAS_CHARS) throw new Error(`名称过长（最多 ${MAX_ALIAS_CHARS} 字符）`);
	return alias;
}

export function createSessionAliasStore(file: string): SessionAliasStore {
	let rows: Record<string, string> = {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
		if (parsed && typeof parsed === "object") rows = parsed;
	} catch {
		rows = {};
	}
	const save = (): void => {
		try {
			writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
		} catch {
			// best-effort: an alias must never break a turn
		}
	};
	return {
		get: (sessionId) => rows[sessionId],
		set(sessionId, alias) {
			const clean = sanitizeAlias(alias);
			rows[sessionId] = clean;
			save();
			return clean;
		},
		clear(sessionId) {
			if (sessionId) delete rows[sessionId];
			else rows = {};
			save();
		},
		all: () => ({ ...rows }),
	};
}

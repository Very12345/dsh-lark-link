import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_ALIAS_CHARS,
	createSessionAliasStore,
	sanitizeAlias,
} from "../../../src/sessions/session-aliases.ts";

test("session-aliases: names survive a reload and are stored as one line", () => {
	const dir = mkdtempSync(join(tmpdir(), "alias-"));
	try {
		const file = join(dir, "session-aliases.json");
		const store = createSessionAliasStore(file);
		assert.equal(store.set("session-a", "  我的\n\n调试会话  "), "我的 调试会话");
		assert.equal(store.get("session-a"), "我的 调试会话");
		// A fresh store reads what the previous process wrote.
		const reloaded = createSessionAliasStore(file);
		assert.equal(reloaded.get("session-a"), "我的 调试会话");
		assert.match(readFileSync(file, "utf8"), /我的 调试会话/);
		reloaded.clear("session-a");
		assert.equal(createSessionAliasStore(file).get("session-a"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session-aliases: rejects empty and overlong names, and a corrupt file never throws", () => {
	assert.throws(() => sanitizeAlias("   "), /不能为空/);
	assert.throws(() => sanitizeAlias("x".repeat(MAX_ALIAS_CHARS + 1)), /过长/);
	assert.equal(sanitizeAlias("ok"), "ok");
	const dir = mkdtempSync(join(tmpdir(), "alias-bad-"));
	try {
		const file = join(dir, "session-aliases.json");
		writeFileSync(file, "{not json");
		const store = createSessionAliasStore(file);
		assert.equal(store.get("session-a"), undefined);
		assert.equal(store.set("session-a", "恢复"), "恢复");
		assert.equal(createSessionAliasStore(file).get("session-a"), "恢复");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

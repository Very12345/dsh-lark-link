import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import {
	deleteSession,
	listProjectCwds,
	locateSession,
	moveSessionToProject,
	readSessionHeader,
} from "../../../src/sessions/session-admin.ts";
import { projectKeyOf } from "../../../src/sessions/workspace-sessions.ts";

const ID = "session-11111111-2222-3333-4444-555555555555";
const OTHER_ID = "session-99999999-2222-3333-4444-555555555555";
const dirNameOf = (id: string): string => id.replace(/:/g, "~003A");

/** Write one session the way DSH does: header line first, then event lines. */
function writeSession(
	root: string,
	cwd: string,
	id = ID,
	rows: Array<Record<string, unknown>> = [
		{ type: "user/message", seq: 1, time: 1, data: { content: [{ type: "text", text: "hi" }] } },
		{ type: "assistant/message", seq: 2, time: 2, data: { content: [{ type: "text", text: "ok" }] } },
	],
): string {
	const dir = join(root, projectKeyOf(cwd), dirNameOf(id));
	mkdirSync(dir, { recursive: true });
	const header = {
		type: "session",
		version: 3,
		id,
		createdAt: 1_700_000_000_000,
		cwd,
		isSeeded: false,
		delegationDepth: 0,
		agentPreset: "standard",
	};
	const text = `${[JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join("\n")}\n`;
	writeFileSync(join(dir, "session.v3.jsonl.zstd"), zstdCompressSync(Buffer.from(text, "utf8")));
	writeFileSync(join(dir, "session.lock"), "");
	return dir;
}

const logLines = (file: string): string[] =>
	zstdDecompressSync(readFileSync(file)).toString("utf8").split("\n").filter((line) => line.trim() !== "");

test("session-admin: locates a session by id and reads its header", () => {
	const root = mkdtempSync(join(tmpdir(), "sess-admin-"));
	try {
		writeSession(root, "/srv/alpha");
		const found = locateSession({ sessionsRoot: root }, ID);
		assert.equal(found?.cwd, "/srv/alpha");
		assert.equal(found?.logName, "session.v3.jsonl.zstd");
		assert.equal(readSessionHeader(join(found!.dir, found!.logName))?.agentPreset, "standard");
		assert.equal(locateSession({ sessionsRoot: root }, "session-absent"), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("session-admin: move rewrites ONLY the header cwd and drops the source", () => {
	const root = mkdtempSync(join(tmpdir(), "sess-move-"));
	try {
		const from = writeSession(root, "/srv/alpha");
		const before = logLines(join(from, "session.v3.jsonl.zstd"));
		const moved = moveSessionToProject({ sessionsRoot: root }, ID, "/srv/beta");

		assert.equal(existsSync(from), false, "源目录必须被移除");
		const after = logLines(join(moved.to, "session.v3.jsonl.zstd"));
		assert.equal(JSON.parse(after[0]!).cwd, "/srv/beta", "header.cwd 必须指向新项目");
		assert.deepEqual(after.slice(1), before.slice(1), "事件行必须逐字保留");
		assert.equal(existsSync(join(moved.to, "session.lock")), false, "stale lock 不得随迁");
		assert.equal(locateSession({ sessionsRoot: root }, ID)?.cwd, "/srv/beta");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("session-admin: move refuses live sessions, same-project moves and collisions", () => {
	const root = mkdtempSync(join(tmpdir(), "sess-refuse-"));
	try {
		const from = writeSession(root, "/srv/alpha");
		assert.throws(
			() => moveSessionToProject({ sessionsRoot: root, isLive: () => true }, ID, "/srv/beta"),
			/正在使用/,
		);
		assert.throws(
			() => moveSessionToProject({ sessionsRoot: root }, ID, "/srv/alpha"),
			/已经属于这个项目/,
		);
		// A same-named directory in the target project blocks the move.
		mkdirSync(join(root, projectKeyOf("/srv/beta"), dirNameOf(ID)), { recursive: true });
		assert.throws(
			() => moveSessionToProject({ sessionsRoot: root }, ID, "/srv/beta"),
			/已存在同名会话/,
		);
		assert.equal(existsSync(from), true, "被拒绝的迁移不得动到源会话");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("session-admin: a failed header rewrite rolls back and leaves the source intact", () => {
	const root = mkdtempSync(join(tmpdir(), "sess-rollback-"));
	try {
		const from = writeSession(root, "/srv/alpha");
		const log = join(from, "session.v3.jsonl.zstd");
		// A header that is NOT a session record makes the rewrite refuse: the copy
		// must be discarded and the original left exactly as it was.
		writeFileSync(
			log,
			zstdCompressSync(Buffer.from(`${JSON.stringify({ type: "not-session", cwd: "/srv/alpha" })}\n`, "utf8")),
		);
		assert.throws(() => moveSessionToProject({ sessionsRoot: root }, ID, "/srv/beta"), /拒绝改写/);
		assert.equal(existsSync(log), true, "源日志必须原样保留");
		assert.equal(
			existsSync(join(root, projectKeyOf("/srv/beta"), dirNameOf(ID))),
			false,
			"失败的副本必须被清理",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("session-admin: delete removes exactly one session directory", async () => {
	const root = mkdtempSync(join(tmpdir(), "sess-del-"));
	try {
		const dir = writeSession(root, "/srv/alpha");
		const other = writeSession(root, "/srv/alpha", OTHER_ID);
		await deleteSession({ sessionsRoot: root }, ID);
		assert.equal(existsSync(dir), false);
		assert.equal(existsSync(other), true, "只删选中的那一条");
		await assert.rejects(deleteSession({ sessionsRoot: root }, ID), /找不到该会话/);
		await assert.rejects(
			deleteSession({ sessionsRoot: root, isLive: () => true }, OTHER_ID),
			/正在使用/,
		);
		assert.equal(existsSync(other), true, "live 会话不得被删");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("session-admin: delete falls back to the service when the host exposes one", async () => {
	const root = mkdtempSync(join(tmpdir(), "sess-svc-"));
	try {
		const dir = writeSession(root, "/srv/alpha");
		let asked = "";
		await deleteSession(
			{
				sessionsRoot: root,
				// A host that only drops its own row still leaves the directory to us.
				serviceDelete: (id: string) => {
					asked = id;
				},
			},
			ID,
		);
		assert.equal(asked, ID);
		assert.equal(existsSync(dir), false, "目录必须真的被清掉，否则 /resume 会列出幽灵会话");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("session-admin: listProjectCwds labels projects from their headers", () => {
	const root = mkdtempSync(join(tmpdir(), "sess-projects-"));
	try {
		writeSession(root, "/srv/alpha");
		writeSession(root, "/srv/beta");
		const cwds = listProjectCwds({ sessionsRoot: root });
		assert.deepEqual([...cwds].sort(), ["/srv/alpha", "/srv/beta"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

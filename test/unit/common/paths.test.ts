// Workspace path helpers used by the /workspace directory browser: parent
// detection (drives the ".." button), folder-name validation (new-folder form)
// and op-path decoding (card callbacks split on the first ":").
//
// Platform note: `path.dirname` follows the HOST platform, so Windows-shaped
// assertions are guarded — CI runs on posix hosts where "C:\\x" carries no
// separators at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parentDirectory,
	sanitizeDirectoryName,
	decodeOpPath,
	BROWSER_ENTRY_LIMIT,
	resolveWorkspaceTarget,
	isAbsoluteAny,
} from "../../../src/common/paths.ts";

test("paths: parentDirectory walks up and stops at the filesystem root", () => {
	assert.equal(parentDirectory("/srv/app/src"), "/srv/app");
	assert.equal(parentDirectory("/srv"), "/");
	assert.equal(parentDirectory("/"), undefined, "POSIX 根不应再有父目录");
	if (process.platform === "win32") {
		assert.equal(parentDirectory("C:\\Users\\me"), "C:\\Users");
		assert.equal(parentDirectory("C:\\"), undefined, "盘符根不应再有父目录");
	}
});

test("paths: sanitizeDirectoryName accepts plain names and rejects escapes", () => {
	assert.equal(sanitizeDirectoryName("  my-project  "), "my-project");
	assert.equal(sanitizeDirectoryName("中文目录"), "中文目录");
	for (const bad of ["", "   ", ".", "..", "a/b", "a\\b", "a\u0000b", "a:b", "a?b", "a*b"]) {
		assert.throws(
			() => sanitizeDirectoryName(bad),
			/文件夹/,
			`应拒绝非法名称 ${JSON.stringify(bad)}`,
		);
	}
	assert.throws(() => sanitizeDirectoryName("x".repeat(101)), /过长/);
});

test("paths: decodeOpPath tolerates malformed encoding", () => {
	assert.equal(decodeOpPath(encodeURIComponent("/srv/a:b")), "/srv/a:b");
	assert.equal(decodeOpPath("%E4%B8%AD%E6%96%87"), "中文");
	assert.equal(decodeOpPath("%E4%B8"), "%E4%B8", "非法编码应原样返回而不抛错");
});

test("paths: browser entry limit is a sane positive cap", () => {
	assert.ok(Number.isInteger(BROWSER_ENTRY_LIMIT) && BROWSER_ENTRY_LIMIT > 0);
});

test("paths: resolveWorkspaceTarget resolves relative input and expands ~", () => {
	const resolved = resolveWorkspaceTarget("sub", "/srv/app");
	assert.ok(resolved.endsWith("sub"), `相对路径应落到工作区下，实际 ${resolved}`);
	const home = resolveWorkspaceTarget("~", "/srv/app");
	assert.ok(isAbsoluteAny(home), "~ 应展开为绝对路径");
	assert.ok(!home.includes("~"), "~ 不应残留在结果中");
});

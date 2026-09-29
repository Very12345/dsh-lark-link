import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
	isInsideWorkspace,
	resolveIsolatedWorkspace,
	userWorkspaceId,
	userWorkspaceRoot,
} from "../../../src/common/user-workspace.ts";

test("user-workspace: the id is 5 letters, stable, and differs per user", () => {
	const first = userWorkspaceId("ou_aaa");
	assert.equal(first, userWorkspaceId("ou_aaa"), "同一用户必须始终落到同一目录");
	assert.equal(first.length, 5);
	assert.match(first, /^[a-z]{5}$/, "必须是 5 个英文字母（可直接作为目录名）");
	assert.notEqual(first, userWorkspaceId("ou_bbb"), "不同用户必须隔离");
	assert.notEqual(first, userWorkspaceId("ou_aaa "), "空格也是不同的 id");
	// A group chat id (oc_…) is just another owner.
	assert.match(userWorkspaceId("oc_group_1"), /^[a-z]{5}$/);
});

test("user-workspace: the root is base/<hash>", () => {
	const base = join("/srv", "dsh-workspace");
	assert.equal(userWorkspaceRoot(base, "ou_aaa"), join(base, userWorkspaceId("ou_aaa")));
});

test("user-workspace: an override only counts INSIDE the user's own subtree", () => {
	const base = join("/srv", "dsh-workspace");
	const root = userWorkspaceRoot(base, "ou_aaa");
	assert.equal(resolveIsolatedWorkspace(base, "ou_aaa"), root, "默认落到自己的根");
	assert.equal(resolveIsolatedWorkspace(base, "ou_aaa", root), root);
	const inside = join(root, "proj", "app");
	assert.equal(resolveIsolatedWorkspace(base, "ou_aaa", inside), inside, "子树内的 override 生效");
	// Escapes must never hand one user another's directory.
	assert.equal(resolveIsolatedWorkspace(base, "ou_aaa", "/tmp/elsewhere"), root);
	assert.equal(resolveIsolatedWorkspace(base, "ou_aaa", base), root);
	assert.equal(
		resolveIsolatedWorkspace(base, "ou_aaa", userWorkspaceRoot(base, "ou_bbb")),
		root,
		"另一个用户的目录不可用",
	);
});

test("user-workspace: containment is exact, not a string prefix", () => {
	const base = join("/srv", "dsh-workspace");
	const root = userWorkspaceRoot(base, "ou_aaa");
	assert.equal(isInsideWorkspace(root, root), true, "根本身算在内");
	assert.equal(isInsideWorkspace(root, join(root, "a", "b")), true);
	assert.equal(isInsideWorkspace(root, base), false, "父目录不算");
	// A sibling directory whose NAME starts with the root's name must not pass.
	assert.equal(isInsideWorkspace(root, `${root}-evil`), false);
});

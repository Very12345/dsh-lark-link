import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_REACTIONS,
	VALID_EMOJI_TYPES,
	DONE_EMOJI,
	resolveReactions,
} from "../../../src/common/reactions.ts";

test("reactions: defaults are valid catalog entries and deterministic", () => {
	for (const value of Object.values(DEFAULT_REACTIONS)) {
		assert.ok(VALID_EMOJI_TYPES.has(value), `${value} is a valid Feishu emoji_type`);
	}
	assert.deepEqual(resolveReactions(), DEFAULT_REACTIONS);
	assert.deepEqual(resolveReactions({}), DEFAULT_REACTIONS);
	// The reaction is a STATEMENT about the turn, not decoration: the same
	// config must always render the same emoji (the random pool is gone).
	assert.equal(
		resolveReactions({ receipt: "OnIt" }).receipt,
		resolveReactions({ receipt: "OnIt" }).receipt,
	);
	assert.equal(resolveReactions({ receipt: "OnIt" }).receipt, "OnIt");
});

test("reactions: invalid values fall back per field, valid values survive", () => {
	const resolved = resolveReactions({ receipt: "FIRE", done: "CheckMark", error: "" });
	assert.equal(
		resolved.receipt,
		DEFAULT_REACTIONS.receipt,
		"FIRE is not in the catalog (case-sensitive) → default OnIt",
	);
	assert.equal(resolved.done, "CheckMark", "CheckMark is a valid catalog entry");
	assert.equal(resolved.error, DEFAULT_REACTIONS.error, "empty falls back to ERROR");
});

test("reactions: text-assignment debris (quotes/brackets) is stripped", () => {
	// /lark-config used to store the literal `["Typing"]` STRING — normalize it
	// instead of throwing inside the inbound pipeline.
	const resolved = resolveReactions({ receipt: '["Typing"]', done: '"YES"' });
	assert.equal(resolved.receipt, "Typing", "a stored literal JSON array still resolves");
	assert.equal(
		resolved.done,
		DEFAULT_REACTIONS.done,
		'"YES" is not a catalog entry (Yes is) → default DONE',
	);
});

test("reactions: the allow-list covers the numeric-start official values", () => {
	assert.ok(VALID_EMOJI_TYPES.has("2022"), "official catalog value 2022");
	assert.ok(VALID_EMOJI_TYPES.has("18X"), "official catalog value 18X");
	assert.equal(DONE_EMOJI, "DONE");
});

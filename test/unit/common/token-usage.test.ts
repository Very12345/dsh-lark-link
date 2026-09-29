import { test } from "node:test";
import assert from "node:assert/strict";
import {
	EMPTY_TOKEN_TOTALS,
	accumulateTokens,
	cacheHitPercent,
	formatTokenCount,
} from "../../../src/common/token-usage.ts";

test("token-usage: disjoint DSH counts fold into billed totals", () => {
	// inputTokens is UNCACHED input only, so the billed prompt is the sum of the
	// three input counters while totalTokens (provider-reported) wins outright.
	const once = accumulateTokens(EMPTY_TOKEN_TOTALS, {
		inputTokens: 1_000,
		outputTokens: 100,
		cacheReadTokens: 400,
		cacheWriteTokens: 100,
		totalTokens: 1_600,
	});
	assert.deepEqual(once, { tokens: 1_600, prompt: 1_500, cacheRead: 400 });
});

test("token-usage: the total is derived when the adapter omits totalTokens", () => {
	const totals = accumulateTokens(EMPTY_TOKEN_TOTALS, {
		inputTokens: 2_000,
		outputTokens: 200,
		cacheReadTokens: 500,
	});
	assert.deepEqual(totals, { tokens: 2_700, prompt: 2_500, cacheRead: 500 });
});

test("token-usage: folding is additive and never mutates its inputs", () => {
	const start = accumulateTokens(EMPTY_TOKEN_TOTALS, { inputTokens: 100, outputTokens: 10 });
	const next = accumulateTokens(start, { inputTokens: 100, outputTokens: 10 });
	assert.notEqual(next, start, "必须返回新对象，调用方按引用复用旧值");
	assert.equal(start.tokens, 110);
	assert.equal(next.tokens, 220);
	assert.deepEqual(EMPTY_TOKEN_TOTALS, { tokens: 0, prompt: 0, cacheRead: 0 });
});

test("token-usage: absent or empty usage leaves the totals untouched", () => {
	const start = accumulateTokens(EMPTY_TOKEN_TOTALS, { inputTokens: 5, outputTokens: 1 });
	assert.equal(accumulateTokens(start, undefined), start);
	assert.equal(accumulateTokens(start, { inputTokens: 0, outputTokens: 0 }), start);
	assert.equal(accumulateTokens(start, { inputTokens: Number.NaN, outputTokens: 0 }), start);
});

test("token-usage: cache hit is a share of the billed prompt, hidden when zero", () => {
	assert.equal(cacheHitPercent({ tokens: 0, prompt: 1_000, cacheRead: 250 }), 25);
	assert.equal(cacheHitPercent({ tokens: 0, prompt: 3, cacheRead: 1 }), 33);
	assert.equal(cacheHitPercent({ tokens: 0, prompt: 1_000, cacheRead: 0 }), undefined);
	assert.equal(cacheHitPercent(EMPTY_TOKEN_TOTALS), undefined);
});

test("token-usage: counts render the way DSH's footer does", () => {
	assert.equal(formatTokenCount(0), "0");
	assert.equal(formatTokenCount(999), "999");
	assert.equal(formatTokenCount(1_000), "1.0K");
	assert.equal(formatTokenCount(19_300), "19.3K");
	assert.equal(formatTokenCount(99_999), "100K");
	assert.equal(formatTokenCount(122_000), "122K");
	assert.equal(formatTokenCount(1_240_000), "1240K");
});

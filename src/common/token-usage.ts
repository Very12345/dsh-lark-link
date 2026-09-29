// Token accounting for the live card header.
//
// DSH reports REAL accounting on every step's `assistant/message` event
// (`usage?: TokenUsage` from @deepseek-ai/dsh-llm), so the bridge no longer has
// to derive throughput from the stream: the header shows the same numbers DSH's
// own WebUI footer shows (total tokens, cache-hit share). This module keeps that
// arithmetic in one place and stays harness-agnostic — no DSH import.

import type { TokenTotals, TokenUsageSnapshot } from "./types.ts";

/** Zero totals. Never mutated — accumulateTokens always returns a fresh object. */
export const EMPTY_TOKEN_TOTALS: TokenTotals = Object.freeze({
	tokens: 0,
	prompt: 0,
	cacheRead: 0,
});

const positive = (value: number | undefined): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Fold one step's usage into running totals.
 *
 * DSH's counts are DISJOINT: `inputTokens` is UNCACHED input only, cached input
 * travels separately, so the billed prompt is input + cacheRead + cacheWrite.
 * The displayed total prefers the adapter's own full-call `totalTokens` and
 * falls back to prompt + output when the provider omitted it.
 */
export function accumulateTokens(
	totals: TokenTotals,
	usage: TokenUsageSnapshot | undefined,
): TokenTotals {
	if (!usage) return totals;
	const cacheRead = positive(usage.cacheReadTokens);
	const prompt =
		positive(usage.inputTokens) + cacheRead + positive(usage.cacheWriteTokens);
	const billed =
		usage.totalTokens !== undefined && Number.isFinite(usage.totalTokens)
			? positive(usage.totalTokens)
			: prompt + positive(usage.outputTokens);
	if (billed <= 0 && prompt <= 0) return totals;
	return {
		tokens: totals.tokens + billed,
		prompt: totals.prompt + prompt,
		cacheRead: totals.cacheRead + cacheRead,
	};
}

/**
 * Cache-hit share of the billed prompt as a whole percent, or undefined when
 * nothing was billed / nothing came from cache (0% is noise, not information).
 */
export function cacheHitPercent(totals: TokenTotals): number | undefined {
	if (totals.prompt <= 0 || totals.cacheRead <= 0) return undefined;
	return Math.round((totals.cacheRead / totals.prompt) * 100);
}

/**
 * Compact count as rendered in the header, matching DSH's footer style:
 * `999` → "999", `19300` → "19.3K", `122000` → "122K". The unit (`tok`) is
 * appended by the caller once for the whole line.
 */
export function formatTokenCount(tokens: number): string {
	const value = Math.max(0, Math.round(tokens));
	if (value < 1000) return String(value);
	if (value < 100_000) {
		const rounded = Number((value / 1000).toFixed(1));
		// 19.3K reads well; 100.0K would not — that boundary rounds to a whole K.
		return `${rounded >= 100 ? Math.round(rounded) : rounded.toFixed(1)}K`;
	}
	return `${Math.round(value / 1000)}K`;
}

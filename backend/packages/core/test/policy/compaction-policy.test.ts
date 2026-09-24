import assert from "node:assert/strict";
import test from "node:test";
import { decideCompaction } from "../../src/policy/compaction-policy.ts";

test("compacts only when the usable input budget is crossed", () => {
	assert.deepEqual(
		decideCompaction({
			usedTokens: 90,
			tokenLimit: 100,
			reservedOutputTokens: 20,
		}),
		{ shouldCompact: true, reason: "context_limit" },
	);
	assert.deepEqual(
		decideCompaction({
			usedTokens: 79,
			tokenLimit: 100,
			reservedOutputTokens: 20,
		}),
		{ shouldCompact: false, reason: null },
	);
});

test("clamps trigger ratios to the supported zero-to-one interval", () => {
	assert.deepEqual(
		decideCompaction({
			usedTokens: 81,
			tokenLimit: 100,
			reservedOutputTokens: 0,
			triggerRatio: 0.8,
		}),
		{ shouldCompact: true, reason: "context_limit" },
	);
	assert.deepEqual(
		decideCompaction({
			usedTokens: 99,
			tokenLimit: 100,
			reservedOutputTokens: 0,
			triggerRatio: 2,
		}),
		{ shouldCompact: false, reason: null },
	);
});

test("keeps a carried prefix out of the trigger under the prefix scope", () => {
	const carriedPrefix = {
		usedTokens: 90,
		tokenLimit: 100,
		reservedOutputTokens: 20,
		baseContextTokens: 80,
	} as const;

	assert.deepEqual(
		decideCompaction({ ...carriedPrefix, scope: "total" }),
		{ shouldCompact: true, reason: "context_limit" },
	);
	assert.deepEqual(
		decideCompaction({ ...carriedPrefix, scope: "body_after_prefix" }),
		{ shouldCompact: false, reason: null },
	);
});

test("still compacts at the hard limit under the prefix scope", () => {
	assert.deepEqual(
		decideCompaction({
			usedTokens: 90,
			tokenLimit: 100,
			reservedOutputTokens: 20,
			baseContextTokens: 80,
			scope: "body_after_prefix",
			hardLimitTokens: 90,
		}),
		{ shouldCompact: true, reason: "context_limit" },
	);
});

test("rejects an unknown scope and an impossible prefix", () => {
	assert.throws(
		() => decideCompaction({
			usedTokens: 10,
			tokenLimit: 100,
			reservedOutputTokens: 0,
			scope: "everything" as "total",
		}),
		RangeError,
	);
	assert.throws(
		() => decideCompaction({
			usedTokens: 10,
			tokenLimit: 100,
			reservedOutputTokens: 0,
			baseContextTokens: 11,
		}),
		RangeError,
	);
});

test("never compacts when only the fresh suffix crosses the budget", () => {
	assert.deepEqual(
		decideCompaction({
			usedTokens: 90,
			freshSuffixTokens: 90,
			tokenLimit: 100,
			reservedOutputTokens: 20,
		}),
		{ shouldCompact: false, reason: null },
	);
	assert.deepEqual(
		decideCompaction({
			usedTokens: 90,
			freshSuffixTokens: 10,
			tokenLimit: 100,
			reservedOutputTokens: 20,
		}),
		{ shouldCompact: true, reason: "context_limit" },
	);
});

test("rejects non-finite, fractional, negative, and inconsistent token counts", () => {
	for (const input of [
		{ usedTokens: Number.POSITIVE_INFINITY, tokenLimit: 100, reservedOutputTokens: 0 },
		{ usedTokens: 1.5, tokenLimit: 100, reservedOutputTokens: 0 },
		{ usedTokens: -1, tokenLimit: 100, reservedOutputTokens: 0 },
		{ usedTokens: 1, tokenLimit: -1, reservedOutputTokens: 0 },
		{ usedTokens: 1, tokenLimit: 100, reservedOutputTokens: -1 },
		{
			usedTokens: 1,
			freshSuffixTokens: 2,
			tokenLimit: 100,
			reservedOutputTokens: 0,
		},
	]) {
		assert.throws(() => decideCompaction(input), RangeError);
	}
	assert.throws(
		() => decideCompaction({
			usedTokens: 1,
			tokenLimit: 100,
			reservedOutputTokens: 0,
			triggerRatio: Number.NaN,
		}),
		RangeError,
	);
});

import assert from "node:assert/strict";
import test from "node:test";
import * as tools from "../../src/index.ts";

interface BoundedFileDiff {
	readonly diff: string;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly truncated: boolean;
	readonly omittedChars: number;
}

type DiffFactory = (path: string, before: string, after: string) => BoundedFileDiff;

test("creates a unified diff with stable added and removed counts", () => {
	const createBoundedUnifiedDiff = requiredDiffFactory();
	const result = createBoundedUnifiedDiff("src/a.ts", "old\nkeep\n", "new\nkeep\nadded\n");

	assert.equal(result.diff.includes("--- src/a.ts:before"), true);
	assert.equal(result.diff.includes("+++ src/a.ts:after"), true);
	assert.equal(result.addedLines, 2);
	assert.equal(result.removedLines, 1);
	assert.equal(result.truncated, false);
	assert.equal(result.omittedChars, 0);
});

test("bounds large unified diffs while retaining full change counts", () => {
	const createBoundedUnifiedDiff = requiredDiffFactory();
	const result = createBoundedUnifiedDiff("a.txt", "old\n", "new\n".repeat(6_000));

	assert.ok(result.diff.length <= 200_000);
	assert.ok(result.diff.split("\n").length <= 5_000);
	assert.equal(result.addedLines, 6_000);
	assert.equal(result.removedLines, 1);
	assert.equal(result.truncated, true);
	assert.ok(result.omittedChars > 0);
	assert.equal(result.diff.includes("diff truncated"), true);
});

function requiredDiffFactory(): DiffFactory {
	const value = Reflect.get(tools, "createBoundedUnifiedDiff");
	assert.equal(typeof value, "function", "createBoundedUnifiedDiff must be exported");
	return value as DiffFactory;
}

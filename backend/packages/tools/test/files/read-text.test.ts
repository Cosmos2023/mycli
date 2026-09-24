import assert from "node:assert/strict";
import {
	mkdtemp,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as tools from "../../src/index.ts";

test("reads a one-based bounded range with continuation metadata", async (t) => {
	const fixture = await textFixture(t, "one\ntwo\nthree\nfour\nfive\n");
	const result = await readTextWindow()(fixture.path, {
		offset: 2,
		limit: 2,
		signal: new AbortController().signal,
	});

	assert.equal(result.content,
		"two\nthree\n... (output truncated, showing 2 of 5 lines; use offset=4 with limit to continue)\n");
	assert.equal(result.totalLines, 5);
	assert.equal(result.shownLines, 2);
	assert.equal(result.truncated, true);
	assert.equal(result.capped, false);
	assert.equal(result.requestedLimit, 2);
	assert.equal(result.effectiveLimit, 2);
	assert.equal(result.limitClamped, false);
	assert.equal(result.size, 24);
	assert.match(result.sha256, /^[0-9a-f]{64}$/);
	assert.match(result.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("handles empty files, zero limits, CRLF, and clamps at 500 lines", async (t) => {
	const empty = await textFixture(t, "", "empty.txt");
	const crlf = await textFixture(t, "alpha\r\nbeta\r\n", "crlf.txt");
	const many = await textFixture(t, Array.from({ length: 510 }, (_, index) => `line-${index + 1}`).join("\n"), "many.txt");
	const signal = new AbortController().signal;

	const emptyResult = await readTextWindow()(empty.path, { offset: 1, limit: 20, signal });
	assert.equal(emptyResult.content, "");
	assert.equal(emptyResult.size, 0);
	assert.equal(emptyResult.sha256,
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	assert.equal(emptyResult.totalChars, 0);
	assert.equal(emptyResult.totalLines, 0);
	assert.equal(emptyResult.shownLines, 0);
	assert.equal(emptyResult.truncated, false);
	assert.equal((await readTextWindow()(crlf.path, { offset: 1, limit: 2, signal })).content,
		"alpha\nbeta\n");
	const zero = await readTextWindow()(many.path, { offset: 1, limit: 0, signal });
	assert.equal(zero.shownLines, 0);
	assert.equal(zero.content,
		"... (output truncated, showing 0 of 510 lines; use offset=1 with limit to continue)\n");
	const clamped = await readTextWindow()(many.path, { offset: 1, limit: 900, signal });
	assert.equal(clamped.effectiveLimit, 500);
	assert.equal(clamped.shownLines, 500);
	assert.equal(clamped.limitClamped, true);
});

test("stops at the character budget and keeps the continuation offset honest", async (t) => {
	const lines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
	const fixture = await textFixture(t, `${lines.join("\n")}\n`, "budget.txt");
	const result = await readTextWindow()(fixture.path, {
		offset: 1,
		limit: 20,
		signal: new AbortController().signal,
		maxChars: 60,
	});

	assert.equal(result.capped, true);
	assert.equal(result.truncated, true);
	assert.ok(result.shownLines > 0, "capping must still return a usable window");
	assert.ok(result.shownLines < lines.length, `expected fewer than ${lines.length} lines`);
	assert.equal(result.content.includes(lines[result.shownLines]), false);
	assert.match(result.content,
		new RegExp(`\\.\\.\\. \\(output capped, showing ${result.shownLines} of ${lines.length} lines; `
			+ `use offset=${1 + result.shownLines} with limit to continue\\)`, "u"));
});

test("preserves multibyte UTF-8 and truncates individual long lines", async (t) => {
	const fixture = await textFixture(t, `你好🙂\n${"x".repeat(2_100)}\n`);
	const result = await readTextWindow()(fixture.path, {
		offset: 1,
		limit: 2,
		signal: new AbortController().signal,
	});

	assert.equal(result.content.startsWith("你好🙂\n"), true);
	assert.equal(result.content.includes(`${"x".repeat(2_000)} [... truncated]\n`), true);
	assert.equal(result.content.includes("x".repeat(2_001)), false);
});

test("rejects invalid UTF-8 and binary input with stable kinds", async (t) => {
	const invalid = await binaryFixture(t, Buffer.from([0xc3, 0x28]), "invalid.txt");
	const binary = await binaryFixture(t, Buffer.from([0x00, 0x01, 0x02]), "binary.dat");
	const signal = new AbortController().signal;

	await assert.rejects(
		() => readTextWindow()(invalid.path, { offset: 1, limit: 20, signal }),
		hasKind("invalid_encoding"),
	);
	await assert.rejects(
		() => readTextWindow()(binary.path, { offset: 1, limit: 20, signal }),
		hasKind("binary_file"),
	);
});

interface TextResult {
	readonly content: string;
	readonly mtimeNs: string;
	readonly size: number;
	readonly sha256: string;
	readonly capturedAt: string;
	readonly totalChars: number;
	readonly totalLines: number;
	readonly shownLines: number;
	readonly truncated: boolean;
	readonly capped: boolean;
	readonly requestedLimit: number;
	readonly effectiveLimit: number;
	readonly limitClamped: boolean;
}

type Reader = (path: string, options: {
	readonly offset: number;
	readonly limit: number;
	readonly signal: AbortSignal;
	readonly maxChars?: number;
}) => Promise<TextResult>;

function readTextWindow(): Reader {
	const value = Reflect.get(tools, "readTextWindow");
	assert.equal(typeof value, "function", "readTextWindow must be exported");
	return value as Reader;
}

function hasKind(kind: string): (error: unknown) => boolean {
	return (error) => error instanceof Error && "kind" in error && error.kind === kind;
}

async function textFixture(
	t: test.TestContext,
	content: string,
	name = "fixture.txt",
): Promise<{ readonly path: string }> {
	return binaryFixture(t, Buffer.from(content, "utf8"), name);
}

async function binaryFixture(
	t: test.TestContext,
	content: Uint8Array,
	name: string,
): Promise<{ readonly path: string }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-read-text-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const path = join(root, name);
	await writeFile(path, content);
	return { path };
}

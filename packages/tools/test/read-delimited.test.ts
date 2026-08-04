import assert from "node:assert/strict";
import {
	mkdtemp,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as tools from "../src/index.ts";

test("parses quoted CSV rows and produces a numeric summary", async (t) => {
	const fixture = await delimitedFixture(t,
		'name,notes,amount\n"alpha,beta","first\nsecond",10\ngamma,plain,20\n', "data.csv");
	const result = await reader()(fixture.path, {
		offset: 1,
		limit: 20,
		signal: new AbortController().signal,
	});

	assert.deepEqual(result.headers, ["name", "notes", "amount"]);
	assert.deepEqual(result.preview, [
		{ name: "alpha,beta", notes: "first\nsecond", amount: "10" },
		{ name: "gamma", notes: "plain", amount: "20" },
	]);
	assert.equal(result.rows, 2);
	assert.equal(result.columns, 3);
	assert.equal(result.truncated, false);
	assert.deepEqual(result.numericSummary.amount, {
		count: 2,
		sum: 30,
		average: 15,
		min: 10,
		minLine: 2,
		minContext: "name=alpha,beta, notes=first second",
		max: 20,
		maxLine: 3,
		maxContext: "name=gamma, notes=plain",
	});
	assert.equal(result.content.includes('"alpha,beta"'), true);
	assert.equal(result.content.includes("Data profile:\n- amount:"), true);
});

test("parses TSV and returns an explicit offset window", async (t) => {
	const fixture = await delimitedFixture(t, "name\tvalue\na\t1\nb\t2\nc\t3\n", "data.tsv");
	const result = await reader()(fixture.path, {
		offset: 3,
		limit: 1,
		signal: new AbortController().signal,
	});

	assert.deepEqual(result.preview, [{ name: "b", value: "2" }]);
	assert.equal(result.content, "Columns: name\tvalue\nb\t2\n");
	assert.equal(result.shownLines, 1);
	assert.equal(result.truncated, true);
});

test("bounds large structured previews and rejects files above 8 MiB", async (t) => {
	const rows = Array.from({ length: 60 }, (_, index) => `row-${index + 1},${index + 1}`);
	const fixture = await delimitedFixture(t, `name,value\n${rows.join("\n")}\n`, "large.csv");
	const result = await reader()(fixture.path, {
		offset: 1,
		limit: 500,
		signal: new AbortController().signal,
	});
	assert.equal(result.preview.length, 20);
	assert.equal(result.tailPreview?.length, 10);
	assert.equal(result.truncated, true);
	assert.equal(result.shownLines, 21);

	const tooLarge = await binaryFixture(t, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61), "huge.csv");
	await assert.rejects(
		() => reader()(tooLarge.path, {
			offset: 1,
			limit: 20,
			signal: new AbortController().signal,
		}),
		hasKind("file_too_large"),
	);
});

test("rejects empty and invalid-encoding structured files", async (t) => {
	const empty = await delimitedFixture(t, "", "empty.csv");
	const invalid = await binaryFixture(t, Buffer.from([0xc3, 0x28]), "invalid.csv");
	const signal = new AbortController().signal;

	await assert.rejects(
		() => reader()(empty.path, { offset: 1, limit: 20, signal }),
		hasKind("empty_file"),
	);
	await assert.rejects(
		() => reader()(invalid.path, { offset: 1, limit: 20, signal }),
		hasKind("invalid_encoding"),
	);
});

interface DelimitedResult {
	readonly headers: readonly string[];
	readonly preview: readonly Readonly<Record<string, string>>[];
	readonly tailPreview?: readonly Readonly<Record<string, string>>[];
	readonly rows: number;
	readonly columns: number;
	readonly content: string;
	readonly numericSummary: Readonly<Record<string, unknown>>;
	readonly totalLines: number;
	readonly shownLines: number;
	readonly truncated: boolean;
}

type Reader = (path: string, options: {
	readonly offset: number;
	readonly limit: number;
	readonly signal: AbortSignal;
}) => Promise<DelimitedResult>;

function reader(): Reader {
	const value = Reflect.get(tools, "readDelimitedFile");
	assert.equal(typeof value, "function", "readDelimitedFile must be exported");
	return value as Reader;
}

function hasKind(kind: string): (error: unknown) => boolean {
	return (error) => error instanceof Error && "kind" in error && error.kind === kind;
}

async function delimitedFixture(
	t: test.TestContext,
	content: string,
	name: string,
): Promise<{ readonly path: string }> {
	return binaryFixture(t, Buffer.from(content, "utf8"), name);
}

async function binaryFixture(
	t: test.TestContext,
	content: Uint8Array,
	name: string,
): Promise<{ readonly path: string }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-read-csv-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const path = join(root, name);
	await writeFile(path, content);
	return { path };
}

import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as tools from "../src/index.ts";

test("returns bounded model-visible text with range and continuation", async (t) => {
	const fixture = await workspaceFixture(t);
	await writeFile(join(fixture.root, "README.md"), "alpha\nbeta\ngamma\n", "utf8");
	const read = createReadTool(fixture.root);

	const result = await read.execute({
		file_path: "README.md",
		offset: 1,
		limit: 2,
	}, { signal: new AbortController().signal });

	assert.equal(result.success, true);
	assert.equal(result.summary, "Read README.md");
	assert.equal(result.modelOutput,
		"Read succeeded\nPath: README.md\nRange: lines 1-2 of 3\nOutput:\nalpha\nbeta\n"
		+ "Note: output truncated; use Read with offset=3 and limit to continue.");
	const { mtimeNs, sha256, capturedAt, ...metadata } = result.metadata;
	assert.equal(assertString(mtimeNs), true);
	assert.equal(assertSha(sha256), true);
	assert.equal(assertString(capturedAt), true);
	assert.deepEqual(metadata, {
		path: "README.md",
		offset: 1,
		actualStartLine: 1,
		actualEndLine: 2,
		totalLines: 3,
		shownLines: 2,
		truncated: true,
		nextOffset: 3,
		requestedLimit: 2,
		effectiveLimit: 2,
		limitClamped: false,
		size: 17,
	});
});

test("ignores the compatibility pages argument for supported text files", async (t) => {
	const fixture = await workspaceFixture(t);
	await writeFile(join(fixture.root, "README.md"), "alpha\nbeta\n", "utf8");
	const read = createReadTool(fixture.root);

	const result = await read.execute({
		file_path: "README.md",
		offset: 1,
		limit: 2,
		pages: "1",
	}, { signal: new AbortController().signal });

	assert.equal(result.success, true);
	assert.equal(result.summary, "Read README.md");
});

test("deduplicates an unchanged range without repeating file content", async (t) => {
	const fixture = await workspaceFixture(t);
	await writeFile(join(fixture.root, "notes.txt"), "private repeated content\n", "utf8");
	const read = createReadTool(fixture.root);
	const options = { signal: new AbortController().signal };
	const argumentsValue = { file_path: "notes.txt", offset: 1, limit: 20 };

	const first = await read.execute(argumentsValue, options);
	const second = await read.execute(argumentsValue, options);

	assert.equal(first.success, true);
	assert.equal(second.success, true);
	assert.equal(second.summary, "Read notes.txt (unchanged duplicate)");
	assert.equal(second.modelOutput.includes("private repeated content"), false);
	assert.equal(second.modelOutput.includes("Status: unchanged duplicate"), true);
	assert.equal(second.metadata.dedup, true);
});

test("classifies workspace escape and unsupported structured types", async (t) => {
	const fixture = await workspaceFixture(t);
	await writeFile(join(fixture.root, "report.pdf"), "%PDF-private", "utf8");
	const read = createReadTool(fixture.root);
	const options = { signal: new AbortController().signal };

	const escaped = await read.execute({
		file_path: "../outside-secret.txt",
		offset: 1,
		limit: 20,
	}, options);
	assert.equal(escaped.success, false);
	assert.equal(escaped.errorKind, "workspace_escape");
	assert.equal(escaped.modelOutput.includes("outside-secret.txt"), true);
	assert.equal(escaped.modelOutput.includes(fixture.parent), false);

	const unsupported = await read.execute({
		file_path: "report.pdf",
		offset: 1,
		limit: 20,
		pages: "1",
	}, options);
	assert.equal(unsupported.success, false);
	assert.equal(unsupported.errorKind, "unsupported_file_type");
	assert.equal(unsupported.modelOutput.includes("%PDF-private"), false);
});

test("uses structured CSV output and caps every model result at 8000 characters", async (t) => {
	const fixture = await workspaceFixture(t);
	await writeFile(join(fixture.root, "data.csv"), "name,value\nalpha,10\nbeta,20\n", "utf8");
	await writeFile(join(fixture.root, "long.txt"), `${"x".repeat(20_000)}\n`, "utf8");
	const read = createReadTool(fixture.root);
	const options = { signal: new AbortController().signal };

	const csv = await read.execute({ file_path: "data.csv", offset: 1, limit: 20 }, options);
	assert.equal(csv.success, true);
	assert.equal(csv.modelOutput.includes("Columns: name, value"), true);
	assert.equal(csv.modelOutput.includes("Rows: 2"), true);
	assert.equal(csv.modelOutput.includes("Data profile:"), true);

	const text = await read.execute({ file_path: "long.txt", offset: 1, limit: 20 }, options);
	assert.equal(text.success, true);
	assert.ok(text.modelOutput.length <= 8_000);
	assert.equal(text.modelOutput.endsWith("Note: file read complete."), true);
});

interface AdapterResult {
	readonly success: boolean;
	readonly summary: string;
	readonly modelOutput: string;
	readonly errorKind?: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

interface ReadAdapter {
	execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: { readonly signal: AbortSignal },
	): Promise<AdapterResult>;
}

type ReadToolConstructor = new (options: { readonly workspaceRoot: string }) => ReadAdapter;

function createReadTool(workspaceRoot: string): ReadAdapter {
	const ReadTool = Reflect.get(tools, "ReadTool") as ReadToolConstructor | undefined;
	assert.equal(typeof ReadTool, "function", "ReadTool must be exported");
	return new ReadTool!({ workspaceRoot });
}

function assertString(value: unknown): boolean {
	return typeof value === "string" && value.length > 0;
}

function assertSha(value: unknown): boolean {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

async function workspaceFixture(t: test.TestContext): Promise<{
	readonly parent: string;
	readonly root: string;
}> {
	const parent = await mkdtemp(join(tmpdir(), "mycli-read-tool-"));
	t.after(async () => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "workspace");
	await mkdir(root);
	return { parent, root };
}

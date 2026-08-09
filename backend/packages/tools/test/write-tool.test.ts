import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as tools from "../src/index.ts";

interface AdapterResult {
	readonly success: boolean;
	readonly summary: string;
	readonly modelOutput: string;
	readonly errorKind?: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

interface WriteAdapter {
	execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: {
			readonly signal: AbortSignal;
			readonly executionPolicy?: ReturnType<typeof tools.executionPolicy>;
		},
	): Promise<AdapterResult>;
}

type MutationRuntime = object;

type StoreConstructor = new () => object;
type RuntimeConstructor = new (options: {
	readonly workspaceRoot: string;
	readonly snapshots: object;
}) => MutationRuntime;
type WriteConstructor = new (options: { readonly runtime: MutationRuntime }) => WriteAdapter;

test("creates a file and returns a compact add receipt with bounded metadata", async (t) => {
	const fixture = await workspaceFixture(t);
	const write = createWriteTool(fixture.root);
	const result = await write.execute({
		file_path: "src/new.ts",
		content: "export {};\n",
	}, options());

	assert.equal(result.success, true);
	assert.equal(result.summary, "Wrote src/new.ts");
	assert.equal(result.modelOutput, "Success. Updated the following files:\nA src/new.ts");
	assert.equal(result.metadata.path, "src/new.ts");
	assert.equal(result.metadata.status, "created");
	assert.equal(typeof result.metadata.diff, "string");
	assert.equal(result.metadata.addedLines, 1);
	assert.equal(result.metadata.removedLines, 0);
	assert.equal(result.metadata.diffTruncated, false);
	assert.equal(await readFile(join(fixture.root, "src", "new.ts"), "utf8"), "export {};\n");
});

test("reports overwrite and unchanged receipts without exposing file content", async (t) => {
	const fixture = await workspaceFixture(t, "old private line\n");
	const write = createWriteTool(fixture.root);
	const overwritten = await write.execute({
		file_path: "a.txt",
		content: "new private line\n",
	}, options());
	const unchanged = await write.execute({
		file_path: "a.txt",
		content: "new private line\n",
	}, options());

	assert.equal(overwritten.modelOutput, "Success. Updated the following files:\nM a.txt");
	assert.equal(overwritten.metadata.status, "overwritten");
	assert.equal(overwritten.modelOutput.includes("private"), false);
	assert.equal(unchanged.modelOutput, "No changes to a.txt");
	assert.equal(unchanged.metadata.status, "unchanged");
	assert.equal(unchanged.metadata.diff, "");
});

test("returns stale_write_snapshot without overwriting current content", async (t) => {
	const fixture = await workspaceFixture(t, "current\n");
	const result = await createWriteTool(fixture.root).execute({
		file_path: "a.txt",
		content: "new\n",
		expected_sha256: "0".repeat(64),
	}, options());

	assert.equal(result.success, false);
	assert.equal(result.errorKind, "stale_write_snapshot");
	assert.equal(result.metadata.path, "a.txt");
	assert.equal(result.metadata.errorKind, "stale_write_snapshot");
	assert.equal(result.modelOutput.includes("0".repeat(64)), false);
	assert.equal(await readFile(fixture.target, "utf8"), "current\n");
});

test("returns bounded safe failures for secret content and workspace escape", async (t) => {
	const fixture = await workspaceFixture(t, "current\n");
	const write = createWriteTool(fixture.root);
	const secret = await write.execute({
		file_path: "a.txt",
		content: "TOKEN = 'secret-value-1234'",
	}, options());
	const escaped = await write.execute({
		file_path: "../outside-private.txt",
		content: "safe",
	}, options());

	assert.equal(secret.errorKind, "secret_like_content");
	assert.equal(secret.modelOutput.includes("secret-value"), false);
	assert.equal(escaped.errorKind, "workspace_escape");
	assert.equal(escaped.modelOutput.includes(fixture.parent), false);
	assert.ok(secret.modelOutput.length <= 8_000);
	assert.ok(escaped.modelOutput.length <= 8_000);
});

test("full access writes outside the workspace while workspace access stays confined", async (t) => {
	const fixture = await workspaceFixture(t);
	const outside = join(fixture.parent, "outside.txt");
	const write = createWriteTool(fixture.root);
	const input = { file_path: outside, content: "outside\n" };

	const restricted = await write.execute(input, options());
	const unrestricted = await write.execute(input, {
		...options(),
		executionPolicy: tools.executionPolicy("full-access", fixture.root),
	});

	assert.equal(restricted.errorKind, "workspace_escape");
	assert.equal(unrestricted.success, true);
	assert.equal(unrestricted.summary, "Wrote outside.txt");
	assert.equal(unrestricted.modelOutput.includes(fixture.parent), false);
	assert.equal(String(unrestricted.metadata.diff).includes(fixture.parent), false);
	assert.equal(await readFile(outside, "utf8"), "outside\n");
});

function createWriteTool(workspaceRoot: string): WriteAdapter {
	const Store = Reflect.get(tools, "FileSnapshotStore") as StoreConstructor | undefined;
	const Runtime = Reflect.get(tools, "FileMutationRuntime") as unknown as RuntimeConstructor | undefined;
	const Write = Reflect.get(tools, "WriteTool") as unknown as WriteConstructor | undefined;
	assert.equal(typeof Store, "function", "FileSnapshotStore must be exported");
	assert.equal(typeof Runtime, "function", "FileMutationRuntime must be exported");
	assert.equal(typeof Write, "function", "WriteTool must be exported");
	const runtime = new Runtime!({ workspaceRoot, snapshots: new Store!() });
	return new Write!({ runtime });
}

function options(): { readonly signal: AbortSignal } {
	return { signal: new AbortController().signal };
}

async function workspaceFixture(t: test.TestContext, content?: string): Promise<{
	readonly parent: string;
	readonly root: string;
	readonly target: string;
}> {
	const parent = await mkdtemp(join(tmpdir(), "mycli-write-tool-"));
	t.after(async () => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "workspace");
	const target = join(root, "a.txt");
	await mkdir(root);
	if (content !== undefined) await writeFile(target, content, "utf8");
	return { parent, root, target };
}

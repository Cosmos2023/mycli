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
	readonly modelOutput: string;
	readonly errorKind?: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

interface Adapter {
	execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: { readonly signal: AbortSignal },
	): Promise<AdapterResult>;
}

type StoreConstructor = new () => object;
type RuntimeConstructor = new (options: {
	readonly workspaceRoot: string;
	readonly snapshots: object;
}) => object;
type ReadConstructor = new (options: {
	readonly workspaceRoot: string;
	readonly snapshots: object;
}) => Adapter;
type ReplaceConstructor = new (runtime: object) => Adapter;

test("Edit requires a current shared Read snapshot", async (t) => {
	const fixture = await workspaceFixture(t, "value = 1\n");
	const adapters = createAdapters(fixture.root);
	const missing = await adapters.edit.execute({
		file_path: "a.ts",
		old_string: "1",
		new_string: "2",
	}, options());
	assert.equal(missing.errorKind, "missing_read_snapshot");

	await adapters.read.execute({ file_path: "a.ts", offset: 1, limit: 20 }, options());
	await writeFile(fixture.target, "value = 3\n", "utf8");
	const stale = await adapters.edit.execute({
		file_path: "a.ts",
		old_string: "3",
		new_string: "4",
	}, options());

	assert.equal(stale.errorKind, "stale_read_snapshot");
	assert.equal(await readFile(fixture.target, "utf8"), "value = 3\n");
});

test("Edit applies one exact replacement and forces another Read afterward", async (t) => {
	const fixture = await workspaceFixture(t, "value = 1\n");
	const adapters = createAdapters(fixture.root);
	await adapters.read.execute({ file_path: "a.ts", offset: 1, limit: 20 }, options());

	const result = await adapters.edit.execute({
		file_path: "a.ts",
		old_string: "value = 1",
		new_string: "value = 2",
	}, options());
	const second = await adapters.edit.execute({
		file_path: "a.ts",
		old_string: "value = 2",
		new_string: "value = 3",
	}, options());

	assert.equal(result.success, true);
	assert.equal(result.metadata.status, "edited");
	assert.equal(result.metadata.matches, 1);
	assert.equal(result.modelOutput, "Success. Updated the following files:\nM a.ts");
	assert.equal(await readFile(fixture.target, "utf8"), "value = 2\n");
	assert.equal(second.errorKind, "stale_read_snapshot");
});

test("Patch remains a distinct first-class replacement tool", async (t) => {
	const fixture = await workspaceFixture(t, "value = 1\n");
	const adapters = createAdapters(fixture.root);
	await adapters.read.execute({ file_path: "a.ts", offset: 1, limit: 20 }, options());

	const result = await adapters.patch.execute({
		file_path: "a.ts",
		old_string: "value = 1",
		new_string: "value = 2",
	}, options());

	assert.equal(result.success, true);
	assert.equal(result.metadata.status, "patched");
	assert.equal(result.metadata.matches, 1);
	assert.equal(result.modelOutput, "Success. Updated the following files:\nM a.ts");
});

test("requires a unique match unless replace_all is true", async (t) => {
	const fixture = await workspaceFixture(t, "x = 1\nx = 1\n");
	const adapters = createAdapters(fixture.root);
	await adapters.read.execute({ file_path: "a.ts", offset: 1, limit: 20 }, options());

	const repeated = await adapters.edit.execute({
		file_path: "a.ts",
		old_string: "x = 1",
		new_string: "x = 2",
	}, options());
	const replaced = await adapters.edit.execute({
		file_path: "a.ts",
		old_string: "x = 1",
		new_string: "x = 2",
		replace_all: true,
	}, options());

	assert.equal(repeated.errorKind, "multiple_matches");
	assert.equal(replaced.success, true);
	assert.equal(replaced.metadata.matches, 2);
	assert.equal(await readFile(fixture.target, "utf8"), "x = 2\nx = 2\n");
});

test("classifies missing strings and identical replacements", async (t) => {
	const fixture = await workspaceFixture(t, "value = 1\n");
	const adapters = createAdapters(fixture.root);
	await adapters.read.execute({ file_path: "a.ts", offset: 1, limit: 20 }, options());

	const missing = await adapters.edit.execute({
		file_path: "a.ts",
		old_string: "missing",
		new_string: "new",
	}, options());
	const noOp = await adapters.patch.execute({
		file_path: "a.ts",
		old_string: "value = 1",
		new_string: "value = 1",
	}, options());

	assert.equal(missing.errorKind, "string_not_found");
	assert.equal(noOp.errorKind, "no_op");
});

test("empty old_string populates only a recently read empty file", async (t) => {
	const fixture = await workspaceFixture(t, "");
	const adapters = createAdapters(fixture.root);
	await adapters.read.execute({ file_path: "a.ts", offset: 1, limit: 20 }, options());
	const populated = await adapters.edit.execute({
		file_path: "a.ts",
		old_string: "",
		new_string: "created\n",
	}, options());

	const missingFixture = await workspaceFixture(t);
	const missingAdapters = createAdapters(missingFixture.root);
	const missing = await missingAdapters.edit.execute({
		file_path: "missing.ts",
		old_string: "",
		new_string: "created\n",
	}, options());

	assert.equal(populated.success, true);
	assert.equal(await readFile(fixture.target, "utf8"), "created\n");
	assert.equal(missing.errorKind, "missing_read_snapshot");
});

test("normalizes line-number prefixes and preserves Markdown trailing spaces", async (t) => {
	const source = await workspaceFixture(t, "value = 1\n");
	const sourceAdapters = createAdapters(source.root);
	await sourceAdapters.read.execute({ file_path: "a.ts", offset: 1, limit: 20 }, options());
	const sourceResult = await sourceAdapters.edit.execute({
		file_path: "a.ts",
		old_string: "  12\tvalue = 1   ",
		new_string: "value = 2",
	}, options());

	const markdown = await workspaceFixture(t, "line  \n", "notes.md");
	const markdownAdapters = createAdapters(markdown.root);
	await markdownAdapters.read.execute({ file_path: "notes.md", offset: 1, limit: 20 }, options());
	const markdownResult = await markdownAdapters.patch.execute({
		file_path: "notes.md",
		old_string: "line  ",
		new_string: "changed  ",
	}, options());

	assert.equal(sourceResult.success, true);
	assert.equal(markdownResult.success, true);
	assert.equal(await readFile(source.target, "utf8"), "value = 2\n");
	assert.equal(await readFile(markdown.target, "utf8"), "changed  \n");
});

function createAdapters(workspaceRoot: string): {
	readonly read: Adapter;
	readonly edit: Adapter;
	readonly patch: Adapter;
} {
	const Store = Reflect.get(tools, "FileSnapshotStore") as StoreConstructor | undefined;
	const Runtime = Reflect.get(tools, "FileMutationRuntime") as unknown as RuntimeConstructor | undefined;
	const Read = Reflect.get(tools, "ReadTool") as unknown as ReadConstructor | undefined;
	const Edit = Reflect.get(tools, "EditTool") as unknown as ReplaceConstructor | undefined;
	const Patch = Reflect.get(tools, "PatchTool") as unknown as ReplaceConstructor | undefined;
	assert.equal(typeof Store, "function", "FileSnapshotStore must be exported");
	assert.equal(typeof Runtime, "function", "FileMutationRuntime must be exported");
	assert.equal(typeof Read, "function", "ReadTool must be exported");
	assert.equal(typeof Edit, "function", "EditTool must be exported");
	assert.equal(typeof Patch, "function", "PatchTool must be exported");
	const snapshots = new Store!();
	const runtime = new Runtime!({ workspaceRoot, snapshots });
	return {
		read: new Read!({ workspaceRoot, snapshots }),
		edit: new Edit!(runtime),
		patch: new Patch!(runtime),
	};
}

function options(): { readonly signal: AbortSignal } {
	return { signal: new AbortController().signal };
}

async function workspaceFixture(
	t: test.TestContext,
	content?: string,
	filename = "a.ts",
): Promise<{ readonly root: string; readonly target: string }> {
	const parent = await mkdtemp(join(tmpdir(), "mycli-edit-patch-"));
	t.after(async () => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "workspace");
	const target = join(root, filename);
	await mkdir(root);
	if (content !== undefined) await writeFile(target, content, "utf8");
	return { root, target };
}

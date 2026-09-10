import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FileMutationPreviewChange } from "@mycli/core";
import type { PreparedMutationGuard } from "../../src/index.ts";
import * as tools from "../../src/index.ts";

interface AdapterResult {
	readonly success: boolean;
	readonly modelOutput: string;
	readonly errorKind?: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

interface Adapter {
	execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: {
			readonly signal: AbortSignal;
			readonly executionPolicy?: ReturnType<typeof tools.executionPolicy>;
			readonly sandboxOverrideApproved?: boolean;
			readonly preparedMutationGuard?: PreparedMutationGuard;
		},
	): Promise<AdapterResult>;
}

interface MutationAdapter extends Adapter {
	prepare(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: { readonly signal: AbortSignal },
	): Promise<tools.PreparedToolCall>;
	preview(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: { readonly signal: AbortSignal },
	): Promise<readonly FileMutationPreviewChange[]>;
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
type ReplaceConstructor = new (runtime: object) => MutationAdapter;

test("Edit previews the real file hunk without changing it", async (t) => {
	const before = [
		"line 1",
		"line 2",
		"line 3",
		"line 4",
		"line 5",
		"line 6",
		"line 7",
		"const value = 1;",
		"line 9",
		"line 10",
		"line 11",
		"line 12",
	].join("\n") + "\n";
	const fixture = await workspaceFixture(t, before);
	const adapters = createAdapters(fixture.root);
	await adapters.read.execute({ file_path: "a.ts", offset: 1, limit: 20 }, options());

	const changes = await adapters.edit.preview({
		file_path: "a.ts",
		old_string: "const value = 1;",
		new_string: "const value = 2;",
	}, options());

	assert.equal(changes.length, 1);
	assert.equal(changes[0]?.kind, "update");
	assert.equal(changes[0]?.path, "a.ts");
	assert.match(changes[0]?.diff ?? "", /@@ -5,7 \+5,7 @@/);
	assert.match(changes[0]?.diff ?? "", /-const value = 1;\n\+const value = 2;/);
	assert.equal(await readFile(fixture.target, "utf8"), before);
});

test("Edit reads the current file without requiring a prior Read", async (t) => {
	const fixture = await workspaceFixture(t, "value = 1\n");
	const adapters = createAdapters(fixture.root);
	const result = await adapters.edit.execute({
		file_path: "a.ts",
		old_string: "1",
		new_string: "2",
	}, options());

	assert.equal(result.success, true);
	assert.equal(result.metadata.status, "edited");
	assert.equal(await readFile(fixture.target, "utf8"), "value = 2\n");
});

test("Edit applies consecutive replacements against current file content", async (t) => {
	const fixture = await workspaceFixture(t, "value = 1\n");
	const adapters = createAdapters(fixture.root);

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
	assert.equal(second.success, true);
	assert.equal(second.metadata.matches, 1);
	assert.equal(await readFile(fixture.target, "utf8"), "value = 3\n");
});

test("Patch remains a distinct first-class structured operation tool", async (t) => {
	const fixture = await workspaceFixture(t, "value = 1\n");
	const adapters = createAdapters(fixture.root);

	const result = await adapters.patch.execute({
		operations: [{
			type: "update",
			file_path: "a.ts",
			old_string: "value = 1",
			new_string: "value = 2",
		}],
	}, options());

	assert.equal(result.success, true);
	assert.equal(result.metadata.status, "patched");
	assert.equal(result.metadata.matches, 1);
	assert.equal(result.modelOutput, "Success. Updated the following files:\nM a.ts");
});

test("replaces the first match by default and every match with replace_all", async (t) => {
	const fixture = await workspaceFixture(t, "x = 1\nx = 1\n");
	const adapters = createAdapters(fixture.root);

	const first = await adapters.edit.execute({
		file_path: "a.ts",
		old_string: "x = 1",
		new_string: "x = 2",
	}, options());
	assert.equal(first.success, true);
	assert.equal(first.metadata.matches, 1);
	assert.equal(await readFile(fixture.target, "utf8"), "x = 2\nx = 1\n");

	await writeFile(fixture.target, "x = 1\nx = 1\n", "utf8");
	const all = await adapters.edit.execute({
		file_path: "a.ts",
		old_string: "x = 1",
		new_string: "x = 2",
		replace_all: true,
	}, options());

	assert.equal(all.success, true);
	assert.equal(all.metadata.matches, 2);
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
		operations: [{
			type: "update",
			file_path: "a.ts",
			old_string: "value = 1",
			new_string: "value = 1",
		}],
	}, options());

	assert.equal(missing.errorKind, "string_not_found");
	assert.equal(noOp.errorKind, "no_op");
});

test("empty old_string populates an existing empty file only", async (t) => {
	const fixture = await workspaceFixture(t, "");
	const adapters = createAdapters(fixture.root);
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
	assert.equal(missing.errorKind, "not_found");
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
		operations: [{
			type: "update",
			file_path: "notes.md",
			old_string: "line  ",
			new_string: "changed  ",
		}],
	}, options());

	assert.equal(sourceResult.success, true);
	assert.equal(markdownResult.success, true);
	assert.equal(await readFile(source.target, "utf8"), "value = 2\n");
	assert.equal(await readFile(markdown.target, "utf8"), "changed  \n");
});

test("full access patches an outside file without a prior Read", async (t) => {
	const fixture = await workspaceFixture(t);
	const outside = join(fixture.parent, "outside.ts");
	await writeFile(outside, "value = 1\n", "utf8");
	const adapters = createAdapters(fixture.root);
	const fullAccess = {
		...options(),
		executionPolicy: tools.executionPolicy("full-access", fixture.root),
	};

	const restricted = await adapters.patch.execute({
		operations: [{
			type: "update",
			file_path: outside,
			old_string: "1",
			new_string: "2",
		}],
	}, options());
	const patched = await adapters.patch.execute({
		operations: [{
			type: "update",
			file_path: outside,
			old_string: "1",
			new_string: "2",
		}],
	}, fullAccess);

	assert.equal(restricted.errorKind, "workspace_escape");
	assert.equal(patched.success, true);
	assert.equal(patched.metadata.status, "patched");
	assert.equal(patched.modelOutput.includes(fixture.parent), false);
	assert.equal(String(patched.metadata.diff).includes(fixture.parent), false);
	assert.equal(await readFile(outside, "utf8"), "value = 2\n");
});

test("exact replacements require host approval before honoring danger-full-access", async (t) => {
	const fixture = await workspaceFixture(t);
	const outside = join(fixture.parent, "approved-outside.ts");
	await writeFile(outside, "value = 1\n", "utf8");
	const adapters = createAdapters(fixture.root);
	await adapters.read.execute({ file_path: outside, offset: 1, limit: 20 }, {
		...options(),
		executionPolicy: tools.executionPolicy("full-access", fixture.root),
	});
	const escalation = {
		operations: [{
			type: "update",
			file_path: outside,
			old_string: "value = 1",
			new_string: "value = 2",
		}],
		sandbox_permissions: "danger-full-access",
		justification: "The requested source file is outside the workspace.",
	};
	const restricted = {
		...options(),
		executionPolicy: tools.executionPolicy("workspace", fixture.root),
	};

	const forged = await adapters.edit.execute({
		file_path: outside,
		old_string: "value = 1",
		new_string: "value = 2",
		sandbox_permissions: "danger-full-access",
		justification: "The requested source file is outside the workspace.",
	}, restricted);
	const approved = await adapters.patch.execute(escalation, {
		...restricted,
		sandboxOverrideApproved: true,
	});

	assert.equal(forged.errorKind, "sandbox_override_not_approved");
	assert.equal(approved.success, true);
	assert.equal(approved.metadata.status, "patched");
	assert.equal(await readFile(outside, "utf8"), "value = 2\n");
});

test("Patch prepares and commits ordered add update delete and move operations", async (t) => {
	const fixture = await workspaceFixture(t, "value = 1\n", "source.ts");
	await writeFile(join(fixture.root, "delete.txt"), "remove me\n", "utf8");
	const adapters = createAdapters(fixture.root);
	const input = {
		operations: [
			{ type: "move", from_path: "source.ts", to_path: "moved.ts" },
			{
				type: "update",
				file_path: "moved.ts",
				old_string: "value = 1",
				new_string: "value = 2",
			},
			{ type: "add", file_path: "added.txt", content: "added\n" },
			{ type: "delete", file_path: "delete.txt" },
		],
	};
	const changes = await adapters.patch.preview(input, options());
	const result = await adapters.patch.execute(input, options());

	assert.deepEqual(changes.map((change) => change.kind), ["move", "add", "delete"]);
	assert.equal(changes[0]?.previousPath, "source.ts");
	assert.equal(result.success, true);
	assert.equal(result.metadata.status, "patched");
	assert.equal(await readFile(join(fixture.root, "moved.ts"), "utf8"), "value = 2\n");
	assert.equal(await readFile(join(fixture.root, "added.txt"), "utf8"), "added\n");
	await assert.rejects(readFile(join(fixture.root, "source.ts"), "utf8"));
	await assert.rejects(readFile(join(fixture.root, "delete.txt"), "utf8"));
});

test("Patch reapplies a prepared update to current content and preserves unrelated changes", async (t) => {
	const fixture = await workspaceFixture(t, "value = 1\nkept = before\n");
	const adapters = createAdapters(fixture.root);
	const input = {
		operations: [{
			type: "update",
			file_path: "a.ts",
			old_string: "value = 1",
			new_string: "value = 2",
		}],
	};
	const prepared = await adapters.patch.prepare(input, options());
	assert.ok(prepared.mutationGuard);
	await writeFile(fixture.target, "value = 1\nmanual = true\n", "utf8");

	const result = await adapters.patch.execute(input, {
		...options(),
		preparedMutationGuard: prepared.mutationGuard,
	});

	assert.equal(result.success, true);
	assert.equal(await readFile(fixture.target, "utf8"), "value = 2\nmanual = true\n");
});

test("Patch returns string_not_found when a prepared update no longer matches", async (t) => {
	const fixture = await workspaceFixture(t, "value = 1\n");
	const adapters = createAdapters(fixture.root);
	const input = {
		operations: [{
			type: "update",
			file_path: "a.ts",
			old_string: "value = 1",
			new_string: "value = 2",
		}],
	};
	const prepared = await adapters.patch.prepare(input, options());
	assert.ok(prepared.mutationGuard);
	await writeFile(fixture.target, "manual change\n", "utf8");

	const result = await adapters.patch.execute(input, {
		...options(),
		preparedMutationGuard: prepared.mutationGuard,
	});

	assert.equal(result.errorKind, "string_not_found");
	assert.equal(await readFile(fixture.target, "utf8"), "manual change\n");
});

test("Patch accepts the public 64-operation and 128-target preparation boundary", async (t) => {
	const fixture = await workspaceFixture(t);
	const operations = Array.from({ length: 64 }, (_, index) => ({
		type: "move",
		from_path: `source-${index}.txt`,
		to_path: `destination-${index}.txt`,
	}));
	await Promise.all(operations.map((operation, index) => (
		writeFile(join(fixture.root, operation.from_path), `content ${index}\n`, "utf8")
	)));
	const adapters = createAdapters(fixture.root);

	const prepared = await adapters.patch.prepare({ operations }, options());

	assert.ok(prepared.mutationGuard);
	assert.equal(prepared.mutationGuard.targets.length, 128);
	assert.equal(prepared.fileChanges.length, 64);
	assert.equal(prepared.fileChanges.every((change) => change.kind === "move"), true);
});

test("Patch rejects aggregate loaded source content above 8 MB before writing", async (t) => {
	const fixture = await workspaceFixture(t);
	const content = `seed\n${"x".repeat(899_995)}`;
	const operations = Array.from({ length: 9 }, (_, index) => ({
		type: "update",
		file_path: `large-${index}.txt`,
		old_string: "seed",
		new_string: "changed",
	}));
	await Promise.all(operations.map((operation) => (
		writeFile(join(fixture.root, operation.file_path), content, "utf8")
	)));
	const adapters = createAdapters(fixture.root);

	const result = await adapters.patch.execute({ operations }, options());

	assert.equal(result.errorKind, "file_too_large");
	assert.equal(await readFile(join(fixture.root, "large-0.txt"), "utf8"), content);
	assert.equal(await readFile(join(fixture.root, "large-8.txt"), "utf8"), content);
});

test("Patch rejects aggregate final content above 8 MB before creating files", async (t) => {
	const fixture = await workspaceFixture(t);
	const content = "x".repeat(900_000);
	const operations = Array.from({ length: 9 }, (_, index) => ({
		type: "add",
		file_path: `large-${index}.txt`,
		content,
	}));
	const adapters = createAdapters(fixture.root);

	const result = await adapters.patch.execute({ operations }, options());

	assert.equal(result.errorKind, "content_too_large");
	assert.deepEqual(await readdir(fixture.root), []);
});

function createAdapters(workspaceRoot: string): {
	readonly read: Adapter;
	readonly edit: MutationAdapter;
	readonly patch: MutationAdapter;
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
	): Promise<{ readonly parent: string; readonly root: string; readonly target: string }> {
	const parent = await mkdtemp(join(tmpdir(), "mycli-edit-patch-"));
	t.after(async () => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "workspace");
	const target = join(root, filename);
	await mkdir(root);
	if (content !== undefined) await writeFile(target, content, "utf8");
	return { parent, root, target };
}

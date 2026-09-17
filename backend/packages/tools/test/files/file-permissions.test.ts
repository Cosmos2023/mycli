import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalToolCall } from "@mycli/core";
import {
	ApprovalPolicy, EditTool, FileMutationRuntime, PatchTool, ToolRouter, WriteTool, executionPolicy,
	type ExecutionPolicy, type ToolExecutionOptions,
} from "../../src/index.ts";

const ORIGINAL_FILES = ["overwrite.txt", "edit.txt", "update.txt", "delete.txt", "move.txt"] as const;

test("file adapters enforce read-only before any mutation or history capture", async (t) => {
	const fixture = await permissionFixture(t);
	const policy = executionPolicy("read-only", fixture.workspace);
	for (const call of mutationCalls(fixture.workspace)) {
		const result = await fixture.router.execute(call, executionOptions(call, policy));
		assert.equal(result.success, false, call.callId);
		assert.equal(result.errorKind, "workspace_escape", call.callId);
	}
	await assertOriginalFiles(fixture.workspace);
	assert.deepEqual(fixture.history, []);
});

test("explicit writable roots authorize only the selected subdirectory", async (t) => {
	const fixture = await permissionFixture(t);
	const policy: ExecutionPolicy = {
		...executionPolicy("workspace", fixture.workspace), writableRoots: [fixture.generated],
	};
	for (const call of mutationCalls(fixture.workspace)) {
		const result = await fixture.router.execute(call, executionOptions(call, policy));
		assert.equal(result.errorKind, "workspace_escape", call.callId);
	}
	await assertOriginalFiles(fixture.workspace);
	assert.deepEqual(fixture.history, []);
	for (const call of mutationCalls(fixture.generated)) {
		const result = await fixture.router.execute(call, executionOptions(call, policy));
		assert.equal(result.success, true, `${call.callId}: ${result.modelOutput}`);
	}
	assert.equal(await readFile(join(fixture.generated, "created.txt"), "utf8"), "after\n");
	assert.equal(await readFile(join(fixture.generated, "edit.txt"), "utf8"), "after\n");
	assert.equal(await readFile(join(fixture.generated, "moved.txt"), "utf8"), "before\n");
});

test("an explicit empty write list denies workspace files even in workspace mode", async (t) => {
	const fixture = await permissionFixture(t);
	const policy: ExecutionPolicy = { ...executionPolicy("workspace", fixture.workspace), writableRoots: [] };
	for (const call of mutationCalls(fixture.workspace)) {
		const result = await fixture.router.execute(call, executionOptions(call, policy));
		assert.equal(result.errorKind, "workspace_escape", call.callId);
	}
	await assertOriginalFiles(fixture.workspace);
});

test("a prepared file preview does not carry authority into a read-only execution", async (t) => {
	const fixture = await permissionFixture(t);
	const call = mutationCalls(fixture.workspace)[1]!;
	const preview = await fixture.router.prepare(call, executionOptions(call, executionPolicy("workspace", fixture.workspace)));
	assert.ok(preview.mutationGuard);
	const result = await fixture.router.execute(call, {
		...executionOptions(call, executionPolicy("read-only", fixture.workspace)), preparedMutationGuard: preview.mutationGuard,
	});
	assert.equal(result.errorKind, "workspace_escape");
	await assertOriginalFiles(fixture.workspace);
	assert.deepEqual(fixture.history, []);
});

test("approved file overrides remain inside their runtime-owned roots", async (t) => {
	const fixture = await permissionFixture(t);
	const policy = executionPolicy("read-only", fixture.workspace);
	const override: ExecutionPolicy = {
		...executionPolicy("workspace", fixture.workspace), writableRoots: [fixture.generated],
	};
	for (const directory of [fixture.workspace, fixture.generated]) {
		for (const original of mutationCalls(directory)) {
			const call = escalatedCall(original);
			const result = await fixture.router.execute(call, {
				...executionOptions(call, policy), sandboxOverrideApproved: true, sandboxOverridePolicy: override,
			});
			assert.equal(result.success, directory === fixture.generated, `${call.callId}: ${result.modelOutput}`);
			if (directory === fixture.workspace) assert.equal(result.errorKind, "workspace_escape");
		}
	}
	await assertOriginalFiles(fixture.workspace);
});

test("read-only override cannot be widened by the approval bit", async (t) => {
	const fixture = await permissionFixture(t);
	const call = escalatedCall(mutationCalls(fixture.workspace)[0]!);
	const result = await fixture.router.execute(call, {
		...executionOptions(call, executionPolicy("workspace", fixture.workspace)),
		sandboxOverrideApproved: true, sandboxOverridePolicy: executionPolicy("read-only", fixture.workspace),
	});
	assert.equal(result.errorKind, "workspace_escape");
	await assertOriginalFiles(fixture.workspace);
});

test("Patch validates every source and destination before writing any allowed file", async (t) => {
	const fixture = await permissionFixture(t);
	const policy: ExecutionPolicy = {
		...executionPolicy("workspace", fixture.workspace), writableRoots: [fixture.generated],
	};
	for (const operation of [
		{ type: "delete", file_path: join(fixture.workspace, "delete.txt") },
		{ type: "move", from_path: join(fixture.workspace, "move.txt"), to_path: join(fixture.generated, "moved.txt") },
		{ type: "move", from_path: join(fixture.generated, "move.txt"), to_path: join(fixture.workspace, "moved.txt") },
	]) {
		const call = toolCall("mixed-patch", "Patch", { operations: [
			{ type: "add", file_path: join(fixture.generated, "created.txt"), content: "after\n" }, operation,
		] });
		const result = await fixture.router.execute(call, executionOptions(call, policy));
		assert.equal(result.errorKind, "workspace_escape");
		await assertOriginalFiles(fixture.workspace);
		await assertOriginalFiles(fixture.generated);
	}
	assert.deepEqual(fixture.history, []);
});

test("a granted directory symlink cannot write elsewhere inside the workspace", async (t) => {
	const fixture = await permissionFixture(t);
	const link = join(fixture.generated, "link");
	await symlink(fixture.workspace, link, process.platform === "win32" ? "junction" : "dir");
	const policy: ExecutionPolicy = {
		...executionPolicy("workspace", fixture.workspace), writableRoots: [fixture.generated],
	};
	for (const call of mutationCalls(link)) {
		const result = await fixture.router.execute(call, executionOptions(call, policy));
		assert.equal(result.errorKind, "workspace_escape", call.callId);
	}
	await assertOriginalFiles(fixture.workspace);
	assert.deepEqual(fixture.history, []);
});

test("full access permits file changes outside listed roots", async (t) => {
	const fixture = await permissionFixture(t);
	const policy: ExecutionPolicy = { ...executionPolicy("full-access", fixture.workspace), writableRoots: [] };
	const outside = join(fixture.parent, "outside.txt");
	const call = toolCall("full-write", "Write", { file_path: outside, content: "after\n" });
	const result = await fixture.router.execute(call, executionOptions(call, policy));
	assert.equal(result.success, true, result.modelOutput);
	assert.equal(await readFile(outside, "utf8"), "after\n");
});

test("approval resolves workspace aliases and symlink targets against canonical grants", async (t) => {
	const fixture = await permissionFixture(t);
	const alias = join(fixture.parent, "workspace-alias");
	await symlink(fixture.workspace, alias, process.platform === "win32" ? "junction" : "dir");
	await symlink(fixture.workspace, join(fixture.generated, "escape"), process.platform === "win32" ? "junction" : "dir");
	const approvals = new ApprovalPolicy({ workspaceRoot: alias });
	const policy: ExecutionPolicy = {
		...executionPolicy("workspace", fixture.workspace), writableRoots: [fixture.generated],
	};
	for (const filePath of [
		"generated/created.txt", "generated/new/deep.txt", join(alias, "generated/created.txt"), join(fixture.generated, "created.txt"),
	]) {
		assert.equal(approvals.evaluate(toolCall("alias-write", "Write", { file_path: filePath, content: "after" }), policy).kind, "allow");
	}
	for (const filePath of ["edit.txt", "generated/escape/edit.txt", "generated/escape/new/deep.txt"]) {
		assert.equal(approvals.evaluate(toolCall("alias-denied", "Write", { file_path: filePath, content: "after" }), policy).kind, "deny");
	}
});

function mutationCalls(directory: string): readonly CanonicalToolCall[] {
	const path = (name: string): string => join(directory, name);
	return [
		toolCall("write-create", "Write", { file_path: path("created.txt"), content: "after\n" }),
		toolCall("write-overwrite", "Write", { file_path: path("overwrite.txt"), content: "after\n" }),
		toolCall("edit", "Edit", { file_path: path("edit.txt"), old_string: "before", new_string: "after" }),
		toolCall("patch-add", "Patch", { operations: [{ type: "add", file_path: path("added.txt"), content: "after\n" }] }),
		toolCall("patch-update", "Patch", { operations: [{ type: "update", file_path: path("update.txt"), old_string: "before", new_string: "after" }] }),
		toolCall("patch-delete", "Patch", { operations: [{ type: "delete", file_path: path("delete.txt") }] }),
		toolCall("patch-move", "Patch", { operations: [{ type: "move", from_path: path("move.txt"), to_path: path("moved.txt") }] }),
	];
}

function toolCall(callId: string, name: string, argumentsValue: Readonly<Record<string, unknown>>): CanonicalToolCall {
	return { callId, name, argumentsJson: JSON.stringify(argumentsValue) };
}

function escalatedCall(call: CanonicalToolCall): CanonicalToolCall {
	return { ...call, argumentsJson: JSON.stringify({
		...JSON.parse(call.argumentsJson), sandbox_permissions: "danger-full-access",
		justification: "Save the requested files in the approved output directory.",
	}) };
}

function executionOptions(call: CanonicalToolCall, policy: ExecutionPolicy): ToolExecutionOptions {
	return {
		callId: call.callId, ownerTurnId: "permission-test", ownerSessionId: "permissions",
		executionPolicy: policy, signal: new AbortController().signal, publishLifecycle: () => undefined,
	};
}

async function assertOriginalFiles(directory: string): Promise<void> {
	assert.deepEqual((await readdir(directory)).filter((name) => name !== "generated").sort(), [...ORIGINAL_FILES].sort());
	for (const name of ORIGINAL_FILES) assert.equal(await readFile(join(directory, name), "utf8"), "before\n");
}

async function permissionFixture(t: test.TestContext): Promise<{
	readonly parent: string;
	readonly workspace: string;
	readonly generated: string;
	readonly router: ToolRouter;
	readonly history: string[];
}> {
	const parent = await realpath(await mkdtemp(join(tmpdir(), "mycli-file-permissions-")));
	t.after(async () => rm(parent, { recursive: true, force: true }));
	const workspace = join(parent, "workspace");
	const generated = join(workspace, "generated");
	await mkdir(generated, { recursive: true });
	for (const directory of [workspace, generated]) {
		for (const name of ORIGINAL_FILES) await writeFile(join(directory, name), "before\n");
	}
	const history: string[] = [];
	const runtime = new FileMutationRuntime({ workspaceRoot: workspace, sessionId: "permissions", history: {
		capture: async (input) => { history.push(input.path); return undefined; },
		complete: async () => undefined,
		discard: async () => undefined,
	} });
	const adapters = [new WriteTool({ runtime }), new EditTool(runtime), new PatchTool(runtime)];
	const router = new ToolRouter({ adapters, exposure: adapters.map((adapter) => adapter.definition) });
	return { parent, workspace, generated, router, history };
}

test("denied reads also prevent mutation previews, overrides, and history disclosure", async (t) => {
	const fixture = await permissionFixture(t);
	const policy: ExecutionPolicy = { ...executionPolicy("full-access", fixture.workspace), deniedReadRoots: [fixture.workspace] };
	for (const original of mutationCalls(fixture.workspace)) {
		const call = escalatedCall(original);
		const options: ToolExecutionOptions = { ...executionOptions(call, policy), sandboxOverrideApproved: true,
			sandboxOverridePolicy: executionPolicy("full-access", fixture.workspace) };
		const preview = await fixture.router.prepare(call, options);
		assert.equal(preview.mutationGuard, undefined);
		const result = await fixture.router.execute(call, options);
		assert.equal(result.success, false, call.callId);
		assert.equal(result.errorKind, "permission_denied", call.callId);
	}
	assert.deepEqual(fixture.history, []);
	await assertOriginalFiles(fixture.workspace);
});

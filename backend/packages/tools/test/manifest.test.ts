import assert from "node:assert/strict";
import test from "node:test";
import * as tools from "../src/index.ts";

interface ManifestTool {
	readonly id: string;
	readonly name: string;
	readonly parameters: readonly { readonly name: string; readonly required: boolean }[];
	readonly inputSchema: Readonly<Record<string, unknown>>;
	readonly risk_level: string;
	readonly supports_parallel_tool_calls: boolean;
	readonly approval_policy: string;
	readonly capability_tags: readonly string[];
	readonly effects: Readonly<Record<string, unknown>>;
	readonly model_visible: boolean;
}

interface Manifest {
	readonly schema_version: number;
	readonly source: string;
	readonly toolsets: readonly unknown[];
	readonly tools: readonly ManifestTool[];
}

test("built-in manifest exposes stable file interaction and terminal tool inventories", () => {
	const manifest = builtinManifest();

	assert.equal(manifest.schema_version, 1);
	assert.equal(manifest.source, "builtin");
	assert.deepEqual(manifest.toolsets, [
		{ id: "file", tool_count: 4 },
		{ id: "interaction", tool_count: 1 },
		{ id: "terminal", tool_count: 6 },
	]);
	assert.deepEqual(manifest.tools.map((tool) => tool.name), [
		"Read",
		"Edit",
		"Patch",
		"Write",
		"AskUserQuestion",
		"Shell",
		"WriteStdin",
		"Bash",
		"ShellOutput",
		"BashOutput",
		"KillShell",
	]);
	assert.deepEqual(manifest.tools.map((tool) => tool.id), [
		"builtin:Read",
		"builtin:Edit",
		"builtin:Patch",
		"builtin:Write",
		"builtin:AskUserQuestion",
		"builtin:Shell",
		"builtin:WriteStdin",
		"builtin:Bash",
		"builtin:ShellOutput",
		"builtin:BashOutput",
		"builtin:KillShell",
	]);
	assert.equal(JSON.stringify(manifest).includes("LS"), false);
	assert.equal(JSON.stringify(manifest).includes("Glob"), false);
	assert.equal(JSON.stringify(manifest).includes("Grep"), false);
	assert.equal(Object.isFrozen(manifest), true);
	assert.equal(Object.isFrozen(manifest.tools), true);
});

test("mutation manifest entries preserve schemas safety and effects", () => {
	const manifest = builtinManifest();
	const [read, edit, patch, write] = manifest.tools;
	assert.ok(read && edit && patch && write);
	assert.equal(read.risk_level, "low");
	assert.equal(read.supports_parallel_tool_calls, true);
	assert.equal(read.approval_policy, "auto_allow");

	for (const tool of [edit, patch, write]) {
		assert.equal(tool.risk_level, "medium");
		assert.equal(tool.supports_parallel_tool_calls, false);
		assert.equal(tool.approval_policy, "auto_allow_or_request");
		assert.deepEqual(tool.effects, { filesystem: "write", network: false, process: false });
		assert.equal(tool.capability_tags.includes("mutation"), true);
	}
	assert.deepEqual(edit.parameters.map((parameter) => [parameter.name, parameter.required]), [
		["file_path", true],
		["old_string", true],
		["new_string", true],
		["replace_all", false],
	]);
	assert.deepEqual(patch.parameters, edit.parameters);
	assert.deepEqual(write.parameters.map((parameter) => [parameter.name, parameter.required]), [
		["file_path", true],
		["content", true],
		["expected_sha256", false],
	]);
	assert.deepEqual(requiredFields(edit.inputSchema), ["file_path", "old_string", "new_string"]);
	assert.deepEqual(requiredFields(patch.inputSchema), ["file_path", "old_string", "new_string"]);
	assert.deepEqual(requiredFields(write.inputSchema), ["file_path", "content"]);
});

test("exposure planner preserves manifest order and provider schemas", () => {
	const manifest = builtinManifest();
	const planToolExposure = requiredFunction("planToolExposure");
	const exposure = planToolExposure(manifest, { shell: true }) as readonly {
		readonly name: string;
		readonly inputSchema: unknown;
	}[];

	assert.deepEqual(exposure.map((tool) => tool.name), [
		"Read",
		"Edit",
		"Patch",
		"Write",
		"AskUserQuestion",
		"Shell",
		"WriteStdin",
	]);
	assert.equal(exposure.some((tool) => tool.name === "KillShell"), false);
	const shell = manifest.tools.find((tool) => tool.name === "Shell");
	const writeStdin = manifest.tools.find((tool) => tool.name === "WriteStdin");
	assert.ok(shell && writeStdin);
	assert.deepEqual(requiredFields(shell.inputSchema), ["command"]);
	assert.deepEqual(requiredFields(writeStdin.inputSchema), ["session_id"]);
	const fileExposure = planToolExposure(manifest, { shell: false }) as readonly {
		readonly name: string;
	}[];
	assert.deepEqual(
		fileExposure.map((tool) => tool.name),
		["Read", "Edit", "Patch", "Write", "AskUserQuestion"],
	);
	assert.deepEqual(
		(planToolExposure(manifest) as readonly { readonly name: string }[])
			.map((tool) => tool.name),
		fileExposure.map((tool) => tool.name),
	);
	assert.deepEqual(
		exposure.map((tool) => tool.inputSchema),
		manifest.tools.filter((tool) => tool.model_visible).map((tool) => tool.inputSchema),
	);
});

function builtinManifest(): Manifest {
	return requiredFunction("builtinToolManifest")() as Manifest;
}

function requiredFields(schema: Readonly<Record<string, unknown>>): unknown {
	return schema.required;
}

function requiredFunction(name: string): (...args: unknown[]) => unknown {
	const value = Reflect.get(tools, name);
	assert.equal(typeof value, "function", `${name} must be exported`);
	return value as (...args: unknown[]) => unknown;
}

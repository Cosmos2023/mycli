import assert from "node:assert/strict";
import test from "node:test";
import * as tools from "../src/index.ts";

interface ManifestTool {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly parameters: readonly {
		readonly name: string;
		readonly required: boolean;
		readonly description?: string;
	}[];
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
		{ id: "permissions", tool_count: 1 },
		{ id: "planning", tool_count: 1 },
		{ id: "web", tool_count: 1 },
		{ id: "discovery", tool_count: 1 },
		{ id: "terminal", tool_count: 6 },
	]);
	assert.deepEqual(manifest.tools.map((tool) => tool.name), [
		"Read",
		"Edit",
		"Patch",
		"Write",
		"AskUserQuestion",
		"request_permissions",
		"update_plan",
		"web_fetch",
		"tool_search",
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
		"builtin:request_permissions",
		"builtin:update_plan",
		"builtin:web_fetch",
		"builtin:tool_search",
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

test("model-visible built-ins describe every provider parameter without manifest drift", () => {
	for (const tool of builtinManifest().tools.filter((candidate) => candidate.model_visible)) {
		assert.match(tool.description, /\S/u, `${tool.name} must have a description`);
		const properties = recordValue(tool.inputSchema.properties, `${tool.name}.properties`);
		const parameters = new Map(tool.parameters.map((parameter) => [parameter.name, parameter]));
		assert.deepEqual(Object.keys(properties).sort(), [...parameters.keys()].sort());

		for (const [name, propertyValue] of Object.entries(properties)) {
			const path = `${tool.name}.${name}`;
			const property = recordValue(propertyValue, path);
			const description = describedSchema(property, path);
			assert.equal(parameters.get(name)?.description, description, `${path} manifest drift`);
			assertNestedPropertyDescriptions(property, path);
		}
	}
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
		["sandbox_permissions", false],
		["justification", false],
	]);
	assert.deepEqual(patch.parameters.map((parameter) => [parameter.name, parameter.required]), [
		["operations", true],
		["sandbox_permissions", false],
		["justification", false],
	]);
	assert.deepEqual(write.parameters.map((parameter) => [parameter.name, parameter.required]), [
		["file_path", true],
		["content", true],
		["sandbox_permissions", false],
		["justification", false],
	]);
	assert.deepEqual(requiredFields(edit.inputSchema), ["file_path", "old_string", "new_string"]);
	assert.deepEqual(requiredFields(patch.inputSchema), ["operations"]);
	assert.deepEqual(requiredFields(write.inputSchema), ["file_path", "content"]);
	for (const tool of [edit, patch, write]) {
		const properties = recordValue(tool.inputSchema.properties, `${tool.name}.properties`);
		assert.deepEqual(properties.sandbox_permissions, {
			type: "string",
			description: "Filesystem permission request for this operation. Omit it or use workspace-write to keep the active turn policy; use danger-full-access only to retry this exact operation after workspace confinement denied it.",
			enum: ["workspace-write", "danger-full-access"],
		});
		assert.deepEqual(properties.justification, {
			type: "string",
			description: "User-facing approval question required with danger-full-access; omit otherwise.",
			minLength: 1,
			maxLength: 512,
		});
	}
	assert.equal(
		"expected_sha256" in recordValue(write.inputSchema.properties, "Write.properties"),
		false,
	);
	const patchProperties = recordValue(patch.inputSchema.properties, "Patch.properties");
	const operations = recordValue(patchProperties.operations, "Patch.operations");
	assert.equal(operations.minItems, 1);
	assert.equal(operations.maxItems, 64);
	const operationItems = recordValue(operations.items, "Patch.operations.items");
	const operationVariants = operationItems.oneOf;
	assert.ok(Array.isArray(operationVariants));
	const variants = operationVariants.map((value, index) => (
		recordValue(value, `Patch.operations.oneOf[${index}]`)
	));
	assert.deepEqual(variants.map((variant) => {
		const properties = recordValue(variant.properties, "Patch operation properties");
		return recordValue(properties.type, "Patch operation type").const;
	}), ["add", "update", "delete", "move"]);
	assert.deepEqual(variants.map((variant) => variant.required), [
		["type", "file_path", "content"],
		["type", "file_path", "old_string", "new_string"],
		["type", "file_path"],
		["type", "from_path", "to_path"],
	]);
	assert.deepEqual(variants.map((variant) => variant.additionalProperties), [
		false,
		false,
		false,
		false,
	]);
	for (const hostOnlyField of [
		"expected_sha256",
		"prepared_mutation_guard",
		"mtime",
		"inode",
	]) {
		assert.equal(JSON.stringify(patch.inputSchema).includes(hostOnlyField), false, hostOnlyField);
	}
});

test("planning manifest entry is low-risk non-mutating and sequential", () => {
	const plan = builtinManifest().tools.find((tool) => tool.name === "update_plan");
	assert.ok(plan);
	assert.equal(plan.risk_level, "low");
	assert.equal(plan.supports_parallel_tool_calls, false);
	assert.equal(plan.approval_policy, "auto_allow");
	assert.deepEqual(plan.effects, { filesystem: "none", network: false, process: false });
	assert.deepEqual(plan.parameters.map((parameter) => [parameter.name, parameter.required]), [
		["explanation", false],
		["plan", true],
	]);
	assert.deepEqual(requiredFields(plan.inputSchema), ["plan"]);
});

test("web and discovery manifest entries preserve bounded schemas and effect metadata", () => {
	const manifest = builtinManifest();
	const webFetch = manifest.tools.find((tool) => tool.name === "web_fetch");
	const toolSearch = manifest.tools.find((tool) => tool.name === "tool_search");
	assert.ok(webFetch && toolSearch);
	assert.deepEqual(webFetch.effects, { filesystem: "none", network: true, process: false });
	assert.deepEqual(toolSearch.effects, { filesystem: "none", network: false, process: false });
	for (const tool of [webFetch, toolSearch]) {
		assert.equal(tool.risk_level, "low");
		assert.equal(tool.approval_policy, "auto_allow");
		assert.equal(tool.supports_parallel_tool_calls, true);
	}
	assert.deepEqual(requiredFields(webFetch.inputSchema), ["url"]);
	assert.deepEqual(requiredFields(toolSearch.inputSchema), ["query"]);
});

test("exposure planner preserves manifest order and provider schemas", () => {
	const manifest = builtinManifest();
	const planToolExposure = requiredFunction("planToolExposure");
	const exposure = planToolExposure(manifest, {
		shell: true,
		requestPermissionsTool: true,
		collaborationMode: "plan",
	}) as readonly {
		readonly name: string;
		readonly inputSchema: unknown;
	}[];

	assert.deepEqual(exposure.map((tool) => tool.name), [
		"Read",
		"Edit",
		"Patch",
		"Write",
		"AskUserQuestion",
		"request_permissions",
		"update_plan",
		"web_fetch",
		"tool_search",
		"Shell",
		"WriteStdin",
	]);
	assert.equal(exposure.some((tool) => tool.name === "KillShell"), false);
	const shell = manifest.tools.find((tool) => tool.name === "Shell");
	const writeStdin = manifest.tools.find((tool) => tool.name === "WriteStdin");
	assert.ok(shell && writeStdin);
	assert.equal(shell.supports_parallel_tool_calls, true);
	assert.equal(writeStdin.supports_parallel_tool_calls, false);
	assert.deepEqual(requiredFields(shell.inputSchema), ["command"]);
	assert.deepEqual(shell.parameters.map((parameter) => [parameter.name, parameter.required]), [
		["command", true],
		["description", false],
		["cwd", false],
		["tty", false],
		["yield_time_ms", false],
		["max_output_tokens", false],
		["prefix_rule", false],
		["sandbox_permissions", false],
	]);
	const shellProperties = Reflect.get(shell.inputSchema, "properties") as Readonly<Record<string, unknown>>;
	assert.deepEqual(shellProperties.description, {
		type: "string",
		minLength: 1,
		maxLength: 512,
		description: "Brief user-facing description of what the command does. It does not affect execution, safety classification, or permissions.",
	});
	assert.deepEqual(
		shellProperties.sandbox_permissions,
		{
			type: "string",
			enum: ["use_default", "require_escalated"],
			description: "Per-command sandbox override. Defaults to use_default; use require_escalated only when the command must run outside the active sandbox.",
		},
	);
	assert.deepEqual(requiredFields(writeStdin.inputSchema), ["session_id"]);
	const fileExposure = planToolExposure(manifest, { shell: false }) as readonly {
		readonly name: string;
	}[];
	assert.deepEqual(
		fileExposure.map((tool) => tool.name),
		["Read", "Edit", "Patch", "Write", "update_plan", "web_fetch", "tool_search"],
	);
	assert.deepEqual(
		(planToolExposure(manifest, {
			shell: false,
			requestPermissionsTool: true,
		}) as readonly { readonly name: string }[]).map((tool) => tool.name),
		["Read", "Edit", "Patch", "Write", "request_permissions", "update_plan", "web_fetch", "tool_search"],
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

function assertNestedPropertyDescriptions(
	schema: Readonly<Record<string, unknown>>,
	path: string,
): void {
	const properties = schema.properties;
	if (properties !== undefined) {
		for (const [name, value] of Object.entries(recordValue(properties, `${path}.properties`))) {
			const nestedPath = `${path}.${name}`;
			const property = recordValue(value, nestedPath);
			describedSchema(property, nestedPath);
			assertNestedPropertyDescriptions(property, nestedPath);
		}
	}
	const items = schema.items;
	if (items !== undefined) {
		assertNestedPropertyDescriptions(recordValue(items, `${path}.items`), `${path}[]`);
	}
	const oneOf = schema.oneOf;
	if (oneOf !== undefined) {
		assert.ok(Array.isArray(oneOf), `${path}.oneOf must be an array`);
		for (const [index, value] of oneOf.entries()) {
			assertNestedPropertyDescriptions(
				recordValue(value, `${path}.oneOf[${index}]`),
				`${path}.oneOf[${index}]`,
			);
		}
	}
}

function describedSchema(schema: Readonly<Record<string, unknown>>, path: string): string {
	assert.equal(typeof schema.description, "string", `${path} must have a description`);
	assert.match(schema.description as string, /\S/u, `${path} description must be non-empty`);
	return schema.description as string;
}

function recordValue(value: unknown, path: string): Readonly<Record<string, unknown>> {
	assert.equal(typeof value, "object", `${path} must be an object`);
	assert.notEqual(value, null, `${path} must be an object`);
	assert.equal(Array.isArray(value), false, `${path} must be an object`);
	return value as Readonly<Record<string, unknown>>;
}

function requiredFunction(name: string): (...args: unknown[]) => unknown {
	const value = Reflect.get(tools, name);
	assert.equal(typeof value, "function", `${name} must be exported`);
	return value as (...args: unknown[]) => unknown;
}

import assert from "node:assert/strict";
import test from "node:test";
import * as tools from "../src/index.ts";

const readDefinition = {
	id: "builtin:Read",
	name: "Read",
	description: "Read a bounded file range from the workspace.",
	inputSchema: {
		type: "object",
		properties: {
			file_path: { type: "string", minLength: 1 },
			offset: { type: "integer", minimum: 1 },
			limit: { type: "integer", minimum: 0 },
			pages: { type: "string" },
		},
		required: ["file_path", "offset", "limit"],
		additionalProperties: false,
	},
} as const;

test("routes a valid exposed call with parsed arguments", async () => {
	const calls: unknown[] = [];
	const router = createRouter({
		definition: readDefinition,
		execute: async (argumentsValue: unknown) => {
			calls.push(argumentsValue);
			return success("call-1");
		},
	});

	const result = await router.execute({
		callId: "call-1",
		name: "Read",
		argumentsJson: "{\"file_path\":\"README.md\",\"offset\":1,\"limit\":20}",
	}, { signal: new AbortController().signal });

	assert.deepEqual(calls, [{ file_path: "README.md", offset: 1, limit: 20 }]);
	assert.deepEqual(result, success("call-1"));
});

test("reports parallel support only for explicitly configured routes", () => {
	const router = createRouter(adapterThatMustNotRun(), new Set(["Read"]));

	assert.equal(router.supportsParallelToolCalls?.({
		callId: "call-read",
		name: "Read",
		argumentsJson: "{}",
	}), true);
	assert.equal(router.supportsParallelToolCalls?.({
		callId: "call-unknown",
		name: "Unknown",
		argumentsJson: "{}",
	}), false);
});

test("returns bounded failures for malformed and non-object JSON", async () => {
	const router = createRouter(adapterThatMustNotRun());
	for (const argumentsJson of ["{", "[1,2]", "null"] as const) {
		const result = await router.execute({
			callId: "call-invalid",
			name: "Read",
			argumentsJson,
		}, { signal: new AbortController().signal });
		assert.equal(result.success, false);
		assert.equal(result.errorKind, "invalid_arguments");
		assert.equal(result.modelOutput.includes(argumentsJson), false);
	}
});

test("rejects schema-invalid arguments without invoking the adapter", async () => {
	const router = createRouter(adapterThatMustNotRun());
	const result = await router.execute({
		callId: "call-invalid",
		name: "Read",
		argumentsJson: "{\"file_path\":\"README.md\",\"offset\":0,\"limit\":20,\"secret\":\"no\"}",
	}, { signal: new AbortController().signal });

	assert.equal(result.success, false);
	assert.equal(result.errorKind, "invalid_arguments");
	assert.equal(result.modelOutput, "Read failed\nError kind: invalid_arguments\nError: Invalid tool arguments.");
});

test("rejects unknown and retired tools without fallback", async () => {
	const router = createRouter(adapterThatMustNotRun());
	for (const name of ["LS", "Glob", "Grep", "Unknown"] as const) {
		const result = await router.execute({
			callId: `call-${name}`,
			name,
			argumentsJson: "{}",
		}, { signal: new AbortController().signal });
		assert.equal(result.success, false);
		assert.equal(result.errorKind, "unknown_tool");
		assert.equal(result.modelOutput, `${name} failed\nError kind: unknown_tool\nError: Tool is not available.`);
	}
});

test("routes a hidden adapter without exposing it to the provider", async () => {
	const calls: unknown[] = [];
	const killDefinition = {
		id: "builtin:KillShell",
		name: "KillShell",
		description: "Terminate an owner-scoped shell session.",
		inputSchema: {
			type: "object",
			properties: { shell_id: { type: "string", minLength: 1 } },
			required: ["shell_id"],
			additionalProperties: false,
		},
	} as const;
	const ToolRouter = Reflect.get(tools, "ToolRouter") as unknown as new (options: {
		readonly adapters: readonly unknown[];
		readonly exposure: readonly unknown[];
	}) => Router;
	const router = new ToolRouter({
		adapters: [{
			definition: killDefinition,
			execute: async (argumentsValue: unknown) => {
				calls.push(argumentsValue);
				return {
					success: true,
					modelOutput: "Shell terminated",
					summary: "Killed shell shell-1",
					metadata: { shell_id: "shell-1" },
				};
			},
		}],
		exposure: [readDefinition],
	});

	const result = await router.execute({
		callId: "call-kill",
		name: "KillShell",
		argumentsJson: "{\"shell_id\":\"shell-1\"}",
	}, { signal: new AbortController().signal });

	assert.deepEqual(calls, [{ shell_id: "shell-1" }]);
	assert.equal(result.success, true);
});

test("bounds adapter output before it reaches session persistence", async () => {
	const router = createRouter({
		definition: readDefinition,
		execute: async () => ({
			success: true,
			modelOutput: "x".repeat(9_000),
			summary: "large output",
			metadata: {},
		}),
	});

	const result = await router.execute({
		callId: "call-large",
		name: "Read",
		argumentsJson: "{\"file_path\":\"README.md\",\"offset\":1,\"limit\":20}",
	}, { signal: new AbortController().signal });

	assert.equal(result.modelOutput.length, 8_000);
	assert.equal(Reflect.get(result, "metadata").model_output_truncated, true);
	assert.equal(Reflect.get(result, "metadata").model_output_omitted_chars, 1_000);
});

interface Adapter {
	readonly definition: typeof readDefinition;
	execute(argumentsValue: unknown, options: { readonly signal: AbortSignal }): Promise<unknown>;
}

interface Router {
	supportsParallelToolCalls?(call: {
		readonly callId: string;
		readonly name: string;
		readonly argumentsJson: string;
	}): boolean;
	execute(call: {
		readonly callId: string;
		readonly name: string;
		readonly argumentsJson: string;
	}, options: { readonly signal: AbortSignal }): Promise<{
		readonly success: boolean;
		readonly errorKind?: string;
		readonly modelOutput: string;
	}>;
}

function createRouter(adapter: Adapter, parallelToolNames?: ReadonlySet<string>): Router {
	const ToolRouter = Reflect.get(tools, "ToolRouter") as unknown as
		| (new (options: {
			readonly adapters: readonly Adapter[];
			readonly exposure: readonly unknown[];
			readonly parallelToolNames?: ReadonlySet<string>;
		}) => Router)
		| undefined;
	assert.equal(typeof ToolRouter, "function", "ToolRouter must be exported");
	return new ToolRouter!({
		adapters: [adapter],
		exposure: [readDefinition],
		...(parallelToolNames ? { parallelToolNames } : {}),
	});
}

function adapterThatMustNotRun(): Adapter {
	return {
		definition: readDefinition,
		execute: async () => {
			throw new Error("adapter must not run");
		},
	};
}

function success(callId: string) {
	return {
		callId,
		toolName: "Read",
		success: true,
		modelOutput: "Read succeeded",
		summary: "Read README.md",
		metadata: { path: "README.md" },
	};
}

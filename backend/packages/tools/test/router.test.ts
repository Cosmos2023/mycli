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

test("reports parallel support only when the resolved adapter opts in", () => {
	const router = createRouter({
		...adapterThatMustNotRun(),
		supportsParallelToolCalls: true,
	});

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
	assert.equal(createRouter(adapterThatMustNotRun()).supportsParallelToolCalls?.({
		callId: "call-sequential",
		name: "Read",
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

test("dynamic routes are versioned at turn boundaries", async () => {
	const ToolRouter = Reflect.get(tools, "ToolRouter") as unknown as new (options: {
		readonly adapters: readonly Adapter[];
		readonly exposure: readonly unknown[];
	}) => Router & {
		beginTurn(turnId: string): void;
		finishTurn(turnId: string): void;
		replaceDynamicAdapters(adapters: readonly Adapter[]): void;
	};
	const router = new ToolRouter({ adapters: [adapterThatMustNotRun()], exposure: [readDefinition] });
	const dynamic = (label: string): Adapter => ({
		definition: {
			id: "mcp:docs",
			name: "McpDocs",
			description: "MCP docs fixture",
			inputSchema: {
				type: "object",
				properties: {},
				required: [],
				additionalProperties: false,
			},
		},
		execute: async () => ({
			success: true,
			modelOutput: label,
			summary: label,
			metadata: {},
		}),
	});
	const execute = (turnId: string) => router.execute({
		callId: `call-${turnId}`,
		name: "McpDocs",
		argumentsJson: "{}",
	}, {
		signal: new AbortController().signal,
		ownerSessionId: "session",
		ownerTurnId: turnId,
	});
	router.replaceDynamicAdapters([dynamic("old")]);
	router.beginTurn("turn-old");
	router.replaceDynamicAdapters([dynamic("new")]);
	router.beginTurn("turn-new");

	assert.equal((await execute("turn-old")).modelOutput, "old");
	assert.equal((await execute("turn-new")).modelOutput, "new");
	router.finishTurn("turn-old");
	router.finishTurn("turn-new");
});

test("restored turns route only dynamic tools from their frozen catalog", async () => {
	const ToolRouter = Reflect.get(tools, "ToolRouter") as unknown as new (options: {
		readonly adapters: readonly Adapter[];
		readonly exposure: readonly unknown[];
	}) => Router & {
		beginTurn(turnId: string, catalog?: {
			readonly deferredTools: readonly Adapter["definition"][];
		}): void;
		finishTurn(turnId: string): void;
		replaceDynamicAdapters(adapters: readonly Adapter[]): void;
	};
	const router = new ToolRouter({ adapters: [adapterThatMustNotRun()], exposure: [readDefinition] });
	const old = dynamicAdapter("McpDocsOld", "old");
	const added = dynamicAdapter("McpDocsNew", "new");
	router.replaceDynamicAdapters([old, added]);
	router.beginTurn("turn-restored", { deferredTools: [old.definition] });

	const execute = (name: string) => router.execute({
		callId: `call-${name}`,
		name,
		argumentsJson: "{}",
	}, {
		signal: new AbortController().signal,
		ownerSessionId: "session",
		ownerTurnId: "turn-restored",
	});
	assert.equal((await execute("McpDocsOld")).modelOutput, "old");
	assert.equal((await execute("McpDocsNew")).errorKind, "unknown_tool");
	router.finishTurn("turn-restored");
});

interface Adapter {
	readonly definition: {
		readonly id: string;
		readonly name: string;
		readonly description: string;
		readonly inputSchema: {
			readonly type: "object";
			readonly properties: Readonly<Record<string, unknown>>;
			readonly required: readonly string[];
			readonly additionalProperties: false;
		};
	};
	readonly supportsParallelToolCalls?: boolean;
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
	}, options: {
		readonly signal: AbortSignal;
		readonly ownerSessionId?: string;
		readonly ownerTurnId?: string;
	}): Promise<{
		readonly success: boolean;
		readonly errorKind?: string;
		readonly modelOutput: string;
	}>;
}

function dynamicAdapter(name: string, label: string): Adapter {
	return {
		definition: {
			id: `mcp:${name}`,
			name,
			description: `${label} MCP docs fixture`,
			inputSchema: {
				type: "object",
				properties: {},
				required: [],
				additionalProperties: false,
			},
		},
		execute: async () => ({
			success: true,
			modelOutput: label,
			summary: label,
			metadata: {},
		}),
	};
}

function createRouter(adapter: Adapter): Router {
	const ToolRouter = Reflect.get(tools, "ToolRouter") as unknown as
		| (new (options: {
			readonly adapters: readonly Adapter[];
			readonly exposure: readonly unknown[];
		}) => Router)
		| undefined;
	assert.equal(typeof ToolRouter, "function", "ToolRouter must be exported");
	return new ToolRouter!({
		adapters: [adapter],
		exposure: [readDefinition],
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

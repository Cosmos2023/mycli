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

interface Adapter {
	readonly definition: typeof readDefinition;
	execute(argumentsValue: unknown, options: { readonly signal: AbortSignal }): Promise<unknown>;
}

interface Router {
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

function createRouter(adapter: Adapter): Router {
	const ToolRouter = Reflect.get(tools, "ToolRouter") as unknown as
		| (new (options: { readonly adapters: readonly Adapter[]; readonly exposure: readonly unknown[] }) => Router)
		| undefined;
	assert.equal(typeof ToolRouter, "function", "ToolRouter must be exported");
	return new ToolRouter!({ adapters: [adapter], exposure: [readDefinition] });
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

import assert from "node:assert/strict";
import test from "node:test";
import { createErrorContext, failureScope } from "@mycli/contracts";
import { ToolRouter } from "../../src/index.ts";
import type { ToolAdapterResult, ToolExecutionOptions } from "../../src/index.ts";

const call = { callId: "call/opaque id", name: "Read", argumentsJson: "{}" };
const definition = { id: "builtin:Read", name: "Read", description: "test", inputSchema: {
	type: "object", properties: {}, additionalProperties: false,
} } as const;
const options: ToolExecutionOptions = {
	signal: new AbortController().signal, ownerSessionId: "session:test", callId: call.callId,
	errorContextVersion: 1, mutating: false, publishLifecycle: () => {},
};

test("pre-dispatch rejection has no effects and supports opaque provider call identities", async () => {
	const router = new ToolRouter({ adapters: [], exposure: [] });
	const result = await router.execute(call, options);
	assert.equal(result.errorContext?.reason, "tool.not_found");
	assert.deepEqual(result.errorContext?.scope, failureScope("tool_call", call.callId));
	assert.deepEqual(result.errorContext?.outcome, { state: "not_started", effects: "none" });
	assert.deepEqual(result.metadata.error_context, result.errorContext);
});

test("failed adapter results preserve one validated occurrence and process effect evidence", async () => {
	const context = createErrorContext({ reason: "tool.timed_out", source: "tool",
		scope: failureScope("tool_call", call.callId), outcome: { state: "unknown", effects: "possible" },
	});
	const router = routerReturning({ success: false, modelOutput: "timeout", summary: "timeout",
		errorKind: "timeout", metadata: {}, errorContext: context,
	});
	const result = await router.execute(call, options);
	assert.deepEqual(result.errorContext, context);
	assert.deepEqual(result.metadata.error_context, context);
});

test("success and legacy execution strip error extensions without changing output", async () => {
	const context = createErrorContext({ reason: "tool.path_not_found", source: "tool",
		scope: failureScope("tool_call", call.callId), outcome: { state: "failed", effects: "none" },
	});
	for (const success of [true, false]) {
		const router = routerReturning({ success, modelOutput: "output", summary: "summary",
			metadata: { error_context: context, rows: 2 }, errorContext: context,
		});
		const legacyOptions = { ...options };
		delete legacyOptions.errorContextVersion;
		const result = await router.execute(call, success ? options : legacyOptions);
		assert.equal(result.errorContext, undefined);
		assert.deepEqual(result.metadata, { rows: 2 });
		assert.equal(result.modelOutput, "output");
	}
});

function routerReturning(result: ToolAdapterResult): ToolRouter {
	return new ToolRouter({ adapters: [{ definition, execute: async () => result }], exposure: [definition] });
}

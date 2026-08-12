import assert from "node:assert/strict";
import test from "node:test";
import {
	createIntegrationId,
	createSafeDiagnostic,
	defineIntegrationRegistration,
	IntegrationLifecycleStack,
	providerSafeToolName,
} from "../src/index.ts";

test("builds deterministic bounded integration ids and provider-safe tool names", () => {
	assert.equal(createIntegrationId("mcp", "files", "read"), "mcp:files:read");
	assert.equal(
		providerSafeToolName("mcp", "github.remote", "search/code"),
		"mcp_github_remote_search_code",
	);

	const first = providerSafeToolName("mcp", "server".repeat(20), "alpha".repeat(20));
	const second = providerSafeToolName("mcp", "server".repeat(20), "bravo".repeat(20));
	assert.equal(first, providerSafeToolName("mcp", "server".repeat(20), "alpha".repeat(20)));
	assert.notEqual(first, second);
	assert.match(first, /^[A-Za-z0-9_]{1,64}$/);
	assert.throws(
		() => createIntegrationId("plugin", "x".repeat(129)),
		/integration_id_too_long/,
	);
});

test("bounds and redacts safe diagnostics without accepting exception objects", () => {
	const diagnostic = createSafeDiagnostic({
		source: "mcp",
		label: "files",
		errorClass: "connection_failed",
		summary: `connection failed token=private-value ${"x".repeat(300)}`,
	});

	assert.equal(diagnostic.source, "mcp");
	assert.equal(diagnostic.label, "files");
	assert.equal(diagnostic.errorClass, "connection_failed");
	assert.ok(diagnostic.message.length <= 160);
	assert.equal(diagnostic.message.includes("private-value"), false);
	assert.equal(Object.isFrozen(diagnostic), true);
});

test("validates and freezes integration registrations", () => {
	const registration = defineIntegrationRegistration({
		id: "mcp:files:read",
		source: "mcp",
		definition: {
			id: "mcp:files:read",
			name: "mcp_files_read",
			description: "Read a remote file.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		},
		adapter: {
			definition: {
				id: "mcp:files:read",
				name: "mcp_files_read",
				description: "Read a remote file.",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
			},
			supportsParallelToolCalls: true,
			execute: async () => ({
				success: true,
				modelOutput: "ok",
				summary: "ok",
				metadata: {},
			}),
		},
		originMetadata: { server: "files", tool: "read" },
	});

	assert.equal(Object.isFrozen(registration), true);
	assert.equal(Object.isFrozen(registration.originMetadata), true);
	assert.equal(registration.modelVisible, true);
	assert.equal(registration.supportsParallelToolCalls, true);
	const callerControlledRegistration = {
		...registration,
		supportsParallelToolCalls: false,
		modelVisible: false,
	};
	const redefined = defineIntegrationRegistration(callerControlledRegistration);
	assert.equal(redefined.modelVisible, false);
	assert.equal(redefined.supportsParallelToolCalls, true);
	assert.throws(
		() => defineIntegrationRegistration({
			...registration,
			originMetadata: Object.fromEntries(
				Array.from({ length: 17 }, (_, index) => [`key${index}`, "value"]),
			),
		}),
		/integration_origin_too_large/,
	);
});

test("closes integration lifecycles in reverse order once", async () => {
	const calls: string[] = [];
	const stack = new IntegrationLifecycleStack({ closeTimeoutMs: 50 });
	stack.add({ close: async () => { calls.push("first"); } });
	stack.add({ close: async () => { calls.push("second"); } });

	await Promise.all([stack.close(), stack.close()]);
	await stack.close();

	assert.deepEqual(calls, ["second", "first"]);
});

test("continues reverse cleanup after a bounded lifecycle timeout", async () => {
	const calls: string[] = [];
	const stack = new IntegrationLifecycleStack({ closeTimeoutMs: 5 });
	stack.add({ close: async () => { calls.push("first"); } });
	stack.add({ close: async () => new Promise<void>(() => undefined) });

	await assert.rejects(() => stack.close(), /integration_close_failed/);
	assert.deepEqual(calls, ["first"]);
});

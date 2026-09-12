import assert from "node:assert/strict";
import test from "node:test";
import type { ElicitRequestParams } from "@modelcontextprotocol/sdk/types.js";
import { McpElicitationCoordinator, mcpElicitationPrompt } from "../../src/mcp/elicitation.ts";
import { McpRequestDeadline } from "../../src/mcp/request-deadline.ts";

const owner = { sessionId: "session", turnId: "turn" };
const form: ElicitRequestParams = { message: "Choose a destination", requestedSchema: { type: "object", required: ["count", "email", "targets"], properties: {
	count: { type: "integer", minimum: 1, maximum: 5 }, email: { type: "string", format: "email" },
	targets: { type: "array", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "a,b", title: "First" }, { const: "two", title: "Second" }] } },
	confirm: { type: "boolean", default: false }, choice: { type: "string", enum: ["x", "y"], enumNames: ["X", "Y"] },
} } };

test("elicitation normalizes MCP forms and validates typed answers without coercion", () => {
	const prompt = mcpElicitationPrompt("server", owner, form);
	assert.equal(prompt.request.mode, "form");
	assert.deepEqual(prompt.request.fields.find((field) => field.name === "targets")?.options, [{ value: "a,b", label: "First" }, { value: "two", label: "Second" }]);
	assert.deepEqual(prompt.request.fields.find((field) => field.name === "choice")?.options, [{ value: "x", label: "X" }, { value: "y", label: "Y" }]);
	const content = { count: 2, email: "fixture@example.org", targets: ["a,b"] };
	assert.equal(prompt.validate({ action: "accept", content }), true);
	for (const invalid of [{ ...content, count: "2" }, { ...content, count: 0 }, { ...content, email: "bad" },
		{ ...content, targets: [] }, { ...content, targets: ["unknown"] }, { ...content, extra: "value" }]) {
		assert.equal(prompt.validate({ action: "accept", content: invalid }), false);
	}
	assert.equal(prompt.validate({ action: "decline" }), true);
	assert.equal(prompt.validate({ action: "cancel", content }), false);
	assert.throws(() => mcpElicitationPrompt("server", owner, { ...form, message: "x".repeat(4097) }));
	assert.throws(() => mcpElicitationPrompt("server", owner, { message: "Unsupported", requestedSchema: { type: "object", properties: { nested: { type: "object" } } } }));
});

test("URL elicitation allows explicit HTTPS navigation and rejects unsafe schemes", () => {
	const request = { mode: "url", message: "Sign in", elicitationId: "upstream", url: "https://example.org/login?nonce=123" };
	const prompt = mcpElicitationPrompt("server", owner, request);
	assert.equal(prompt.validate({ action: "accept" }), true);
	assert.equal(prompt.validate({ action: "accept", content: { code: "secret" } }), false);
	for (const url of ["javascript:alert(1)", "file:///tmp/file", "https://user:password@example.org", "http://example.org"]) {
		assert.throws(() => mcpElicitationPrompt("server", owner, { ...request, url }));
	}
});

test("requests without a unique live owner cancel and generation close aborts pending prompts", async () => {
	let signal: AbortSignal | undefined;
	const coordinator = new McpElicitationCoordinator("server", async (_prompt, active) => {
		signal = active;
		return new Promise((resolve) => active.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true }));
	});
	const idle = new AbortController().signal;
	assert.deepEqual(await coordinator.request(form, idle), { action: "cancel" });
	const leave = coordinator.enter(owner, idle);
	const other = coordinator.enter({ sessionId: "other", turnId: "other" }, idle);
	assert.deepEqual(await coordinator.request(form, idle), { action: "cancel" });
	other();
	const pending = coordinator.request(form, idle);
	assert.ok(signal);
	coordinator.close();
	assert.equal(signal.aborted, true);
	assert.deepEqual(await pending, { action: "cancel" });
	leave();
});

test("execution deadlines pause while a form is pending and resume after it resolves", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const deadline = new McpRequestDeadline(new AbortController().signal, 1000);
	const first = deadline.pause();
	const second = deadline.pause();
	t.mock.timers.tick(2000);
	assert.equal(deadline.signal.aborted, false);
	first();
	t.mock.timers.tick(2000);
	assert.equal(deadline.signal.aborted, false);
	second();
	t.mock.timers.tick(1001);
	assert.equal(deadline.signal.aborted, true);
	deadline.dispose();
});

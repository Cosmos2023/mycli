import assert from "node:assert/strict";
import test from "node:test";
import { McpElicitationBroker } from "../src/node-runtime/mcp-elicitation-broker.ts";
import type { McpElicitationPrompt } from "@mycli/integrations";

test("live MCP responses preserve owner identity, allow correction, and do not publish answers", async () => {
	const broker = new McpElicitationBroker();
	const notifications: unknown[] = [];
	broker.subscribe((notification) => notifications.push(notification));
	const prompt: McpElicitationPrompt = { request: { request_id: "request", session_id: "session", server_id: "docs",
		mode: "form", message: "Name", fields: [{ name: "name", label: "Name", type: "string", required: true }] },
		validate: (result) => result.action !== "accept" || result.content?.name === "private-answer" };
	const controller = new AbortController();
	const pending = broker.request(prompt, controller.signal);
	assert.throws(() => broker.respond({ request_id: "request", session_id: "other", action: "accept", content: { name: "private-answer" } }));
	assert.throws(() => broker.respond({ request_id: "request", session_id: "session", action: "accept", content: {} }));
	assert.equal(broker.pending().length, 1);
	broker.respond({ request_id: "request", session_id: "session", action: "accept", content: { name: "private-answer" } });
	assert.deepEqual(await pending, { action: "accept", content: { name: "private-answer" } });
	assert.equal(broker.pending().length, 0);
	assert.doesNotMatch(JSON.stringify(notifications), /private-answer/u);
	assert.throws(() => broker.respond({ request_id: "request", session_id: "session", action: "accept", content: { name: "private-answer" } }));
});

test("last UI disconnect cancels all pending responders and headless never waits", async () => {
	const broker = new McpElicitationBroker();
	const prompt: McpElicitationPrompt = { request: { request_id: "a", session_id: "session", server_id: "docs", mode: "url", message: "Open", url: "https://example.org", fields: [] }, validate: () => true };
	const signal = new AbortController().signal;
	assert.deepEqual(await broker.request(prompt, signal), { action: "cancel" });
	const unsubscribe = broker.subscribe(() => undefined);
	const pending = [broker.request(prompt, signal), broker.request({ ...prompt, request: { ...prompt.request, request_id: "b" } }, signal)];
	unsubscribe();
	assert.deepEqual(await Promise.all(pending), [{ action: "cancel" }, { action: "cancel" }]);
	assert.equal(broker.pending().length, 0);
});

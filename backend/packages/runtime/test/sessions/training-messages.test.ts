import assert from "node:assert/strict";
import test from "node:test";
import { TrainingMessageProjector, trainingToolDefinition } from "../../src/sessions/training/messages.ts";
import { TrainingRedactor } from "../../src/sessions/training/redaction.ts";

test("credential redaction preserves multiline formatting and schema structure", () => {
	const redactor = new TrainingRedactor({ secrets: ["known-value"], paths: [
		{ path: "/Users/person/project", replacement: "[WORKSPACE]" }, { path: "/Users/person", replacement: "[HOME]" },
	] });
	const text = 'code\n\tPASSWORD="two words"\nOPENAI_API_KEY=opaque-value\ncurl --token \'flag-secret\'\nAuthorization: Bearer bearer-secret\n{"token":"json-secret"}\nhttps://user:pass@example.com/?api_key=query-secret\nknown-value\n/Users/person/project/file\n/Users/person/file\n';
	const redacted = redactor.text(text);
	for (const secret of ["two words", "opaque-value", "flag-secret", "bearer-secret", "json-secret", "user:pass", "query-secret", "known-value", "/Users/person"]) assert.equal(redacted.includes(secret), false, secret);
	assert.equal(redacted.split("\n").length, text.split("\n").length);
	assert.match(redacted, /^code\n\tPASSWORD="\[REDACTED\]"/u);
	assert.match(redacted, /\[WORKSPACE\]\/file\n\[HOME\]\/file/u);
	assert.deepEqual(JSON.parse(redactor.text('{"password":"with spaces"}')), { password: "[REDACTED]" });
	assert.equal(redactor.text("API_KEY=known-value\nAuthorization: Bearer known-value"), "API_KEY=[REDACTED]\nAuthorization: [REDACTED]");
	const longCode = "source-part-".repeat(4_000) + "\nhttps://example.com/" + "section:".repeat(4_000);
	assert.equal(redactor.text(longCode), longCode);
	assert.deepEqual(redactor.json({ env: { APP_PASSWORD: "env-secret", PLAIN: "kept" }, headers: { Authorization: "auth-secret" }, max_tokens: 100 }), {
		env: { APP_PASSWORD: "[REDACTED]", PLAIN: "kept" }, headers: { Authorization: "[REDACTED]" }, max_tokens: 100,
	});
	assert.equal(redactor.text("-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----"), "[REDACTED]");
	assert.ok(redactor.count >= 12);
});


test("message projection preserves plaintext reasoning and image bytes with stable turn-scoped call ids", () => {
	const projector = new TrainingMessageProjector(new TrainingRedactor({ secrets: ["aW1hZ2U="] }));
	const call = { callId: "same-native-id", name: "Read", argumentsJson: '{"api_key":"secret","file_path":"x"}' };
	const first = projector.item({ type: "assistant_tool_calls", text: "Read.", calls: [call], providerState: { provider: "deepseek", value: { reasoningContent: "Stored reasoning", encrypted_content: "opaque-hidden" } } }, "first");
	const result = projector.item({ type: "tool_result", callId: call.callId, toolName: "Read", success: false, output: "aW1hZ2U=", images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] }, "first");
	const second = projector.item({ type: "assistant_tool_calls", text: "Read again.", calls: [call] }, "second");
	assert.ok(first?.role === "assistant" && second?.role === "assistant" && result?.role === "tool");
	assert.deepEqual(first.reasoning, [{ kind: "thinking", text: "Stored reasoning" }]);
	assert.equal(first.tool_calls?.[0]?.id, result.tool_call_id);
	assert.notEqual(first.tool_calls?.[0]?.id, second.tool_calls?.[0]?.id);
	assert.equal(result.content, "[REDACTED]");
	assert.equal(result.images?.[0]?.data, "aW1hZ2U=");
	assert.equal(result.is_error, true);
	assert.doesNotMatch(JSON.stringify(first), /opaque-hidden|secret/);
	const schema = trainingToolDefinition({ id: "Tool", name: "Tool", description: "Tool.", inputSchema: { type: "object", properties: { api_key: { type: "string", default: "private" } } } }, new TrainingRedactor());
	assert.deepEqual(schema.function.parameters, { type: "object", properties: { api_key: { type: "string", default: "[REDACTED]" } } });
});

test("unchanged hints are emitted once while actual repeated messages and context changes remain", () => {
	const projector = new TrainingMessageProjector(new TrainingRedactor());
	assert.ok(projector.context("permissions", "developer", "A"));
	assert.equal(projector.context("permissions", "developer", "A"), undefined);
	assert.ok(projector.context("permissions", "developer", "B"));
	assert.ok(projector.context("permissions", "developer", "A"));
	projector.removeContext("permissions");
	assert.ok(projector.context("permissions", "developer", "A"));
	assert.ok(projector.item({ type: "user", text: "repeat" }, "turn"));
	assert.ok(projector.item({ type: "user", text: "repeat" }, "turn"));
});

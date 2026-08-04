import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { createNodeGateway } from "../../dist/node-runtime/node-gateway.js";

let providerCalls = 0;
let closeCalls = 0;
const gateway = createNodeGateway({
	sessionId: "smoke-session",
	workspaceRoot: process.cwd(),
	provider: "openai",
	model: "gpt-smoke",
	runtime: {
		reserve: (submission) => ({
			kind: "reserved",
			turn: {
				schema_version: 1,
				session_id: "smoke-session",
				client_turn_id: submission.clientTurnId,
				turn_id: "smoke-turn",
				request_fingerprint: "smoke",
				status: "in_progress",
				error_code: null,
				result: null,
				started_at: "2026-08-04T00:00:00.000Z",
				completed_at: null,
			},
		}),
		submit: async (submission, emit) => {
			providerCalls += 1;
			emit({ type: "turn_started", clientTurnId: submission.clientTurnId, turnId: "smoke-turn" });
			emit({ type: "text_delta", text: "smoke ok" });
			emit({ type: "message_complete", responseId: "smoke-response" });
			emit({ type: "turn_completed", assistantText: "smoke ok", usage: {} });
			return {
				schema_version: 1,
				session_id: "smoke-session",
				client_turn_id: submission.clientTurnId,
				turn_id: "smoke-turn",
				request_fingerprint: "smoke",
				status: "completed",
				error_code: null,
				result: { assistant_text: "smoke ok", usage: {} },
				started_at: "2026-08-04T00:00:00.000Z",
				completed_at: "2026-08-04T00:00:01.000Z",
			};
		},
	},
	loadConversation: () => [],
	createTurnId: () => "smoke-turn",
	close: () => { closeCalls += 1; },
});
const messages = [];
createInterface({ input: gateway.transport.input, crlfDelay: Infinity }).on("line", (line) => {
	messages.push(JSON.parse(line));
});
const send = (id, method, params = {}) => {
	gateway.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
};
await waitFor(() => messages.some((message) => message.method === "runtime.ready"));
send("1", "session.bootstrap", { protocol_version: 1 });
await waitFor(() => messages.some((message) => message.id === "1" && message.result));
send("2", "turn.submit", {
	message: "smoke",
	client_turn_id: "smoke-client-turn",
	client_user_message_id: "smoke-user-message",
});
await waitFor(() => messages.some((message) => message.method === "message.complete" && message.params.final === true));
send("3", "shutdown");
await gateway.completion;
assert.equal(providerCalls, 1);
assert.equal(closeCalls, 1);

async function waitFor(predicate) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("node backend smoke timed out");
}

import assert from "node:assert/strict";
import test from "node:test";
import {
	agentInteractionFromArguments, agentInteractionKind, projectAgentInteraction,
	ContractValidationError, gatewayToolLifecycleRecord, parseGatewayEvent, parseGatewayToolRecord,
} from "../../src/index.ts";

test("targeted agent calls project only identity and a safe bounded message", () => {
	for (const [name, kind] of [["spawn_agent", "spawn"], ["send_message", "message"],
		["followup_task", "followup"], ["interrupt_agent", "interrupt"]] as const) {
		const args = { task_name: "review", target: "review", message: "Look at src/app.ts:12:3 token=private-key\u001b[2J\u202e",
			reason: "Stop reviewing", private: "private-field" };
		const interaction = agentInteractionFromArguments(name, JSON.stringify(args));
		assert.equal(interaction?.kind, kind);
		assert.equal(interaction?.target, "review");
		assert.equal(interaction?.message_preview, kind === "interrupt" ? "Stop reviewing" : "Look at src/app.ts:12:3 token=[REDACTED]");
		assert.doesNotMatch(JSON.stringify(interaction), /private-key|private-field|u001b|u202e/u);
		assert.deepEqual(agentInteractionFromArguments(name, args, false), { kind, target: "review" });
	}
	const preview = projectAgentInteraction({ kind: "message", target: "/root/review", message_preview: "检查😀".repeat(1_000) });
	assert.equal([...(preview?.message_preview ?? "")].length, 1_000);
	assert.equal(parseGatewayToolRecord(gatewayToolLifecycleRecord("tool.complete", { name: "send_message", agent_interaction: preview })).agent_interaction?.target, "/root/review");
});

test("agent metadata rejects malformed targets and cannot turn unrelated tools into coordination rows", () => {
	for (const target of [undefined, null, 1, "", " ", "x".repeat(513), "review\n", "review\u001b[2J", "review\u202e", "token=x ".repeat(60)]) {
		assert.equal(projectAgentInteraction({ kind: "spawn", target }), undefined);
	}
	assert.equal(projectAgentInteraction({ kind: "unknown", target: "review" }), undefined);
	assert.equal(agentInteractionFromArguments("spawn_agent", "bad-json"), undefined);
	assert.equal(agentInteractionFromArguments("spawn_agent", []), undefined);
	for (const name of ["wait_agent", "list_agents", "mcp_send_message", "plugin_spawn_agent", "Read"]) {
		assert.equal(agentInteractionKind(name), undefined);
		assert.equal(gatewayToolLifecycleRecord("tool.complete", { name, agent_interaction: { kind: "message", target: "review" } }).agent_interaction, undefined);
	}
	assert.equal(gatewayToolLifecycleRecord("tool.start", { name: "spawn_agent", agent_interaction: { kind: "message", target: "review" } }).agent_interaction, undefined);
});

test("agent interactions round-trip through closed lifecycle and tool contracts", () => {
	const interaction = { kind: "message", target: "/root/review", message_preview: "Check permissions" };
	for (const method of ["tool.start", "tool.complete", "tool.failed"] as const) {
		const params = { client_turn_id: "client", tool_id: "call", call_id: "call", name: "send_message", agent_interaction: interaction,
			...(method === "tool.start" ? { context: "send_message" } : {
				duration_s: 0.01, summary: "Message queued", summary_chars: 14, summary_truncated: false, success: method === "tool.complete",
			}) };
		const record = gatewayToolLifecycleRecord(method, params);
		parseGatewayToolRecord(JSON.parse(JSON.stringify(record)));
		parseGatewayEvent({ jsonrpc: "2.0", method, params: { ...params, tool_record: record } });
		parseGatewayEvent({ jsonrpc: "2.0", method: "runtime.event", params: {
			version: 1, sequence: 1, timestamp: 0, type: method, payload: { ...params, tool_record: record },
		} });
		for (const invalid of [{ ...interaction, extra: "private" }, { ...interaction, kind: "other" },
			{ ...interaction, target: "" }, { ...interaction, target: "x".repeat(513) }, { ...interaction, message_preview: "x".repeat(1001) }]) {
			assert.throws(() => parseGatewayToolRecord({ ...record, agent_interaction: invalid }), ContractValidationError);
		}
	}
});

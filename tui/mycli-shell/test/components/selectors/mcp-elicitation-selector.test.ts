import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { McpElicitationRequest } from "@mycli/contracts";
import { McpElicitationSelectorComponent } from "../../../src/components/selectors/mcp-elicitation-selector.ts";
import { visibleWidth } from "../../../src/tui-core/index.ts";
import { initialRuntimeState } from "../../../src/state/runtime-state-model.ts";
import { reduceRuntimeEvent } from "../../../src/state/runtime-event-reducer.ts";

const request: McpElicitationRequest = { request_id: "form", session_id: "session", server_id: "天气服务", mode: "form", message: "Choose destinations", fields: [
	{ name: "count", label: "Count", type: "integer", required: true, minimum: 1, maximum: 5 },
	{ name: "places", label: "Cities", type: "array", required: true, options: [{ value: "北京,中国", label: "北京" }, { value: "London", label: "London" }], minItems: 1 },
	{ name: "optional", label: "Notes", type: "string", required: false },
] };

test("MCP form keeps typed values and comma-containing choices until final confirmation", async () => {
	const responses: string[] = [];
	const component = new McpElicitationSelectorComponent({ request, maxHeight: () => 18, onRespond: (value) => { responses.push(value); } });
	component.handleInput("0"); component.handleInput("\r");
	assert.match(stripVTControlCharacters(component.render(40).join("\n")), /allowed\s+range/u);
	component.handleInput("\x7f"); component.handleInput("2"); component.handleInput("\r");
	component.handleInput(" "); component.handleInput("\r");
	component.handleInput("\t");
	assert.equal(responses.length, 0);
	for (const width of [18, 40, 80]) {
		const lines = component.render(width);
		assert.ok(lines.length <= 18);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	component.handleInput("\r");
	await Promise.resolve();
	assert.deepEqual(JSON.parse(responses[0]!), { action: "accept", content: { count: 2, places: ["北京,中国"] } });
});

test("escape cancels an MCP request and URL confirmation never supplies form data", async () => {
	const responses: string[] = [];
	const component = new McpElicitationSelectorComponent({ request, onRespond: (value) => { responses.push(value); } });
	component.handleInput("\x1b");
	await Promise.resolve();
	assert.deepEqual(JSON.parse(responses[0]!), { action: "cancel" });
	const url = new McpElicitationSelectorComponent({ request: { ...request, mode: "url", fields: [], url: "https://example.org/authorize" }, onRespond: (value) => { responses.push(value); } });
	assert.match(stripVTControlCharacters(url.render(70).join("\n")), /https:\/\/example.org\/authorize/u);
	url.handleInput("\r");
	await Promise.resolve();
	assert.deepEqual(JSON.parse(responses[1]!), { action: "accept" });
});

test("MCP reducer keeps requests ephemeral across status updates and ignores stale responses", () => {
	const initial = { ...initialRuntimeState(), sessionId: "session", activeTurnId: "turn", turnRunning: true };
	const pending = reduceRuntimeEvent(initial, "mcp.elicitation.request", { ...request, turn_id: "turn" });
	assert.ok(pending.pendingClarification?.elicitation);
	assert.equal(pending.transcript.length, initial.transcript.length);
	const status = reduceRuntimeEvent(pending, "status.changed", { session_id: "session", turn_id: "turn", turn_running: true, suspended_turn: false, pending_mcp_elicitation: true });
	assert.ok(status.pendingClarification?.elicitation);
	const stale = reduceRuntimeEvent(status, "mcp.elicitation.respond", { session_id: "session", request_id: "old", action: "cancel" });
	assert.ok(stale.pendingClarification?.elicitation);
	const resolved = reduceRuntimeEvent(stale, "mcp.elicitation.respond", { session_id: "session", request_id: "form", action: "accept" });
	assert.equal(resolved.pendingClarification, null);
	assert.equal(resolved.transcript.length, initial.transcript.length);
});

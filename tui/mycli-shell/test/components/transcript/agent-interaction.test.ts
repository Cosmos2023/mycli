import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { gatewayToolLifecycleRecord, type GatewayAgentInteraction } from "@mycli/contracts";
import { ToolExecutionComponent } from "../../../src/components/transcript/tool-execution.ts";
import { initialRuntimeState, type RuntimeShellState } from "../../../src/state/runtime-state-model.ts";
import { projectRuntimeState } from "../../../src/state/runtime-projection.ts";
import { reduceRuntimeEvent } from "../../../src/state/runtime-event-reducer.ts";
import { runtimeStateFromTranscript } from "../../../src/state/transcript-history.ts";
import { visibleWidth } from "../../../src/tui-core/utils.ts";
import { MycliShellRuntime } from "../../../src/application/shell-runtime.ts";
import { HeadlessTerminal } from "../../support/headless-terminal.ts";

const CASES = [
	["spawn_agent", "spawn", "Starting agent", "Started agent"],
	["send_message", "message", "Sending message to", "Sent message to"],
	["followup_task", "followup", "Assigning follow-up to", "Assigned follow-up to"],
	["interrupt_agent", "interrupt", "Requesting stop for", "Requested stop for"],
] as const;

test("targeted agent interactions render one action row through live completion and history reload", () => {
	for (const [name, kind, runningLabel, completedLabel] of CASES) {
		const interaction: GatewayAgentInteraction = { kind, target: "review", message_preview: "检查权限继承" };
		let state = lifecycle(initialRuntimeState(), "tool.start", name, interaction);
		assert.match(rendered(state), new RegExp(`${runningLabel} review`, "u"));
		assert.match(rendered(state), /检查权限继承/u);
		state = lifecycle(state, "tool.complete", name, { ...interaction, target: "/root/review" });
		state = lifecycle(state, "tool.complete", name, { ...interaction, target: "/root/review" });
		assert.equal(projectRuntimeState(state).tools.length, 1);
		assert.match(rendered(state), new RegExp(`${completedLabel} /root/review`, "u"));
		assert.doesNotMatch(rendered(state), /Agent completed|Task completed/u);
		assert.ok(!rendered(state).includes(name));
		const restored = runtimeStateFromTranscript(initialRuntimeState(), { items: state.transcript });
		assert.equal(rendered(restored), rendered(state));
		const expanded = projectRuntimeState(state).tools.map((tool) => new ToolExecutionComponent({ ...tool, expanded: true }).render(100).join("\n")).join("\n");
		assert.ok(expanded.includes(name));
	}
});

test("sparse failures and cancellations retain the agent identity and preview", () => {
	for (const status of ["error", "cancelled"] as const) {
		let state = lifecycle(initialRuntimeState(), "tool.start", "send_message", {
			kind: "message", target: "/root/review", message_preview: "检查权限继承",
		});
		const params = { call_id: "call", name: "send_message", error: "Agent unavailable" };
		const record = { ...gatewayToolLifecycleRecord("tool.failed", params), status };
		state = reduceRuntimeEvent(state, "tool.failed", { ...params, tool_record: record });
		assert.match(rendered(state), /Send message to \/root\/review/u);
		assert.match(rendered(state), status === "cancelled" ? /cancelled/u : /failed/u);
		assert.match(rendered(state), /Agent unavailable/u);
		assert.match(rendered(state), /检查权限继承/u);
		assert.doesNotMatch(rendered(state), /Sent message/u);
	}
});

test("agent previews fit narrow CJK terminals, remain bounded and expand with details", () => {
	const tool = { id: "call", name: "followup_task", status: "success" as const,
		agentInteraction: { kind: "followup" as const, target: "/root/审查权限", message_preview: "重点检查权限。" + "检查权限继承以及错误处理。".repeat(60) + "\u001b[2J" },
		detailPreview: "Message queued for the agent" };
	for (const width of [20, 40, 80, 160]) {
		for (const expanded of [false, true]) {
			const lines = new ToolExecutionComponent({ ...tool, expanded }).render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}, expanded=${expanded}`);
			assert.ok(!lines.join("\n").includes("\u001b[2J"));
			const plain = stripVTControlCharacters(lines.join("\n"));
			if (expanded) assert.match(plain, /followup_task/u);
			else {
				assert.match(plain, /expand/u);
				assert.match(plain, /重点检查/u);
				assert.ok(lines.length < 12);
			}
		}
	}
});

test("successful waits and listings stay quiet while unrelated tool names keep generic rendering", () => {
	for (const name of ["wait_agent", "list_agents"]) {
		const params = { name, call_id: "call" };
		const state = reduceRuntimeEvent(initialRuntimeState(), "tool.complete", { ...params, tool_record: gatewayToolLifecycleRecord("tool.complete", params) });
		assert.equal(projectRuntimeState(state).tools.length, 0);
	}
	for (const name of ["mcp_send_message", "plugin_spawn_agent", "Read"]) {
		const state = lifecycle(initialRuntimeState(), "tool.complete", name, { kind: "message", target: "/root/review" });
		assert.equal(projectRuntimeState(state).tools[0]?.agentInteraction, undefined);
		assert.doesNotMatch(rendered(state), /Sent message to/u);
	}
});

for (const nativeScrollback of [false, true]) {
	test(`terminal frames replace agent actions without stale rows (native=${nativeScrollback})`, async (t) => {
		const terminal = new HeadlessTerminal({ columns: 80, rows: 30, nativeScrollback });
		let state = reduceRuntimeEvent(initialRuntimeState(), "turn.started", { turn_id: "turn" });
		const runtime = new MycliShellRuntime({ initialState: projectRuntimeState(state), terminal });
		t.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
		runtime.start();
		const frame = async (): Promise<string> => {
			runtime.setState(projectRuntimeState(state));
			await delay(40);
			await terminal.flush();
			return terminal.bufferLines().join("\n");
		};
		const interaction: GatewayAgentInteraction = { kind: "spawn", target: "review", message_preview: "检查权限继承" };
		state = lifecycle(state, "tool.start", "spawn_agent", interaction);
		assert.match(await frame(), /Starting agent review/u);
		state = lifecycle(state, "tool.complete", "spawn_agent", { ...interaction, target: "/root/review" });
		for (const width of [40, 80, 120]) {
			terminal.resize(width, 30);
			await delay(120);
			const display = await frame();
			assert.equal((display.match(/Started agent \/root\/review/gu) ?? []).length, 1);
			assert.match(display, /检查权限继承/u);
			assert.doesNotMatch(display, /Starting agent/u);
		}
	});
}

function lifecycle(state: RuntimeShellState, method: "tool.start" | "tool.complete", name: string,
	interaction: GatewayAgentInteraction): RuntimeShellState {
	const params = { call_id: "call", name, agent_interaction: interaction };
	return reduceRuntimeEvent(state, method, { ...params, tool_record: gatewayToolLifecycleRecord(method, params) });
}

function rendered(state: RuntimeShellState): string {
	return stripVTControlCharacters(projectRuntimeState(state).tools.map((tool) => new ToolExecutionComponent(tool).render(100).join("\n")).join("\n"));
}

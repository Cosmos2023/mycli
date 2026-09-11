import assert from "node:assert/strict";
import test from "node:test";
import { createErrorContext, gatewayToolLifecycleRecord, projectGatewayToolRecord, type GatewayToolRecord } from "@mycli/contracts";
import { ToolExecutionComponent } from "../src/components/transcript/tool-execution.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";
import {
	initialRuntimeState,
} from "../src/state/runtime-state-model.ts";
import {
	projectRuntimeState,
} from "../src/state/runtime-projection.ts";
import {
	reduceRuntimeEvent,
} from "../src/state/runtime-event-reducer.ts";
import {
	runtimeStateFromTranscript,
} from "../src/state/transcript-history.ts";

const readRecord: GatewayToolRecord = {
	version: 1, kind: "tool_execution", name: "Read", call_id: "call", status: "success", mutating: false,
	target: "/repo/source.ts", output_preview: "public preview", duration_ms: 3,
};

test("typed tool records override conflicting legacy metadata and retain local folding and path choices", () => {
	const state = runtimeStateFromTranscript({ ...initialRuntimeState(), workspace: "/repo" }, { items: [{
		id: "tool", type: "tool_summary", text: "Wrong", folded: false, tool_record: readRecord,
		metadata: { tool_name: "Write", status: "failed", arguments: { content: "private-content" }, path: "private-path" },
	}] });
	const tool = projectRuntimeState(state).tools[0]!;
	assert.equal(tool.name, "Read");
	assert.equal(tool.args, "source.ts");
	assert.equal(tool.status, "success");
	assert.equal(tool.outputPreview, "public preview");
	assert.equal(tool.expanded, false);
	assert.doesNotMatch(JSON.stringify(tool), /private-/);
});

test("live and restored typed records render the same tool semantics", () => {
	const metadata = { tool_name: "Skill", call_id: "skill-call", skill_name: "review", status: "done", summary: "loaded", duration_ms: 100 };
	const record = projectGatewayToolRecord({ text: "Skill review", metadata });
	const resumed = runtimeStateFromTranscript(initialRuntimeState(), { items: [{ id: "history", type: "tool_summary", text: "Skill", tool_record: record, metadata: {} }] });
	const live = reduceRuntimeEvent(initialRuntimeState(), "tool.complete", { name: "Skill", tool_id: "live", call_id: "skill-call", tool_record: record });
	assert.deepEqual({ ...projectRuntimeState(live).tools[0], id: null }, { ...projectRuntimeState(resumed).tools[0], id: null });
});

test("live and restored MCP failures display HTTP and operation diagnostics", () => {
	const context = createErrorContext({ reason: "integration.unavailable", source: "integration", scope: { kind: "tool_call", id: "call:mcp" },
		outcome: { state: "unknown", effects: "possible" }, details: { operation: "tools/call", phase: "request", http_status: 503 } });
	const metadata = { name: "mcp_remote_change", call_id: "call:mcp", error_context: context };
	const record = gatewayToolLifecycleRecord("tool.failed", metadata);
	const live = reduceRuntimeEvent(initialRuntimeState(), "tool.failed", { ...metadata, tool_id: "live", tool_record: record });
	const restored = runtimeStateFromTranscript(initialRuntimeState(), { items: [{ id: "history", type: "tool_summary", text: "MCP failed", tool_record: record }] });
	for (const state of [live, restored]) {
		const tool = projectRuntimeState(state).tools[0]!;
		assert.match(tool.errorPreview ?? "", /HTTP 503.*Operation: tools\/call.*Phase: request/u);
		for (const expanded of [false, true]) for (const width of [24, 80, 160]) {
			const lines = new ToolExecutionComponent({ ...tool, expanded }).render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			if (expanded || width >= 80) assert.ok(lines.join("\n").includes("503"));
		}
	}
});

test("live and restored plugin failures preserve exit evidence at narrow widths", () => {
	const context = createErrorContext({ reason: "integration.unavailable", source: "integration", scope: { kind: "tool_call", id: "call:plugin" },
		outcome: { state: "unknown", effects: "possible" }, details: { integration: "demo", operation: "tools/call", phase: "request", exit_code: 91, legacy_kind: "plugin_worker_exited" } });
	const metadata = { name: "plugin_demo_act", call_id: "call:plugin", error_context: context };
	const record = gatewayToolLifecycleRecord("tool.failed", metadata);
	const live = reduceRuntimeEvent(initialRuntimeState(), "tool.failed", { ...metadata, tool_id: "live", tool_record: record });
	const restored = runtimeStateFromTranscript(initialRuntimeState(), { items: [{ id: "history", type: "tool_summary", text: "Plugin failed", tool_record: record }] });
	for (const state of [live, restored]) {
		const tool = projectRuntimeState(state).tools[0]!;
		assert.match(tool.errorPreview ?? "", /Exit code: 91.*Integration: demo.*plugin_worker_exited/u);
		for (const expanded of [false, true]) for (const width of [24, 80, 160]) {
			const lines = new ToolExecutionComponent({ ...tool, expanded }).render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			if (expanded || width >= 80) assert.ok(lines.join("\n").includes("91"));
		}
	}
});

test("terminal events update typed foreground records without stopping background shells", () => {
	let state = reduceRuntimeEvent(initialRuntimeState(), "turn.started", { client_turn_id: "client", turn_id: "turn" });
	state = runtimeStateFromTranscript(state, { items: [
		{ id: "read", type: "tool_summary", text: "Read", tool_record: { ...readRecord, status: "running" }, metadata: { background: true } },
		{ id: "shell", type: "tool_summary", text: "Shell", tool_record: {
			version: 1, kind: "tool_execution", name: "Shell", status: "running", mutating: false, shell: { background: true, command_preview: "serve" },
		}, metadata: {} },
	] });
	state = reduceRuntimeEvent(state, "turn.interrupted", { client_turn_id: "client", turn_id: "turn" });
	const projected = projectRuntimeState(state);
	assert.equal(projected.tools[0]?.status, "error");
	assert.equal(projected.bash[0]?.status, "running");
});

test("shell lifecycle updates a restored typed record by its call identity", () => {
	let state = runtimeStateFromTranscript(initialRuntimeState(), { items: [{
		id: "shell", type: "tool_summary", text: "Shell", metadata: {}, tool_record: {
			version: 1, kind: "tool_execution", name: "Shell", call_id: "call", status: "running", mutating: false,
			target: "echo ready", output_preview: "ready\n", shell: { shell_id: "sh", command_preview: "echo ready", sequence: 1, background: true },
		},
	}] });
	state = reduceRuntimeEvent(state, "shell.completed", {
		shell_id: "sh", call_id: "call", sequence: 2, terminal_state: "completed", process_state: "completed", exit_code: 0,
	});
	const shell = projectRuntimeState(state).bash;
	assert.equal(shell.length, 1);
	assert.equal(shell[0]?.command, "echo ready");
	assert.equal(shell[0]?.outputPreview, "ready\n");
	assert.equal(shell[0]?.status, "success");
});

test("restored shell sequence and canonical identity fence stale events and conflicting legacy metadata", () => {
	const state = runtimeStateFromTranscript(initialRuntimeState(), { items: [{
		id: "shell", type: "tool_summary", text: "Shell", metadata: {
			tool_name: "Bash", call_id: "wrong-call", shell_id: "wrong-shell", command: "private-command",
			display: { status: "error", summary: "private-summary", detail: "private-output", error: "private-error" },
		}, tool_record: {
			version: 1, kind: "tool_execution", name: "Shell", call_id: "call", status: "running", mutating: false,
			target: "serve", shell: { shell_id: "sh", sequence: 4, background: true, transport: "pty", tty: true, started_at: "start" },
		},
	}] });
	for (const sequence of [3, 4]) {
		assert.equal(reduceRuntimeEvent(state, "shell.completed", { shell_id: "sh", call_id: "call", sequence, terminal_state: "completed" }), state);
	}
	const updated = reduceRuntimeEvent(state, "shell.output", { shell_id: "sh", sequence: 5, output_delta: "ready\n" });
	const shell = projectRuntimeState(updated).bash[0]!;
	assert.equal(updated.transcript.length, 1);
	assert.equal(shell.callId, "call");
	assert.equal(shell.command, "serve");
	assert.equal(shell.background, true);
	assert.equal(shell.transport, "pty");
	assert.equal(shell.tty, true);
	assert.equal(shell.startedAt, "start");
	assert.equal(shell.outputPreview, "ready\n");
	assert.doesNotMatch(JSON.stringify(updated.transcript[0]?.tool_record), /private-/);
});

test("tool return cannot overwrite a newer shell lifecycle record even with a display envelope", () => {
	let state = reduceRuntimeEvent(initialRuntimeState(), "shell.started", {
		shell_id: "sh", call_id: "call", sequence: 1, command_preview: "serve", background: true, output_delta: "ready\n",
	});
	const params = { name: "Bash", call_id: "call", display: {
		status: "success", summary: "invocation returned", detail: "old output", presentation: "shell", metrics: { duration_ms: 12 },
	} };
	state = reduceRuntimeEvent(state, "tool.complete", { ...params, tool_record: gatewayToolLifecycleRecord("tool.complete", params) });
	assert.equal(state.transcript.length, 1);
	assert.equal(projectRuntimeState(state).bash[0]?.status, "running");
	assert.equal(projectRuntimeState(state).bash[0]?.outputPreview, "ready\n");
	assert.equal(state.transcript[0]?.tool_record?.duration_ms, 12);
	state = reduceRuntimeEvent(state, "shell.completed", { shell_id: "sh", sequence: 2, terminal_state: "completed", exit_code: 0 });
	assert.equal(projectRuntimeState(state).bash[0]?.status, "success");
	state = reduceRuntimeEvent(state, "shell.output", { shell_id: "sh", sequence: 3, output_delta: "late output" });
	assert.equal(projectRuntimeState(state).bash[0]?.outputPreview, "ready\n");
});

test("sparse typed completions keep canonical target and identity without restoring conflicting legacy fields", () => {
	const initial = runtimeStateFromTranscript(initialRuntimeState(), { items: [{
		id: "tool", type: "tool_summary", text: "Wrong", tool_record: { ...readRecord, status: "running" },
		metadata: { tool_id: "id", call_id: "wrong", path: "private-path", tool_name: "Write" },
	}] });
	for (const typed of [true, false]) {
		const params = { name: "Read", call_id: "call" };
		const updated = reduceRuntimeEvent(initial, "tool.complete", { ...params,
			...(typed ? { tool_record: gatewayToolLifecycleRecord("tool.complete", params) } : {}),
		});
		const tool = projectRuntimeState(updated).tools[0]!;
		assert.equal(updated.transcript.length, 1);
		assert.equal(tool.status, "success");
		assert.equal(tool.args, "/repo/source.ts");
		assert.equal(tool.name, "Read");
		assert.doesNotMatch(JSON.stringify(tool), /private-/);
	}
});

test("legacy polling updates a restored typed shell while preserving its process identity", () => {
	const initial = runtimeStateFromTranscript(initialRuntimeState(), { items: [{
		id: "shell", type: "tool_summary", text: "Shell", metadata: {}, tool_record: {
			version: 1, kind: "tool_execution", name: "Shell", call_id: "call", status: "running", mutating: false,
			target: "echo ready", output_preview: "ready\n", shell: { shell_id: "sh", sequence: 4, background: true },
		},
	}] });
	const updated = reduceRuntimeEvent(initial, "tool.complete", { name: "ShellOutput", call_id: "poll", raw_payload: {
		shell_id: "sh", output: "ready\ndone\n", terminal_state: "completed", exit_code: 0,
	} });
	const shell = projectRuntimeState(updated).bash[0]!;
	assert.equal(updated.transcript.length, 1);
	assert.equal(shell.callId, "call");
	assert.equal(shell.command, "echo ready");
	assert.equal(shell.sequence, 4);
	assert.equal(shell.outputPreview, "ready\ndone\n");
	assert.equal(shell.status, "success");
});

test("mixed summary and detail pairs retain the canonical record", () => {
	const state = runtimeStateFromTranscript(initialRuntimeState(), { items: [
		{ id: "summary", type: "tool_summary", text: "Read", metadata: {}, tool_record: readRecord },
		{ id: "detail", type: "tool_detail", text: "private-detail", metadata: { tool_name: "Write", call_id: "call", path: "private-path" } },
	] });
	assert.equal(state.transcript.length, 1);
	assert.equal(projectRuntimeState(state).tools[0]?.name, "Read");
	assert.doesNotMatch(JSON.stringify(projectRuntimeState(state).tools[0]), /private-/);
});

test("bounded typed shell output preserves the final line for lifecycle events and legacy polls", () => {
	for (const polling of [false, true]) {
		let state = reduceRuntimeEvent(initialRuntimeState(), "shell.started", {
			shell_id: "sh", call_id: "call", sequence: 1, command_preview: "run", background: true,
		});
		const output = `first\n${"x".repeat(20_000)}\nlast\n`;
		state = polling
			? reduceRuntimeEvent(state, "tool.complete", { name: "ShellOutput", call_id: "poll", raw_payload: { shell_id: "sh", output } })
			: reduceRuntimeEvent(state, "shell.output", { shell_id: "sh", sequence: 2, output_delta: output });
		const preview = projectRuntimeState(state).bash[0]?.outputPreview ?? "";
		assert.ok(preview.length <= 8192);
		assert.match(preview, /^first\n/);
		assert.match(preview, /chars omitted/);
		assert.match(preview, /\nlast\n$/);
	}
});

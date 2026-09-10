import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { gatewayToolLifecycleRecord } from "@mycli/contracts";
import {
	initialRuntimeState,
} from "../src/state/runtime-state-model.ts";
import {
	projectRuntimeState,
} from "../src/state/runtime-projection.ts";
import {
	reduceRuntimeEvent,
} from "../src/state/runtime-event-reducer.ts";
import { BashExecutionComponent } from "../src/components/transcript/bash-execution.ts";
import {
	CollapsedToolGroupComponent,
} from "../src/components/transcript/collapsed-tool-group.ts";
import { ToolExecutionComponent } from "../src/components/transcript/tool-execution.ts";
import { projectTranscriptBlocks } from "../src/transcript/transcript-projection.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";
import { HeadlessTerminal } from "./support/headless-terminal.ts";

test("search command cells show an exploration summary and retain the exact command when expanded", async () => {
	const command = "rg -n -g '*.ts' '\u5ba1\u6279\u7406\u7531' src";
	const cell = new BashExecutionComponent({ id: "search", command, status: "running", background: true });
	for (const width of [24, 40, 80, 120]) {
		const terminal = new HeadlessTerminal({ columns: width, rows: 16 });
		try {
			const lines = cell.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			terminal.write(lines.join("\r\n"));
			await terminal.flush();
			const output = terminal.visibleLines().join("\n");
			assert.match(output, /Exploring/u);
			assert.match(output, /\u5ba1\u6279\u7406\u7531/u);
			if (width >= 40) assert.match(output, /in src/u);
			assert.doesNotMatch(output, /--glob|\*\.ts/u);
		} finally { terminal.dispose(); }
	}
	cell.updateBash({ id: "search", command, status: "success", expanded: true, outputPreview: "src/app.ts:10: match" });
	const output = stripAnsi(cell.render(120).join("\n"));
	assert.match(output, /Ran rg/u);
	assert.ok(output.includes(command));
	assert.match(output, /src\/app\.ts:10: match/u);
	cell.updateBash({ id: "search", command: "npm test", status: "running", background: true });
	assert.match(stripAnsi(cell.render(100).join("\n")), /Running npm test/u);
});

test("search cells distinguish no matches, execution errors, interruption, and file discovery", () => {
	const render = (overrides: Partial<ConstructorParameters<typeof BashExecutionComponent>[0]>): string =>
		stripAnsi(new BashExecutionComponent({ id: "search", command: "rg needle src", status: "error", ...overrides }).render(100).join("\n"));
	const empty = render({ exitCode: 1, terminalState: "failed", outputPreview: "", outputChars: 0 });
	assert.match(empty, /Explored/u);
	assert.match(empty, /Search needle in src/u);
	assert.doesNotMatch(empty, /failed|exit 1/u);
	assert.match(render({ exitCode: 1, expanded: true }), /No results.*exit 1/u);
	assert.match(render({ exitCode: 2, outputPreview: "invalid regular expression" }), /Search needle in src \(failed\)/u);
	assert.match(render({ exitCode: 1, outputPreview: "permission denied" }), /Search needle in src \(failed\)/u);
	assert.match(render({ exitCode: 1, terminalState: "timed_out" }), /1 failed/u);
	assert.match(render({ exitCode: 1, terminalState: "failed", omittedOutputChars: 50 }), /1 failed/u);
	assert.match(render({ exitCode: 1, terminalState: "failed", outputChars: 50 }), /1 failed/u);
	assert.match(render({ command: "rg --files src", exitCode: 1, terminalState: "failed", expanded: true }), /No files found/u);
	assert.match(render({ status: "cancelled", terminalState: "interrupted" }), /Search needle in src \(cancelled\)/u);
	const listing = render({ command: "rg --files -g '*.ts' src", status: "success" });
	assert.match(listing, /List src/u);
	assert.doesNotMatch(listing, /--glob|\*\.ts/u);
	assert.match(render({ command: "rg needle src | head -20", status: "success" }), /Ran rg needle src \| head -20/u);
});

test("Read ranges and file contents remain in details while exploration shows the filename", () => {
	const params = {
		name: "Read", call_id: "read", tool_id: "read", client_turn_id: "turn", path: "src/app.ts", success: true,
		summary: "Read src/app.ts", actualStartLine: 10, actualEndLine: 29, shownLines: 20, totalLines: 120,
	};
	const tool_record = gatewayToolLifecycleRecord("tool.complete", params);
	const state = reduceRuntimeEvent(initialRuntimeState(), "tool.complete", { ...params, tool_record });
	const tool = projectRuntimeState(state).tools[0]!;
	const output = stripAnsi(new ToolExecutionComponent({ ...tool, expanded: false, outputPreview: "source body\nsecond line" }).render(100).join("\n"));
	assert.match(output, /Explored/u);
	assert.match(output, /Read app\.ts/u);
	assert.doesNotMatch(output, /source body|Lines 10-29/u);
	const expanded = stripAnsi(new ToolExecutionComponent({ ...tool, expanded: true, outputPreview: "source body\nsecond line" }).render(100).join("\n"));
	assert.match(expanded, /source body/u);
	assert.match(expanded, /Read src\/app\.ts/u);
	assert.match(expanded, /Lines 10-29 of 120/u);
});

test("context groups identify each target and normalize read aliases", () => {
	const blocks = projectTranscriptBlocks([
		{ id: "a", kind: "tool", tool: { id: "a", name: "Read", args: "src/first.ts", status: "success" } },
		{ id: "b", kind: "tool", tool: { id: "b", name: "read_file", args: "src/second.ts", status: "running" } },
		{ id: "c", kind: "tool", tool: { id: "c", name: "Grep", args: "needle", status: "error" } },
	]);
	assert.equal(blocks[0]?.kind, "tool_group");
	if (blocks[0]?.kind !== "tool_group") return;
	for (const width of [28, 40, 100]) {
		const lines = new CollapsedToolGroupComponent(blocks[0].group).render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		const output = stripAnsi(lines.join("\n"));
		assert.match(output, /Read first\.ts,/u);
		assert.match(output, /Search needle \(failed\)/u);
		assert.match(output, /second\.ts/u);
	}
});

test("expanded Read details retain complete POSIX and Windows targets on narrow terminals", () => {
	for (const path of [
		"/workspace/packages/authentication/session-management/session-controller.ts",
		"C:\\workspace\\packages\\authentication\\session-management\\session-controller.ts",
	]) {
		const tool = { id: "read", name: "Read", args: path, status: "success" as const };
		for (const width of [24, 40, 80]) {
			const collapsed = new ToolExecutionComponent(tool).render(width).map(stripAnsi);
			assert.match(collapsed.map((line) => line.trim()).join(""), /Read session-controller\.ts/u);
			const expanded = new ToolExecutionComponent({ ...tool, expanded: true }).render(width).map(stripAnsi);
			assert.ok(expanded.map((line) => line.trim()).join("").includes(path));
			assert.ok([...collapsed, ...expanded].every((line) => visibleWidth(line) <= width));
		}
	}
});

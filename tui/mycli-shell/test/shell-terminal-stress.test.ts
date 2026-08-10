import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
	MycliShellRuntime,
	type MycliShellState,
} from "../src/index.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";
import { HeadlessTerminal } from "./support/headless-terminal.ts";

const RESIZE_SETTLE_MS = 110;

function stressState(): MycliShellState {
	const user = {
		id: "stress-user",
		role: "user" as const,
		text: "Stress resize and streaming output.",
	};
	const assistant = {
		id: "stress-assistant",
		role: "assistant" as const,
		text: "initial response",
	};
	return {
		messages: [user, assistant],
		tools: [],
		bash: [],
		transcript: [
			{ id: user.id, kind: "message", message: user },
			{
				id: "stress-subagent",
				kind: "subagent",
				subagent: {
					id: "stress-subagent",
					role: "explore",
					description: "Inspect terminal rendering",
					status: "running",
					mode: "sync",
					childSessionId: "stress-child",
					toolCalls: 0,
				},
			},
			{ id: assistant.id, kind: "message", message: assistant },
		],
		footer: {
			cwd: "~/Desktop/mycli",
			provider: "openai",
			model: "gpt-5.5",
			liveState: "Running",
			liveStateKind: "running",
			turnRunning: true,
		},
		pendingNotice: undefined,
	};
}

test("native xterm converges after resize streaming cursor and backpressure races", async (t) => {
	const terminal = new HeadlessTerminal({
		columns: 72,
		rows: 16,
		scrollback: 500,
		nativeScrollback: true,
	});
	let state = stressState();
	const runtime = new MycliShellRuntime({ initialState: state, terminal });
	t.after(async () => {
		await runtime.shutdown();
		await terminal.flush();
		terminal.dispose();
	});

	runtime.start();
	await delay(30);
	await terminal.flush();
	terminal.writes.length = 0;

	const sizes = [
		{ columns: 43, rows: 13 },
		{ columns: 91, rows: 19 },
		{ columns: 37, rows: 12 },
		{ columns: 78, rows: 17 },
	];
	for (const [round, size] of sizes.entries()) {
		terminal.setOutputBackpressured(true);
		terminal.resize(size.columns, size.rows);

		for (let step = 0; step < 6; step += 1) {
			const text = `round-${round}-partial-${step} ${"北京🚄".repeat(14 - step)} trailing-cells`;
			const assistant = {
				id: "stress-assistant",
				role: "assistant" as const,
				text,
			};
			const transcript = (state.transcript ?? []).map((block) => {
				if (block.kind === "message" && block.message.id === assistant.id) {
					return { ...block, message: assistant };
				}
				if (block.kind === "subagent") {
					return {
						...block,
						subagent: { ...block.subagent, toolCalls: round * 10 + step },
					};
				}
				return block;
			});
			state = {
				...state,
				messages: [state.messages[0]!, assistant],
				transcript,
			};
			runtime.setState(state, { transcriptUpdate: "tail" });
			runtime.editor.setText(`draft-${round}-${step} ${"输入🧪".repeat(10 - step)}`);
			runtime.ui.requestRender();
		}

		const finalText = `final-${round} 完成✅`;
		const finalAssistant = {
			id: "stress-assistant",
			role: "assistant" as const,
			text: finalText,
		};
		state = {
			...state,
			messages: [state.messages[0]!, finalAssistant],
			transcript: (state.transcript ?? []).map((block) =>
				block.kind === "message" && block.message.id === finalAssistant.id
					? { ...block, message: finalAssistant }
					: block,
			),
		};
		runtime.setState(state, { transcriptUpdate: "tail" });
		runtime.editor.setText(`ready-${round} 北京🚄`);
		runtime.ui.requestRender();

		await delay(20);
		assert.equal(terminal.writes.length, 0);
		if (round % 2 === 0) {
			await delay(RESIZE_SETTLE_MS);
			assert.equal(terminal.writes.length, 0);
			terminal.setOutputBackpressured(false);
			await delay(30);
		} else {
			terminal.setOutputBackpressured(false);
			await delay(RESIZE_SETTLE_MS);
		}
		await terminal.flush();

		const visible = terminal.visibleLines();
		const screen = visible.join("\n");
		const writes = terminal.writes.join("");
		assert.match(screen, new RegExp(`final-${round}`, "u"));
		assert.match(screen, new RegExp(`ready-${round}`, "u"));
		assert.match(screen, /1 local agent · \/tasks view/u);
		assert.doesNotMatch(screen, new RegExp(`round-${round}-partial`, "u"));
		assert.doesNotMatch(writes, new RegExp(`round-${round}-partial`, "u"));
		assert.equal(writes.match(/\x1b\[3J/gu)?.length ?? 0, 1);
		for (const write of terminal.writes) {
			assert.match(write, /^\x1b\[\?2026h/u);
			assert.match(write, /\x1b\[\?2026l$/u);
		}
		for (const line of visible) {
			assert.ok(
				visibleWidth(line) <= size.columns,
				`line exceeded ${size.columns} cells: ${line}`,
			);
		}
		const cursor = terminal.cursorPosition();
		assert.ok(cursor.row >= 0 && cursor.row < size.rows);
		assert.ok(cursor.column >= 0 && cursor.column < size.columns);
		assert.equal(
			terminal.historyLines().some((line) => line.includes(`round-${round}-partial`)),
			false,
		);

		terminal.writes.length = 0;
	}
});

test("alternate-screen xterm converges to the latest frame after blocked resize bursts", async (t) => {
	const terminal = new HeadlessTerminal({
		columns: 72,
		rows: 16,
		scrollback: 100,
		alternateScreen: true,
	});
	let state = stressState();
	const runtime = new MycliShellRuntime({ initialState: state, terminal });
	t.after(async () => {
		await runtime.shutdown();
		await terminal.flush();
		terminal.dispose();
	});

	runtime.start();
	await delay(30);
	await terminal.flush();
	terminal.writes.length = 0;
	terminal.setOutputBackpressured(true);

	const sizes = [
		{ columns: 48, rows: 13 },
		{ columns: 96, rows: 20 },
		{ columns: 35, rows: 11 },
		{ columns: 74, rows: 16 },
	];
	for (const [step, size] of sizes.entries()) {
		terminal.resize(size.columns, size.rows);
		const assistant = {
			id: "stress-assistant",
			role: "assistant" as const,
			text: `alternate-partial-${step} ${"宽字符🚄".repeat(12 - step)}`,
		};
		state = {
			...state,
			messages: [state.messages[0]!, assistant],
			transcript: (state.transcript ?? []).map((block) =>
				block.kind === "message" && block.message.id === assistant.id
					? { ...block, message: assistant }
					: block,
			),
		};
		runtime.setState(state, { transcriptUpdate: "tail" });
		runtime.editor.setText(`alternate-draft-${step} ${"输入".repeat(10 - step)}`);
		runtime.ui.requestRender();
	}

	const finalAssistant = {
		id: "stress-assistant",
		role: "assistant" as const,
		text: "alternate-final 完成✅",
	};
	state = {
		...state,
		messages: [state.messages[0]!, finalAssistant],
		transcript: (state.transcript ?? []).map((block) =>
			block.kind === "message" && block.message.id === finalAssistant.id
				? { ...block, message: finalAssistant }
				: block,
		),
	};
	runtime.setState(state, { transcriptUpdate: "tail" });
	runtime.editor.setText("alternate-ready 北京🚄");
	runtime.ui.requestRender();

	await delay(30);
	assert.equal(terminal.writes.length, 0);
	terminal.setOutputBackpressured(false);
	await delay(30);
	await terminal.flush();

	const visible = terminal.visibleLines();
	const screen = visible.join("\n");
	const writes = terminal.writes.join("");
	assert.match(screen, /alternate-final/u);
	assert.match(screen, /alternate-ready/u);
	assert.doesNotMatch(screen, /alternate-partial/u);
	assert.doesNotMatch(writes, /alternate-partial/u);
	assert.equal(writes.match(/\x1b\[2J/gu)?.length ?? 0, 1);
	assert.equal(writes.match(/\x1b\[3J/gu)?.length ?? 0, 0);
	for (const line of visible) {
		assert.ok(visibleWidth(line) <= terminal.columns);
	}
	for (const write of terminal.writes) {
		assert.match(write, /^\x1b\[\?2026h/u);
		assert.match(write, /\x1b\[\?2026l$/u);
	}
	const cursor = terminal.cursorPosition();
	assert.ok(cursor.row >= 0 && cursor.row < terminal.rows);
	assert.ok(cursor.column >= 0 && cursor.column < terminal.columns);
});

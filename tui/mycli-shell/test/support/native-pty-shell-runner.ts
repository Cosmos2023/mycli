import { setTimeout as delay } from "node:timers/promises";
import { MycliShellRuntime, type MycliShellState } from "../../src/index.ts";

function initialState(): MycliShellState {
	const assistant = {
		id: "pty-assistant",
		role: "assistant" as const,
		text: "pty initial",
	};
	return {
		messages: [assistant],
		tools: [],
		bash: [],
		transcript: [
			{
				id: "pty-subagent",
				kind: "subagent",
				subagent: {
					id: "pty-subagent",
					role: "explore",
					description: "Exercise native PTY rendering",
					status: "running",
					mode: "sync",
					childSessionId: "pty-child",
				},
			},
			{ id: assistant.id, kind: "message", message: assistant },
		],
		footer: {
			cwd: process.cwd(),
			provider: "openai",
			model: "gpt-5.5",
			liveState: "Running",
			liveStateKind: "running",
			turnRunning: true,
		},
		pendingNotice: undefined,
	};
}

let state = initialState();
const runtime = new MycliShellRuntime({
	initialState: state,
	transcriptReplayMaxRows: 32,
});

try {
	process.stdout.write("\x1b]0;MYCLI_TUI_PTY_READY\x07");
	runtime.start();
	await delay(30);
	for (let step = 0; step < 16; step += 1) {
		const assistant = {
			id: "pty-assistant",
			role: "assistant" as const,
			text: `pty-partial-${step} ${"北京🚄".repeat(18 - step)}`,
		};
		state = {
			...state,
			messages: [assistant],
			transcript: (state.transcript ?? []).map((block) =>
				block.kind === "message" && block.message.id === assistant.id
					? { ...block, message: assistant }
					: block.kind === "subagent"
						? { ...block, subagent: { ...block.subagent, toolCalls: step } }
						: block,
			),
		};
		runtime.setState(state, { transcriptUpdate: "tail" });
		runtime.editor.setText(`pty-draft-${step} ${"输入🧪".repeat(12 - Math.floor(step / 2))}`);
		runtime.ui.requestRender();
		await delay(20);
	}

	let completedAssistant = {
		id: "pty-assistant",
		role: "assistant" as const,
		text: "",
	};
	for (let lineCount = 40; lineCount <= 52; lineCount += 1) {
		completedAssistant = {
			id: "pty-assistant",
			role: "assistant" as const,
			text: Array.from({ length: lineCount }, (_, index) => `pty-history-${index}`).join("\n"),
		};
		state = {
			...state,
			messages: [completedAssistant],
			transcript: (state.transcript ?? []).map((block) =>
				block.kind === "message" && block.message.id === completedAssistant.id
					? { ...block, message: completedAssistant }
					: block,
			),
		};
		runtime.setState(state, { transcriptUpdate: "tail" });
		runtime.editor.setText(`pty-long-${lineCount} 输入🧪`);
		runtime.ui.requestRender();
		await delay(16);
	}

	const assistant = {
		id: "pty-final-assistant",
		role: "assistant" as const,
		text: "pty-final 完成✅",
	};
	state = {
		...state,
		messages: [completedAssistant, assistant],
		transcript: [
			...(state.transcript ?? []),
			{ id: assistant.id, kind: "message", message: assistant },
		],
	};
	runtime.setState(state, { transcriptUpdate: "tail" });
	runtime.editor.setText("pty-ready 北京🚄");
	runtime.ui.requestRender();
	await delay(140);
} finally {
	await runtime.shutdown();
}

process.stdout.write("\nMYCLI_TUI_PTY_OK\n");

import process from "node:process";
import { MycliShellRuntime } from "./shell-runtime.ts";
import type { MycliShellState } from "./model.ts";

function initialState(): MycliShellState {
	return {
		title: "mycli mycli shell demo",
		messages: [
			{
				id: "welcome",
				role: "system",
				text: "Local TUI stability demo. No model request will be sent.",
			},
			{
				id: "assistant-0",
				role: "assistant",
				thinking: "This opaque reasoning block is intentionally hidden in the transcript.",
				thinkingHidden: true,
				text: "Type a message and press Enter. Use `/` or `?` for commands, `/clear` to reset, `/quit` to exit.",
			},
		],
		tools: [
			{
				id: "tool-demo",
				name: "Read",
				args: "word.txt",
				status: "success",
				outputPreview: "collapsed preview",
			},
		],
		bash: [
			{
				id: "bash-demo",
				command: "pytest -q",
				status: "success",
				outputPreview: "6 passed",
				hiddenLineCount: 18,
			},
		],
		footer: {
			cwd: process.cwd(),
			gitBranch: process.env.MYCLI_DEMO_BRANCH ?? "termcn-tui-polish",
			sessionName: "local-demo",
			provider: "demo",
			model: "no-model",
			contextPercent: 12.5,
			contextWindow: 128000,
			queueCount: 0,
			trust: "pending",
			liveState: "Idle",
		},
	};
}

const runtime = new MycliShellRuntime({
	initialState: initialState(),
	requireTrust: true,
	onSubmit: async (text) => {
		const current = runtime.getState();
		const id = String(Date.now());
		runtime.setState({
			...current,
			messages: [
				...current.messages,
				{ id: `user-${id}`, role: "user", text },
				{
					id: `assistant-${id}`,
					role: "assistant",
					thinking: "Demo reasoning is hidden by default.",
					thinkingHidden: true,
					text: `Echo from the local mycli shell demo:\n\n> ${text}`,
				},
			],
			tools: [
				...current.tools,
				{
					id: `tool-${id}`,
					name: "DemoTool",
					args: text.length > 30 ? `${text.slice(0, 30)}...` : text,
					status: "success",
					outputPreview: "state update rendered without raw log spam",
				},
			],
			footer: {
				...current.footer,
				liveState: "Idle",
			},
		});
	},
	onExit: () => {
		process.exitCode = 0;
	},
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void runtime.shutdown().finally(() => {
			process.exit(0);
		});
	});
}

runtime.start();

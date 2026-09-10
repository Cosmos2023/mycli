import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundSubagentDialogComponent } from "../../../src/components/transcript/subagent-task-panel.ts";
import type { MycliShellSubagent } from "../../../src/model.ts";
import type { TUI } from "../../../src/tui-core/index.ts";

const tui = { requestRender() {} } as unknown as TUI;

test("existing background task dialog updates one row and routes actions by child session", () => {
	const stopped: string[] = [];
	const foregrounded: string[] = [];
	const running = subagent({ summary: "Exploring", status: "running" });
	const dialog = new BackgroundSubagentDialogComponent({
		tui,
		agents: [running],
		onBack() {},
		onClear() {},
		onStop: (agent) => { stopped.push(agent.childSessionId); },
		onForeground: (agent) => { foregrounded.push(agent.childSessionId); },
	});

	dialog.handleInput("x");
	dialog.handleInput("f");
	dialog.updateAgents([subagent({ summary: "Done", status: "completed" })]);
	const rendered = stripAnsi(dialog.render(100).join("\n"));

	assert.deepEqual(stopped, ["child-session-1"]);
	assert.deepEqual(foregrounded, ["child-session-1"]);
	assert.equal(rendered.match(/explore/gu)?.length, 1);
	assert.match(rendered, /Done/u);
});

test("agent dialog renders canonical paths as a stable tree when nicknames collide", () => {
	const dialog = new BackgroundSubagentDialogComponent({
		tui,
		agents: [
			subagent({
				id: "thread-beta",
				threadId: "thread-beta",
				parentThreadId: "root-thread",
				agentPath: "/root/beta",
				nickname: "review",
			}),
			subagent({
				id: "thread-alpha-child",
				threadId: "thread-alpha-child",
				parentThreadId: "thread-alpha",
				agentPath: "/root/alpha/review",
				nickname: "review",
			}),
			subagent({
				id: "thread-alpha",
				threadId: "thread-alpha",
				parentThreadId: "root-thread",
				agentPath: "/root/alpha",
				nickname: "review",
			}),
		],
		onBack() {},
		onClear() {},
		onStop() {},
	});

	const rendered = stripAnsi(dialog.render(120).join("\n"));
	assert.match(rendered, /Agent tree/u);
	assert.ok(rendered.indexOf("/root/alpha") < rendered.indexOf("/root/alpha/review"));
	assert.ok(rendered.indexOf("/root/alpha/review") < rendered.indexOf("/root/beta"));
	assert.match(rendered, /├─ \/root\/alpha/u);
	assert.match(rendered, /  └─ \/root\/alpha\/review/u);
});

function subagent(overrides: Partial<MycliShellSubagent>): MycliShellSubagent {
	return {
		id: "task-1",
		childSessionId: "child-session-1",
		role: "explore",
		description: "Inspect the repository",
		status: "running",
		mode: "background",
		...overrides,
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu, "");
}

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MycliShellRuntime } from "../../src/application/shell-runtime.ts";
import { commandResultFromGateway } from "../../src/state/command-results.ts";
import { HeadlessTerminal } from "../support/headless-terminal.ts";

test("skills and tools inspection keep navigation, details, and the draft across terminal sizes", async () => {
	for (const nativeScrollback of [false, true]) {
		const terminal = new HeadlessTerminal({ columns: 80, rows: 24, nativeScrollback });
		const runtime = new MycliShellRuntime({
			terminal,
			initialState: {
				messages: [], tools: [], bash: [], settings: { reducedMotion: true },
				footer: { cwd: "/workspace", liveState: "Idle", trust: "trusted" },
			},
			onSubmit: () => assert.fail("inspection submitted a model turn"),
		});
		try {
			runtime.start();
			runtime.editor.setText("keep this draft");
			for (const title of ["Skills", "Tools"]) {
				const result = commandResultFromGateway({
					presentation: "overlay",
					display: {
						version: 1, kind: "list", title, command: `/${title.toLowerCase()}`, severity: "info",
						rows: Array.from({ length: 30 }, (_, index) => ({
							key: `entry-${index + 1}`, label: `entry-${index + 1}`, values: ["repo"], status: "enabled",
							detail: `Complete description ${index + 1}. ${"More detail. ".repeat(60)}description-end`,
						})),
					},
				}, "inspection");
				assert.ok(result);
				runtime.showCommandResultOverlay(result);
				terminal.sendInput("\x1b[F");
				for (const [width, height] of [[40, 12], [80, 24], [120, 36]] as const) {
					terminal.resize(width, height);
					await delay(120);
					await terminal.flush();
					const output = terminal.visibleLines().join("\n");
					assert.ok(output.includes(title), output);
					assert.match(output, /entry-30/);
					assert.match(output, /esc close/);
					assert.ok(runtime.ui.render(width).length <= height, output);
				}
				terminal.sendInput("\r");
				terminal.sendInput("\x1b[F");
				await delay(35);
				await terminal.flush();
				assert.match(terminal.visibleLines().join("\n"), /description-end/);
				terminal.sendInput("\x1b");
				assert.notEqual(runtime.editorContainer.children[0], runtime.editor);
				terminal.sendInput("\x1b");
				assert.equal(runtime.editorContainer.children[0], runtime.editor);
				assert.equal(runtime.editor.getText(), "keep this draft");
			}
		} finally {
			await runtime.shutdown();
			await terminal.flush();
			terminal.dispose();
		}
	}
});

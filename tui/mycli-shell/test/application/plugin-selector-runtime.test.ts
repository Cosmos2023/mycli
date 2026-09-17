import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { PluginCatalog, PluginOperation } from "@mycli/contracts";
import { MycliShellRuntime } from "../../src/application/shell-runtime.ts";
import type { MycliShellState } from "../../src/model.ts";
import { HeadlessTerminal } from "../support/headless-terminal.ts";

function state(sessionId = "original"): MycliShellState { return { title: "mycli", sessionId, messages: [], tools: [], bash: [], footer: { cwd: "/tmp", liveState: "Idle", trust: "trusted" } }; }
const catalog: PluginCatalog = { plugins: [{ id: "review", name: "Review", description: "Review changes", source: "Local", revision: "a".repeat(64),
	installed: true, enabled: true, managed: true, status: "installed", issues: [] }], marketplaces: [], issues: [], truncated: false, repository_enabled: true };

test("the plugin selector restores drafts and session switches dispose pending work in both terminal modes", async () => {
	for (const nativeScrollback of [true, false]) {
		const terminal = new HeadlessTerminal({ columns: 60, rows: 24, nativeScrollback });
		const pending = Promise.withResolvers<PluginOperation>();
		let aborted: AbortSignal | undefined;
		const runtime = new MycliShellRuntime({ initialState: state(), terminal, pluginManager: {
			load: async () => catalog, change: async (_change, signal) => { aborted = signal; return pending.promise; },
		} });
		try {
			runtime.start(); runtime.editor.setText("中文 draft");
			await runtime.handleClientAction("open_plugins", ""); await setImmediate();
			assert.match(runtime.ui.render(60).join("\n"), /Review/);
			terminal.sendInput("\x1b"); assert.equal(runtime.editor.getText(), "中文 draft");
			runtime.showPluginSelector(); await setImmediate(); terminal.sendInput(" ");
			assert.ok(aborted);
			runtime.setState(state("target")); assert.equal(aborted.aborted, true);
			pending.resolve({ operation_id: "late", state: "completed", message: "Late result", issues: [] }); await setImmediate();
			assert.doesNotMatch(runtime.ui.render(60).join("\n"), /Late result|Updating plugin packages/);
			runtime.setState(state()); assert.equal(runtime.editor.getText(), "中文 draft");
		} finally { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); }
	}
});

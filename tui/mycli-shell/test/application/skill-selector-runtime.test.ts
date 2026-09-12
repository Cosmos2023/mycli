import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { MycliShellSkillCatalog, MycliShellState } from "../../src/model.ts";
import { MycliShellRuntime } from "../../src/application/shell-runtime.ts";
import type { MycliShellSubmitAttachments } from "../../src/application/runtime-options.ts";
import { HeadlessTerminal } from "../support/headless-terminal.ts";

const skill = { id: "a".repeat(64), revision: "b".repeat(64), name: "review", description: "Review code", path: "/skills/review.md", source: "user" as const, enabled: true };
const catalog: MycliShellSkillCatalog = { revision: "c".repeat(64), skills: [skill] };
function state(sessionId = "original"): MycliShellState { return { title: "mycli", sessionId, messages: [], tools: [], bash: [], footer: { cwd: "/tmp", liveState: "Idle", trust: "trusted" } }; }

test("selected skills stay attached to drafts across session switches and reach submission", async () => {
	const terminal = new HeadlessTerminal({ columns: 60, rows: 24 });
	const submissions: { text: string; attachments?: MycliShellSubmitAttachments }[] = [];
	const runtime = new MycliShellRuntime({ initialState: state(), terminal,
		skillManager: { load: async () => catalog, setEnabled: async () => catalog },
		onSubmit: async (text, attachments) => { submissions.push({ text, attachments }); },
	});
	try {
		runtime.start(); runtime.editor.setText("Check ");
		runtime.showSkillsSelector(); await setImmediate();
		terminal.sendInput("\r"); terminal.sendInput("\r");
		assert.match(runtime.editor.getText(), /\$review/u);
		runtime.setState(state("other")); assert.equal(runtime.editor.getText(), "");
		runtime.setState(state()); assert.match(runtime.editor.getText(), /\$review/u);
		terminal.sendInput("\r"); await setImmediate();
		assert.deepEqual(submissions[0]?.attachments?.skillReferences, [{ id: skill.id, name: skill.name, revision: skill.revision }]);
	} finally { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); }
});

test("skill picker disposal aborts pending loads and never inserts into a different session", async () => {
	const terminal = new HeadlessTerminal({ columns: 60, rows: 24 });
	const pending = Promise.withResolvers<MycliShellSkillCatalog>();
	let signal: AbortSignal | undefined;
	const runtime = new MycliShellRuntime({ initialState: state(), terminal,
		skillManager: { load: async (value) => { signal = value; return pending.promise; }, setEnabled: async () => catalog },
	});
	try {
		runtime.start(); runtime.showSkillsSelector(); runtime.setState(state("other"));
		assert.equal(signal?.aborted, true); pending.resolve(catalog); await setImmediate();
		assert.equal(runtime.editor.getText(), "");
		assert.doesNotMatch(runtime.ui.render(60).join("\n"), /List skills/);
	} finally { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); }
});

test("restored drafts keep conflicting skill identities until the user selects a source", async () => {
	const terminal = new HeadlessTerminal({ columns: 60, rows: 24 });
	const submissions: MycliShellSubmitAttachments[] = [];
	const runtime = new MycliShellRuntime({ initialState: state(), terminal,
		skillManager: { load: async () => catalog, setEnabled: async () => catalog },
		onSubmit: async (_text, attachments) => { if (attachments) submissions.push(attachments); },
	});
	try {
		runtime.start();
		for (const id of [skill.id, "d".repeat(64)]) {
			runtime.restoreQueuedText({ text: "Use $review", skillReferences: [{ id, name: skill.name, revision: skill.revision }] });
		}
		const draft = runtime.editor.getText();
		await runtime.editor.onSubmit?.(draft);
		assert.equal(submissions.length, 0);
		assert.equal(runtime.editor.getText(), draft);
		runtime.showSkillsSelector();
		await setImmediate();
		terminal.sendInput("\r"); terminal.sendInput("\r");
		await runtime.editor.onSubmit?.(runtime.editor.getText());
		assert.deepEqual(submissions[0]?.skillReferences, [{ id: skill.id, name: skill.name, revision: skill.revision }]);
	} finally { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); }
});


test("inline plan tasks carry Plan mode and image attachments in one submission", async () => {
 const terminal = new HeadlessTerminal({ columns: 60, rows: 24 });
 const submissions: { text: string; attachments?: MycliShellSubmitAttachments }[] = [];
 const runtime = new MycliShellRuntime({ initialState: state(), terminal, onSubmit: async (text, attachments) => { submissions.push({ text, attachments }); } });
 try {
  runtime.start(); runtime.editor.setText("/plan Inspect [image #1]", [{ path: "/tmp/diagram.png", placeholder: "[image #1]" }]);
  terminal.sendInput("\r"); await setImmediate();
  assert.equal(submissions[0]?.text, "Inspect [image #1]");
  assert.equal(submissions[0]?.attachments?.collaborationMode, "plan");
  assert.equal(submissions[0]?.attachments?.localImages?.[0]?.path, "/tmp/diagram.png");
 } finally { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); }
});

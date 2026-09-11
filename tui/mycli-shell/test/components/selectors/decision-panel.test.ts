import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { ApprovalSelectorComponent } from "../../../src/components/selectors/approval-selector.ts";
import { decisionNavigationHints, nextDecisionIndex } from "../../../src/components/selectors/decision-list.ts";
import { DecisionPanel, type DecisionPanelContent } from "../../../src/components/selectors/decision-panel.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from "../../../src/tui-core/index.ts";

function panelContent(selectedIndex = 0): DecisionPanelContent {
	return {
		title: "Review permissions",
		details: Array.from({ length: 30 }, (_, index) => `Read: /workspace/source-${index + 1}.txt`),
		items: [
			{ label: "Allow once", shortcut: "1" },
			{ label: "Reject", shortcut: "2" },
		],
		selectedIndex,
		hints: decisionNavigationHints("confirm", "reject"),
	};
}

test("decision panels reserve the title, selected choice and actions when details overflow", () => {
	for (const width of [32, 40, 80, 120]) {
		for (const height of [10, 12, 24]) {
			const panel = new DecisionPanel({ maxHeight: () => height });
			panel.setContent(panelContent());
			const lines = panel.render(width);
			const output = stripAnsi(lines.join("\n"));
			assert.ok(lines.length <= height, `${width}x${height}: ${output}`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(output, /Review permissions/);
			assert.match(output, /1\. Allow once/);
			assert.match(output, /enter confirm/);
			assert.match(output, /esc reject/);
			assert.match(output, /ctrl\+a view all/);
		}
	}
});

test("full-text inspection can reach every requested path and returns to the same selection", () => {
	let height = 12;
	const panel = new DecisionPanel({ maxHeight: () => height });
	panel.setContent(panelContent(1));
	panel.render(40);
	assert.equal(panel.handleInput("\x01"), true);
	const seen = new Set<string>();
	for (let step = 0; step < 80; step += 1) {
		const lines = panel.render(40);
		assert.ok(lines.length <= height);
		for (const line of lines) seen.add(stripAnsi(line).trim());
		panel.handleInput("j");
		if (step === 10) height = 16;
	}
	for (let index = 1; index <= 30; index += 1) {
		assert.ok(seen.has(`Read: /workspace/source-${index}.txt`), `path ${index} missing`);
	}
	assert.equal(panel.handleInput("1"), true);
	assert.equal(panel.handleInput("\r"), true);
	assert.equal(panel.handleInput("\x1b"), true);
	assert.match(stripAnsi(panel.render(40).join("\n")), /\u203a 2\. Reject/u);
	assert.equal(panel.handleInput("\r"), false);
});

test("wrapped option lists keep the selected row visible and navigation skips unavailable options", () => {
	const items = Array.from({ length: 12 }, (_, index) => ({
		label: `Choice ${index + 1}`,
		description: "A longer description that must wrap on a narrow terminal.",
		disabled: index === 1,
	}));
	const panel = new DecisionPanel({ maxHeight: () => 12 });
	for (const index of [0, 11, 5, 0]) {
		panel.setContent({ ...panelContent(index), items });
		const lines = panel.render(32);
		assert.ok(lines.length <= 12);
		assert.match(stripAnsi(lines.join("\n")), new RegExp(`\\u203a Choice ${index + 1}\\s`));
	}
	assert.equal(nextDecisionIndex(items, 0, 1), 2);
	assert.equal(nextDecisionIndex(items, 2, -1), 0);
	assert.equal(nextDecisionIndex(items, 0, -1), 11);
	assert.equal(nextDecisionIndex([{ label: "Blocked", disabledReason: "Managed policy" }], 0, 1), 0);
});

test("approval preserves multiline command content and does not accept hidden choices during inspection", async () => {
	const choices: string[] = [];
	const command = "node <<'SCRIPT'\n  console.log('first  second');\n  console.log('\u4e2d\u6587');\r\n\tconsole.log('tabs');\r\nSCRIPT";
	const selector = new ApprovalSelectorComponent({
		approval: {
			decisionId: "command",
			toolName: "Shell",
			preview: "Shell command requires approval",
			commandPreview: command,
			options: [{ choice: "approve_once", label: "Allow once" }, { choice: "reject", label: "Reject" }],
		},
		onSelect: (choice) => { choices.push(choice); },
		onCancel: () => assert.fail("inspection must not cancel the approval"),
	});
	const lines = selector.render(80).map((line) => stripAnsi(line).trimEnd());
	assert.ok(lines.includes("  $ node <<'SCRIPT'"));
	assert.ok(lines.includes("    console.log('first  second');"));
	assert.ok(lines.includes("    console.log('\u4e2d\u6587');"));
	assert.ok(lines.includes("     console.log('tabs');"));
	assert.ok(lines.every((line) => !line.includes("\t") && !line.includes("\r")));
	selector.handleInput("\x01");
	selector.render(40);
	selector.handleInput("1");
	selector.handleInput("\r");
	await Promise.resolve();
	assert.deepEqual(choices, []);
	selector.handleInput("\x1b");
	selector.handleInput("1");
	selector.handleInput("1");
	await Promise.resolve();
	assert.deepEqual(choices, ["approve_once"]);
});

test("approval inspection marks a command truncated by the backend and supports legacy previews", () => {
	for (const commandPreview of [undefined, "echo retained command"]) {
		const selector = new ApprovalSelectorComponent({
			approval: {
				decisionId: "bounded-command", toolName: "exec_command", preview: "echo legacy command",
				commandPreview, commandTruncated: commandPreview !== undefined,
				options: [{ choice: "reject", label: "Reject" }],
			},
			onSelect: () => undefined, onCancel: () => undefined,
		});
		const output = stripAnsi(selector.render(80).join("\n"));
		assert.match(output, commandPreview ? /\$ echo retained command/u : /\$ echo legacy command/u);
		assert.equal(output.includes("Command preview truncated."), commandPreview !== undefined);
	}
});

test("decision actions and full-text back hints reflect remapped keys", (context) => {
	const previous = getKeybindings();
	context.after(() => setKeybindings(previous));
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.select.up": "ctrl+p",
		"tui.select.down": "ctrl+n",
		"tui.select.confirm": "ctrl+y",
		"tui.select.cancel": "ctrl+g",
	}));
	const panel = new DecisionPanel({ maxHeight: () => 12 });
	panel.setContent(panelContent());
	const output = stripAnsi(panel.render(80).join("\n"));
	assert.match(output, /ctrl\+p\/ctrl\+n select/);
	assert.match(output, /ctrl\+y confirm/);
	assert.match(output, /ctrl\+g reject/);
	panel.handleInput("\x01");
	assert.match(stripAnsi(panel.render(80).join("\n")), /ctrl\+g back/);
	panel.handleInput("\x07");
	assert.match(stripAnsi(panel.render(80).join("\n")), /ctrl\+y confirm/);
});

test("shell approvals keep the command ahead of long reasons in short panels", () => {
	for (const width of [32, 40, 80, 120]) {
		for (const height of [4, 5, 6, 8, 10, 12, 24]) {
			const selector = new ApprovalSelectorComponent({
				approval: {
					decisionId: "shell-command", toolName: "Shell",
					preview: "Shell npm requires approval",
					commandPreview: "npm run build --workspace app",
					reason: "Sandbox override requires approval. ".repeat(10),
					childSessionId: "child-session-with-a-long-identity",
					options: [
						{ choice: "approve_once", label: "Allow once" },
						{ choice: "reject", label: "Reject" },
						{ choice: "allow_session", label: "Allow for this session" },
					],
				},
				maxHeight: () => height,
				onSelect: () => undefined,
				onCancel: () => undefined,
			});
			const lines = selector.render(width);
			const output = stripAnsi(lines.join("\n"));
			assert.ok(lines.length <= height, `${width}x${height}: ${output}`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.match(output, /\$ npm run build/u, `${width}x${height}: ${output}`);
			assert.match(output, /1\. Allow once/u);
			assert.doesNotMatch(output, /\$ Shell npm requires approval/u);
		}
	}
});

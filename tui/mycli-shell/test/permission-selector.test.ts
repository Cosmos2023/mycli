import assert from "node:assert/strict";
import test from "node:test";
import { PermissionSelectorComponent } from "../src/components/permission-selector.ts";
import type { MycliShellPermissionState } from "../src/model.ts";
import { visibleWidth } from "../src/tui-core/index.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

const permissions: MycliShellPermissionState = {
	active: "workspace",
	commandAllowanceCount: 2,
	profiles: [
		{
			id: "workspace",
			label: "Ask for approval",
			description: "Read and edit this workspace; ask before network or outside access.",
			current: true,
		},
		{
			id: "full-access",
			label: "Full Access",
			description: "Access files and network without approval.",
			current: false,
		},
		{
			id: "read-only",
			label: "Read Only",
			description: "Read workspace files; ask before edits or network.",
			current: false,
		},
	],
};

test("permission selector renders Codex-style profiles and stays width safe", () => {
	const selector = new PermissionSelectorComponent({
		permissions,
		onSelect() {},
		onClearAllowances() {},
		onCancel() {},
	});

	const output = stripAnsi(selector.render(80).join("\n"));
	assert.match(output, /Update Model Permissions/);
	assert.match(output, /Ask for approval \(current\)/);
	assert.match(output, /Full Access/);
	assert.match(output, /Read Only/);
	assert.match(output, /Command allowances/);

	for (const width of [32, 48, 80]) {
		for (const line of selector.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${width}: ${stripAnsi(line)}`);
		}
	}
});

test("permission selector confirms Full Access before applying", () => {
	const selected: string[] = [];
	const selector = new PermissionSelectorComponent({
		permissions,
		onSelect(profile) {
			selected.push(profile.id);
		},
		onClearAllowances() {},
		onCancel() {},
	});

	selector.handleInput("\x1b[B");
	selector.handleInput("\r");

	assert.deepEqual(selected, []);
	assert.match(stripAnsi(selector.render(80).join("\n")), /Confirm Full Access/);

	selector.handleInput("\r");
	assert.deepEqual(selected, ["full-access"]);
});

test("permission selector opens the command allowances secondary view", () => {
	const selector = new PermissionSelectorComponent({
		permissions,
		onSelect() {},
		onClearAllowances() {},
		onCancel() {},
	});

	selector.handleInput("\x1b[B");
	selector.handleInput("\x1b[B");
	selector.handleInput("\x1b[B");
	selector.handleInput("\r");

	const output = stripAnsi(selector.render(80).join("\n"));
	assert.match(output, /Session command allowances/);
	assert.match(output, /2 active/);
	assert.match(output, /Clear session allowances/);
});

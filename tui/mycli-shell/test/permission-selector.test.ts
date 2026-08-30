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
	effective: {
		trusted: true,
		valid: true,
		sandboxMode: "workspace-write",
		filesystem: "workspace_write",
		network: "disabled",
		approvalBehavior: "on-request",
		source: "session",
		constrained: true,
		constraintsSource: "managed",
		readableRoots: 1,
		writableRoots: 1,
		networkDomains: 0,
		sessionGrant: false,
		turnGrant: false,
	},
	sandboxReadiness: {
		state: "setup_required",
		code: "setup_incomplete",
		platform: "win32",
		isolation: "windows_restricted_token",
	},
	profiles: [
		{
			id: "workspace",
			label: "Ask for approval",
			description: "Read and edit this workspace; ask before network or outside access.",
			current: true,
			filesystem: "workspace_write",
			network: "disabled",
			approvalBehavior: "on-request",
		},
		{
			id: "full-access",
			label: "Full Access",
			description: "Access files and network without approval.",
			current: false,
			filesystem: "unrestricted",
			network: "enabled",
			approvalBehavior: "never",
		},
		{
			id: "read-only",
			label: "Read Only",
			description: "Read workspace files; ask before edits or network.",
			current: false,
			filesystem: "read_only",
			network: "disabled",
			approvalBehavior: "on-request",
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
	assert.match(output, /Effective: workspace write · network disabled · asks when needed/);
	assert.match(output, /Policy: session · constrained by managed/);
	assert.match(output, /Sandbox: setup required · Windows restricted token/);
	assert.match(output, /unrestricted files · network enabled · no routine prompts/);

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

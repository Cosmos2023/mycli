import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { PermissionSelectorComponent } from "../../../src/components/selectors/permission-selector.ts";
import type { MycliShellPermissionState } from "../../../src/model.ts";
import { visibleWidth } from "../../../src/tui-core/index.ts";

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
	assert.match(output, /Access files and network without approval/);
	assert.doesNotMatch(output, /unrestricted files · network enabled · no routine prompts/);
	selector.handleInput("j");
	assert.match(stripAnsi(selector.render(80).join("\n")), /Selected: unrestricted files · network enabled · no routine prompts/);

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

test("permission saves block repeated input and expose failures before retry", async () => {
	let rejectSave: (error: Error) => void = () => assert.fail("save has not started");
	const pending = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
	let calls = 0;
	let renders = 0;
	const selector = new PermissionSelectorComponent({
		permissions,
		onSelect() { calls += 1; return pending; },
		onClearAllowances() {},
		onCancel: () => assert.fail("saving must retain the active surface"),
		onRender: () => { renders += 1; },
	});
	selector.handleInput("\r");
	selector.handleInput("\r");
	selector.handleInput("j");
	selector.handleInput("2");
	selector.handleInput("\x1b");
	assert.equal(calls, 1);
	assert.match(stripAnsi(selector.render(80).join("\n")), /Saving permissions/);
	const beforeFailure = renders;
	rejectSave(new Error("Permission update unavailable"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.ok(renders > beforeFailure);
	const output = stripAnsi(selector.render(80).join("\n"));
	assert.match(output, /Permission update unavailable/);
	assert.doesNotMatch(output, /Saving permissions/);
	selector.handleInput("\r");
	assert.equal(calls, 2);
});

test("permission navigation skips disabled profiles and numeric keys cannot enable them", () => {
	const selected: string[] = [];
	const selector = new PermissionSelectorComponent({
		permissions: {
			...permissions,
			profiles: permissions.profiles.map((profile) => profile.id === "full-access"
				? { ...profile, disabledReason: "Restricted by managed policy" } : profile),
		},
		onSelect: (profile) => { selected.push(profile.id); },
		onClearAllowances() {},
		onCancel() {},
	});
	selector.handleInput("2");
	assert.deepEqual(selected, []);
	assert.doesNotMatch(stripAnsi(selector.render(80).join("\n")), /Confirm Full Access/);
	selector.handleInput("j");
	assert.match(stripAnsi(selector.render(80).join("\n")), /\u203a 3\. Read Only/u);
	selector.handleInput("\r");
	assert.deepEqual(selected, ["read-only"]);
});

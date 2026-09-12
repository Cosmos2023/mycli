import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionPolicyCoordinator } from "../../src/index.ts";

test("execution policy coordinator fails closed before configuration", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot: workspace });

	assert.deepEqual(coordinator.snapshot(), {
		trusted: false,
		valid: false,
		profile: {
			mode: "read-only",
			filesystem: "read_only",
			network: "disabled",
			writableRoots: [],
		},
		resolution: { configurationSource: "default" },
	});
	assert.equal(coordinator.beginTurn("turn-1").toolsEnabled, false);
	coordinator.finishTurn("turn-1");
});

test("execution policy coordinator freezes a turn and applies changes to the next turn", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const canonicalWorkspace = await realpath(workspace);
	const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot: workspace });
	coordinator.configure({ trust: "trusted", permission: "workspace" });

	const first = coordinator.beginTurn("turn-1");
	coordinator.configure({ trust: "trusted", permission: "full-access" });
	const resumed = coordinator.beginTurn("turn-1");

	assert.equal(first.toolsEnabled, true);
	assert.equal(resumed, first);
	assert.equal(resumed.profile.mode, "workspace-write");
	assert.equal(resumed.profile.network, "enabled");
	coordinator.finishTurn("turn-1");
	const next = coordinator.beginTurn("turn-2");
	assert.deepEqual(next.profile, {
		mode: "danger-full-access",
		filesystem: "unrestricted",
		network: "enabled",
		writableRoots: [canonicalWorkspace],
	});
	coordinator.finishTurn("turn-2");
});

test("execution policy coordinator keeps tools closed for non-trusted workspaces", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot: workspace });

	for (const trust of ["unknown", "untrusted"] as const) {
		coordinator.configure({ trust, permission: "workspace" });
		const turn = coordinator.beginTurn(`turn-${trust}`);
		assert.equal(turn.toolsEnabled, false);
		assert.equal(turn.profile.mode, "workspace-write");
		coordinator.finishTurn(`turn-${trust}`);
	}
});

test("execution policy coordinator applies turn grants and releases them at turn end", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const outside = await temporaryWorkspace(t);
	const canonicalWorkspace = await realpath(workspace);
	const canonicalOutside = await realpath(outside);
	const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot: workspace });
	coordinator.configure({ trust: "trusted", permission: "workspace", source: "user" });
	coordinator.beginTurn("turn-grant");

	const grant = coordinator.grant({
		turnId: "turn-grant",
		scope: "turn",
		permissions: {
			network: { enabled: true },
			fileSystem: { read: [], write: [canonicalOutside] },
		},
	});

	assert.equal(grant.constrained, false);
	assert.deepEqual(coordinator.beginTurn("turn-grant").profile, {
		mode: "workspace-write",
		filesystem: "workspace_write",
		network: "enabled",
		writableRoots: [canonicalWorkspace, canonicalOutside],
	});
	assert.equal(coordinator.snapshot().resolution?.configurationSource, "user");
	assert.deepEqual(
		coordinator.snapshot().resolution?.turnGrant?.fileSystem?.write,
		[canonicalOutside],
	);
	coordinator.finishTurn("turn-grant");
	assert.deepEqual(coordinator.beginTurn("turn-next").profile, {
		mode: "workspace-write",
		filesystem: "workspace_write",
		network: "enabled",
		writableRoots: [canonicalWorkspace],
	});
	coordinator.finishTurn("turn-next");
});

test("restored turns grant against their frozen base policy instead of current configuration", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const exportRoot = await temporaryWorkspace(t);
	const canonicalExportRoot = await realpath(exportRoot);
	const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot: workspace });
	coordinator.configure({ trust: "untrusted", permission: "read-only" });
	coordinator.restoreTurn("turn-restored", {
		toolsEnabled: true,
		profile: {
			mode: "read-only",
			filesystem: "read_only",
			network: "disabled",
			writableRoots: [],
		},
	});

	coordinator.grant({
		turnId: "turn-restored",
		scope: "turn",
		permissions: { fileSystem: { read: [], write: [canonicalExportRoot] } },
	});

	assert.deepEqual(coordinator.beginTurn("turn-restored").profile, {
		mode: "workspace-write",
		filesystem: "workspace_write",
		network: "disabled",
		writableRoots: [canonicalExportRoot],
	});
	coordinator.finishTurn("turn-restored");
	assert.equal(coordinator.beginTurn("turn-next-restored").toolsEnabled, false);
	coordinator.finishTurn("turn-next-restored");
});

test("managed constraints cap full access and permission grants", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const allowed = await temporaryWorkspace(t);
	const denied = await temporaryWorkspace(t);
	const canonicalAllowed = await realpath(allowed);
	const canonicalDenied = await realpath(denied);
	const coordinator = new ExecutionPolicyCoordinator({
		workspaceRoot: workspace,
		constraints: {
			source: "managed",
			network: "disabled",
			readableRoots: [canonicalAllowed],
			writableRoots: [canonicalAllowed],
		},
	});
	coordinator.configure({ trust: "trusted", permission: "full-access" });
	coordinator.beginTurn("turn-managed");

	const grant = coordinator.grant({
		turnId: "turn-managed",
		scope: "session",
		permissions: {
			network: { enabled: true },
			fileSystem: {
				read: [canonicalAllowed, canonicalDenied],
				write: [canonicalAllowed, canonicalDenied],
			},
		},
	});

	assert.equal(grant.constrained, true);
	assert.deepEqual(grant.permissions.fileSystem?.read, [canonicalAllowed]);
	assert.deepEqual(grant.permissions.fileSystem?.write, [canonicalAllowed]);
	assert.equal(grant.permissions.network, undefined);
	assert.deepEqual(coordinator.beginTurn("turn-managed").profile, {
		mode: "workspace-write",
		filesystem: "workspace_write",
		network: "disabled",
		readableRoots: [canonicalAllowed],
		writableRoots: [canonicalAllowed],
	});
	assert.equal(coordinator.snapshot().resolution?.constraintsSource, "managed");
	coordinator.finishTurn("turn-managed");
});

test("managed writable roots retain the narrower side of a workspace intersection", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const nested = join(workspace, "managed-writes");
	await mkdir(nested);
	const canonicalNested = await realpath(nested);
	const coordinator = new ExecutionPolicyCoordinator({
		workspaceRoot: workspace,
		constraints: {
			source: "managed",
			writableRoots: [nested],
		},
	});
	coordinator.configure({ trust: "trusted", permission: "workspace" });

	assert.deepEqual(coordinator.beginTurn("turn-nested").profile, {
		mode: "workspace-write",
		filesystem: "workspace_write",
		network: "enabled",
		writableRoots: [canonicalNested],
	});
	assert.deepEqual(coordinator.sandboxOverrideProfile(), {
		mode: "workspace-write",
		filesystem: "workspace_write",
		network: "enabled",
		writableRoots: [canonicalNested],
	});
	coordinator.finishTurn("turn-nested");
});

test("managed network domains constrain web access grants and sandbox overrides", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const coordinator = new ExecutionPolicyCoordinator({
		workspaceRoot: workspace,
		constraints: {
			source: "managed",
			network: "enabled",
			networkDomains: ["API.Example.com.", "*.assets.example.com"],
		},
	});
	coordinator.configure({ trust: "trusted", permission: "workspace" });
	const initial = coordinator.beginTurn("turn-domains");
	assert.equal(initial.profile.network, "enabled");
	assert.deepEqual(initial.profile.networkDomains, ["api.example.com", "*.assets.example.com"]);

	const grant = coordinator.grant({
		turnId: "turn-domains",
		scope: "turn",
		permissions: { network: { enabled: true } },
	});

	assert.equal(grant.constrained, true);
	assert.deepEqual(coordinator.beginTurn("turn-domains").profile.networkDomains, [
		"api.example.com",
		"*.assets.example.com",
	]);
	assert.deepEqual(coordinator.sandboxOverrideProfile().networkDomains, [
		"api.example.com",
		"*.assets.example.com",
	]);
	coordinator.finishTurn("turn-domains");
});

test("managed policy can disable networking in the default workspace profile", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const coordinator = new ExecutionPolicyCoordinator({
		workspaceRoot: workspace,
		constraints: { source: "managed", network: "disabled" },
	});
	coordinator.configure({ trust: "trusted", permission: "workspace" });
	assert.equal(coordinator.beginTurn("managed-offline").profile.network, "disabled");
	const grant = coordinator.grant({
		turnId: "managed-offline", scope: "turn", permissions: { network: { enabled: true } },
	});
	assert.equal(grant.constrained, true);
	assert.equal(grant.permissions.network, undefined);
	assert.equal(coordinator.beginTurn("managed-offline").profile.network, "disabled");
	coordinator.finishTurn("managed-offline");
});

test("managed readable roots cannot be bypassed by the full-access profile", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const readable = await temporaryWorkspace(t);
	const coordinator = new ExecutionPolicyCoordinator({
		workspaceRoot: workspace,
		constraints: {
			source: "managed",
			readableRoots: [readable],
		},
	});
	coordinator.configure({ trust: "trusted", permission: "full-access" });

	assert.deepEqual(coordinator.beginTurn("turn-readable").profile, {
		mode: "workspace-write",
		filesystem: "workspace_write",
		network: "enabled",
		readableRoots: [await realpath(readable)],
		writableRoots: [await realpath(workspace)],
	});
	coordinator.finishTurn("turn-readable");
});

async function temporaryWorkspace(t: test.TestContext): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "mycli-policy-coordinator-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => (
		rm(workspace, { recursive: true, force: true })
	)));
	return workspace;
}

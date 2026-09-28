import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionPolicyCoordinator } from "../../src/index.ts";

test("changed managed egress can narrow a restored run but cannot broaden it", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const first = { to: [{ cidr: "10.0.0.0/8" }] };
	const second = { to: [{ cidr: "192.168.0.0/16" }] };
	const narrow = { default: "deny", allow: [first] } as const;
	const broad = { default: "deny", allow: [first, second] } as const;
	const profile = { mode: "danger-full-access", filesystem: "unrestricted", network: "enabled", writableRoots: [], networkEgress: narrow } as const;
	const restore = (saved: typeof narrow | typeof broad, managed: typeof narrow | typeof broad) => {
		const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot: workspace, constraints: { source: "managed", networkEgress: managed } });
		const restored = coordinator.restoreTurn("restore", { toolsEnabled: true, profile: { ...profile, networkEgress: saved } });
		assert.deepEqual(coordinator.sandboxOverrideProfile().networkEgress, restored.profile.networkEgress,
			"approving an override must retain the frozen network ceiling");
		return restored;
	};
	assert.deepEqual(restore(narrow, broad).profile.networkEgress, narrow);
	assert.deepEqual(restore(broad, narrow).profile.networkEgress, narrow);
	assert.throws(() => restore(narrow, { default: "deny", allow: [second] }), /cannot safely narrow/);
});

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

test("managed Windows readonly and network options survive grants and turn snapshots", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const vendor = join(workspace, "vendor");
	await mkdir(vendor);
	const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot: workspace,
		constraints: { source: "managed", readOnlyRoots: [vendor], allowLocalBinding: true, writableTemp: false } });
	coordinator.configure({ trust: "trusted", permission: "workspace" });
	const current = coordinator.beginTurn("parity").profile;
	assert.deepEqual(current.readOnlyRoots, [await realpath(vendor)]);
	assert.equal(current.allowLocalBinding, true);
	assert.equal(current.writableTemp, false);
	coordinator.finishTurn("parity");
	coordinator.configure({ trust: "trusted", permission: "full-access" });
	assert.deepEqual(coordinator.snapshot().profile.readOnlyRoots, current.readOnlyRoots);
});

test("restored turns preserve structured egress without relying on current managed settings", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const networkEgress = { default: "deny", allow: [{ to: [{ cidr: "10.0.0.0/8" }], ports: [{ protocol: "tcp", port: 443 }] }] } as const;
	const parent = new ExecutionPolicyCoordinator({ workspaceRoot: workspace, constraints: { source: "managed", networkEgress } });
	parent.configure({ trust: "trusted", permission: "full-access" });
	const original = parent.beginTurn("parent");
	const child = new ExecutionPolicyCoordinator({ workspaceRoot: workspace });
	const restored = child.restoreTurn("child", structuredClone(original));
	assert.deepEqual(restored.profile.networkEgress, networkEgress);
	assert.notEqual(restored.profile.networkEgress, original.profile.networkEgress);
	assert.ok(Object.isFrozen(restored.profile.networkEgress?.allow?.[0]?.ports));
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

test("managed loopback limits initialize new turns and intersect restored turns and approvals", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const ports = [5432, 8080];
	const constraints = { source: "managed" as const, allowLocalBinding: true, networkDomains: ["example.com"], loopbackPorts: ports };
	const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot: workspace, constraints });
	coordinator.configure({ trust: "trusted", permission: "full-access" });
	ports.push(9000);
	const initial = coordinator.beginTurn("initial");
	assert.deepEqual(initial.profile.loopbackPorts, [5432, 8080]);
	coordinator.finishTurn("initial");
	const frozen = { ...initial, profile: { ...initial.profile, loopbackPorts: [5432, 6000] } };
	assert.deepEqual(coordinator.restoreTurn("restored", frozen).profile.loopbackPorts, [5432]);
	coordinator.grant({ turnId: "restored", scope: "session", permissions: { network: { enabled: true } } });
	assert.deepEqual(coordinator.snapshot().profile.loopbackPorts, [5432]);
	assert.deepEqual(coordinator.sandboxOverrideProfile().loopbackPorts, [5432]);
	assert.ok(Object.isFrozen(coordinator.snapshot().profile.loopbackPorts));
	for (const limits of [undefined, { ...constraints, loopbackPorts: undefined }, { ...constraints, loopbackPorts: [5432, 8080, 9000] }]) {
		const resumed = new ExecutionPolicyCoordinator({ workspaceRoot: workspace, constraints: limits });
		assert.deepEqual(resumed.restoreTurn("empty", { ...initial, profile: { ...initial.profile, loopbackPorts: [] } }).profile.loopbackPorts, []);
		assert.deepEqual(resumed.sandboxOverrideProfile().loopbackPorts, []);
	}
	const legacy = new ExecutionPolicyCoordinator({ workspaceRoot: workspace, constraints });
	const narrowed = legacy.restoreTurn("legacy", { ...initial, profile: { ...initial.profile, loopbackPorts: undefined, allowLocalBinding: false } });
	assert.equal(narrowed.profile.allowLocalBinding, false);
	assert.deepEqual(narrowed.profile.loopbackPorts ?? [], []);
	const egressCoordinator = new ExecutionPolicyCoordinator({ workspaceRoot: workspace,
		constraints: { source: "managed", networkEgress: { default: "deny" } } });
	assert.throws(() => egressCoordinator.restoreTurn("mixed", initial), /loopback_ports/u);
	for (const domains of [[], ["*.example.com", "other.com"]]) {
		const bounded = new ExecutionPolicyCoordinator({ workspaceRoot: workspace,
			constraints: { ...constraints, networkDomains: domains } });
		const restored = bounded.restoreTurn("domains", { ...initial, profile: { ...initial.profile, networkDomains: ["api.example.com"] } });
		assert.deepEqual(restored.profile.networkDomains, domains.length ? ["api.example.com"] : []);
		assert.deepEqual(bounded.sandboxOverrideProfile().networkDomains, restored.profile.networkDomains);
	}
});

test("limited proxy mode survives grants, approved overrides and recovery with relaxed managed settings", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const networkProxy = { mode: "limited" as const, enableSocks5: false, allowUpstreamProxy: false, approvalDomains: ["api.example.com"] };
	const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot: workspace,
		constraints: { source: "managed", networkDomains: ["api.example.com"], networkProxy } });
	coordinator.configure({ trust: "trusted", permission: "workspace" });
	const frozen = coordinator.beginTurn("limited");
	coordinator.grant({ turnId: "limited", scope: "session", permissions: { network: { enabled: true } } });
	assert.deepEqual(coordinator.snapshot().profile.networkProxy, networkProxy);
	assert.deepEqual(coordinator.sandboxOverrideProfile().networkProxy, networkProxy);
	const newOptions = new ExecutionPolicyCoordinator({ workspaceRoot: workspace, constraints: { source: "managed",
		networkDomains: ["api.example.com"], networkProxy: { mode: "full", enableSocks5: true, allowUpstreamProxy: true } } });
	assert.deepEqual(newOptions.restoreTurn("legacy", { ...frozen, profile: { ...frozen.profile, networkProxy: undefined } }).profile.networkProxy,
		{ mode: "full", enableSocks5: false, allowUpstreamProxy: false });
	for (const constraints of [undefined, { source: "managed" as const, networkDomains: ["*.example.com", "outside.test"],
		networkProxy: { mode: "full" as const, enableSocks5: true, allowUpstreamProxy: true } }]) {
		const restored = new ExecutionPolicyCoordinator({ workspaceRoot: workspace, constraints });
		const profile = restored.restoreTurn("resume", frozen).profile;
		assert.deepEqual(profile.networkProxy, networkProxy);
		assert.deepEqual(profile.networkDomains, ["api.example.com"]);
		assert.ok(Object.isFrozen(profile.networkProxy));
		assert.deepEqual(restored.sandboxOverrideProfile().networkProxy, networkProxy);
		assert.deepEqual(restored.sandboxOverrideProfile().networkDomains, ["api.example.com"]);
	}
});

test("managed denies survive Full Access, grants, and restored turns", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const denied = join(workspace, "secret");
	const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot: workspace,
		constraints: { source: "managed", deniedReadRoots: [denied], deniedReadGlobs: ["**/.env"] } });
	coordinator.configure({ trust: "trusted", permission: "full-access" });
	const turn = coordinator.beginTurn("denied");
	assert.equal(turn.profile.mode, "workspace-write");
	assert.deepEqual(turn.profile.deniedReadRoots, [denied]);
	const grant = coordinator.grant({ turnId: "denied", scope: "session", permissions: { fileSystem: { read: [denied], write: [denied] } } });
	assert.equal(grant.constrained, true);
	assert.deepEqual(grant.permissions.fileSystem, { read: [], write: [] });
	assert.deepEqual(coordinator.sandboxOverrideProfile().deniedReadGlobs, ["**/.env"]);
	coordinator.finishTurn("denied");
	const restored = coordinator.restoreTurn("restore", { toolsEnabled: true, profile: {
		mode: "danger-full-access", filesystem: "unrestricted", network: "enabled", writableRoots: [workspace],
	} });
	assert.deepEqual(restored.profile.deniedReadRoots, [denied]);
	assert.equal(restored.profile.mode, "workspace-write");
});

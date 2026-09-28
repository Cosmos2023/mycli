import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freezeNetworkEgress, narrowAgentExecutionPolicy } from "@mycli/core";
import { createRunExecutionSnapshot, ExecutionPolicyCoordinator } from "@mycli/runtime";
import { prepareSandboxedProcess } from "@mycli/tools";
import { agentExecutionPolicyForRun, inheritedAgentExecutionPolicyConstraints } from "../src/node-runtime/agent-execution-policy.ts";

test("a full-access child's frozen run retains managed egress through launch and restore", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-child-egress-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const networkEgress = freezeNetworkEgress({ default: "deny", allow: [{ to: [{ cidr: "10.0.0.0/8" }] }] });
	const parent = new ExecutionPolicyCoordinator({ workspaceRoot: root, constraints: { source: "managed", networkEgress } });
	parent.configure({ trust: "trusted", permission: "full-access" });
	const snapshot = createRunExecutionSnapshot({ turnId: "parent", collaborationMode: "default",
		policy: parent.beginTurn("parent"), toolCatalog: { catalogVersion: 1, directTools: [] } });
	const inherited = narrowAgentExecutionPolicy(agentExecutionPolicyForRun(snapshot));
	assert.deepEqual(inherited.networkEgress, networkEgress);
	assert.ok(Object.isFrozen(inherited.networkEgress?.allow?.[0]?.to));
	const child = new ExecutionPolicyCoordinator({ workspaceRoot: root, constraints: inheritedAgentExecutionPolicyConstraints(inherited) });
	child.configure({ trust: "trusted", permission: "full-access" });
	const childPolicy = child.beginTurn("child");
	const restarted = new ExecutionPolicyCoordinator({ workspaceRoot: root });
	const restored = restarted.restoreTurn("child", childPolicy);
	for (const profile of [childPolicy.profile, restored.profile, restarted.sandboxOverrideProfile()]) {
		assert.ok(Object.isFrozen(profile));
		assert.deepEqual(profile.networkEgress, networkEgress);
		const launch = prepareSandboxedProcess([process.execPath], { ...profile, workspaceRoot: root, cwd: root }, {
			platform: "win32", windowsHelperPath: join(root, "helper.exe"), isExecutable: () => true,
		});
		assert.equal(launch.isolation, "windows_native");
		assert.deepEqual(JSON.parse(launch.args[1]!).network_egress, networkEgress);
	}
});

test("parent to child to restored native request preserves a narrowed loopback ceiling", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-child-ports-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const parent = new ExecutionPolicyCoordinator({ workspaceRoot: root, constraints: {
		source: "managed", networkDomains: ["example.com"], allowLocalBinding: true, loopbackPorts: [5432, 8080],
	} });
	parent.configure({ trust: "trusted", permission: "full-access" });
	const snapshot = createRunExecutionSnapshot({ turnId: "parent", collaborationMode: "default",
		policy: parent.beginTurn("parent"), toolCatalog: { catalogVersion: 1, directTools: [] } });
	const inherited = agentExecutionPolicyForRun(snapshot);
	for (const ports of [[], [5432]]) {
		const narrowed = narrowAgentExecutionPolicy(inherited, { ...inherited, loopbackPorts: ports });
		const child = new ExecutionPolicyCoordinator({ workspaceRoot: root, constraints: inheritedAgentExecutionPolicyConstraints(narrowed) });
		child.configure({ trust: "trusted", permission: "full-access" });
		const childPolicy = child.beginTurn("child");
		const restarted = new ExecutionPolicyCoordinator({ workspaceRoot: root });
		const restored = restarted.restoreTurn("child", childPolicy);
		for (const profile of [childPolicy.profile, restored.profile, restarted.sandboxOverrideProfile()]) {
			const launch = prepareSandboxedProcess([process.execPath], { ...profile, workspaceRoot: root, cwd: root }, {
				platform: "win32", windowsHelperPath: join(root, "helper.exe"), isExecutable: () => true,
			}, { port: 40000 });
			assert.equal(launch.isolation, "windows_native");
			const request = JSON.parse(launch.args[1]!);
			assert.deepEqual(request.loopback_ports, ports);
			assert.equal(request.network_proxy_port, 40000);
			assert.ok(Object.isFrozen(profile.loopbackPorts));
		}
	}
});

test("parent to child to resumed Shell policy keeps limited networking", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-child-proxy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const networkProxy = { mode: "limited" as const, enableSocks5: true, allowUpstreamProxy: false, approvalDomains: ["example.com"] };
	const parent = new ExecutionPolicyCoordinator({ workspaceRoot: root, constraints: {
		source: "managed", networkDomains: ["example.com"], networkProxy,
	} });
	parent.configure({ trust: "trusted", permission: "full-access" });
	const snapshot = createRunExecutionSnapshot({ turnId: "parent", collaborationMode: "default",
		policy: parent.beginTurn("parent"), toolCatalog: { catalogVersion: 1, directTools: [] } });
	const inherited = narrowAgentExecutionPolicy(agentExecutionPolicyForRun(snapshot));
	const child = new ExecutionPolicyCoordinator({ workspaceRoot: root, constraints: inheritedAgentExecutionPolicyConstraints(inherited) });
	child.configure({ trust: "trusted", permission: "full-access" });
	const restarted = new ExecutionPolicyCoordinator({ workspaceRoot: root });
	const restored = restarted.restoreTurn("child", child.beginTurn("child"));
	for (const profile of [restored.profile, restarted.sandboxOverrideProfile()]) {
		assert.deepEqual(profile.networkProxy, networkProxy);
		const bounded = { ...profile, workspaceRoot: root, cwd: root };
		const probes = { platform: "win32" as const, windowsHelperPath: join(root, "helper.exe"), isExecutable: () => true };
		assert.throws(() => prepareSandboxedProcess([process.execPath], bounded, probes, { port: 40000 }), { kind: "network_proxy_unavailable" });
		const request = JSON.parse(prepareSandboxedProcess([process.execPath], bounded, probes, { port: 40000, policy: networkProxy }).args[1]!);
		assert.equal(request.network_proxy_port, 40000);
		assert.equal(request.network, "enabled");
	}
});

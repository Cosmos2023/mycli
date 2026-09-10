import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@mycli/core";
import { createRunExecutionSnapshot } from "../../src/turns/run-execution-snapshot.ts";
import { RunExecutionCoordinator } from "../../src/turns/run-execution-coordinator.ts";

test("run execution coordinator freezes mode policy and catalog once per turn", () => {
	let policyVersion = 1;
	let catalogVersion = 1;
	const finished: string[] = [];
	const coordinator = new RunExecutionCoordinator({
		executionPolicyCoordinator: {
			beginTurn: () => policy(policyVersion),
			finishTurn: (turnId) => { finished.push(turnId); },
		},
		resolveToolCatalog: ({ collaborationMode }) => ({
			catalogVersion,
			directTools: [definition(`${collaborationMode}-${catalogVersion}`)],
		}),
	});
	coordinator.configurePolicy({ trust: "trusted", permission: "workspace" });
	coordinator.configureCollaborationMode({ collaborationMode: "plan", turnId: "turn-1" });

	const first = coordinator.resolve("turn-1");
	policyVersion = 2;
	catalogVersion = 2;
	assert.equal(coordinator.resolve("turn-1"), first);
	assert.equal(first.collaborationMode, "plan");
	assert.equal(first.toolCatalog.catalogVersion, 1);
	assert.deepEqual(first.policy?.profile.writableRoots, ["/workspace-1"]);

	coordinator.configureCollaborationMode({ collaborationMode: "default" });
	const second = coordinator.resolve("turn-2");
	assert.equal(second.collaborationMode, "default");
	assert.equal(second.toolCatalog.catalogVersion, 2);
	assert.deepEqual(second.policy?.profile.writableRoots, ["/workspace-2"]);

	coordinator.finish("turn-1");
	assert.equal(coordinator.snapshot("turn-1"), undefined);
	assert.deepEqual(finished, ["turn-1"]);
});

test("run execution coordinator restores one durable snapshot and rejects active drift", () => {
	let restored = 0;
	const coordinator = new RunExecutionCoordinator({
		executionPolicyCoordinator: {
			beginTurn: () => policy(9),
			restoreTurn: (_turnId, value) => {
				restored += 1;
				return value;
			},
			finishTurn: () => undefined,
		},
	});
	const durable = createRunExecutionSnapshot({
		turnId: "turn-restored",
		collaborationMode: "plan",
		policy: policy(3),
		toolCatalog: { catalogVersion: 7, directTools: [definition("Read")] },
	});

	assert.deepEqual(coordinator.resolve("turn-restored", durable), durable);
	assert.equal(restored, 1);
	assert.deepEqual(coordinator.resolve("turn-restored", durable), durable);
	assert.equal(restored, 1);

	const drifted = createRunExecutionSnapshot({
		turnId: "turn-restored",
		collaborationMode: "default",
		policy: policy(3),
		toolCatalog: { catalogVersion: 7, directTools: [definition("Read")] },
	});
	assert.throws(
		() => coordinator.resolve("turn-restored", drifted),
		/does not match active run/u,
	);
});

test("run execution coordinator replaces only the active policy snapshot", () => {
	let version = 1;
	const coordinator = new RunExecutionCoordinator({
		executionPolicyCoordinator: {
			beginTurn: () => policy(version),
			finishTurn: () => undefined,
		},
		planTools: () => [definition("Read")],
	});
	const initial = coordinator.resolve("turn-policy");
	version = 2;
	const refreshed = coordinator.refreshPolicy("turn-policy");

	assert.equal(refreshed.toolCatalog, initial.toolCatalog);
	assert.equal(refreshed.collaborationMode, initial.collaborationMode);
	assert.deepEqual(refreshed.policy?.profile.writableRoots, ["/workspace-2"]);
	assert.throws(
		() => coordinator.refreshPolicy("missing"),
		/run_execution_snapshot_missing/u,
	);
});

function definition(name: string): ToolDefinition {
	return Object.freeze({
		id: `builtin:${name}`,
		name,
		description: name,
		inputSchema: Object.freeze({ type: "object", additionalProperties: false }),
	});
}

function policy(version: number) {
	return Object.freeze({
		toolsEnabled: true,
		profile: Object.freeze({
			mode: "workspace-write" as const,
			filesystem: "workspace_write" as const,
			network: "disabled" as const,
			writableRoots: Object.freeze([`/workspace-${version}`]),
		}),
	});
}

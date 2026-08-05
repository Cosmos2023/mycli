import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionPolicyCoordinator } from "../src/index.ts";

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

async function temporaryWorkspace(t: test.TestContext): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "mycli-policy-coordinator-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => (
		rm(workspace, { recursive: true, force: true })
	)));
	return workspace;
}

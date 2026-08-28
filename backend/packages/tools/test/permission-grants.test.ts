import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ApprovalPolicy,
	parsePermissionRequest,
	permissionRequestSatisfied,
	RequestPermissionsTool,
} from "../src/index.ts";

test("normalizes bounded permission requests from the workspace", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const outside = await temporaryWorkspace(t);
	const canonicalOutside = await realpath(outside);
	const parsed = parsePermissionRequest({
		reason: "Generate an artifact outside the workspace.",
		permissions: {
			network: { enabled: true },
			file_system: { write: [outside] },
		},
	}, workspace);

	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.deepEqual(parsed.permissions, {
		network: { enabled: true },
		fileSystem: { read: [], write: [canonicalOutside] },
	});
	assert.equal(Object.isFrozen(parsed.permissions.fileSystem?.write), true);
});

test("rejects empty unavailable and unknown permission requests", async (t) => {
	const workspace = await temporaryWorkspace(t);
	assert.equal(parsePermissionRequest({ permissions: {} }, workspace).ok, false);
	assert.equal(parsePermissionRequest({
		permissions: { file_system: { write: [join(workspace, "missing")] } },
	}, workspace).ok, false);
	assert.equal(parsePermissionRequest({
		permissions: { network: { enabled: true, host: "example.com" } },
	}, workspace).ok, false);
});

test("approval policy requests turn or session permission scope", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const outside = await temporaryWorkspace(t);
	const policy = new ApprovalPolicy({ workspaceRoot: workspace });
	const decision = policy.evaluate({
		callId: "permission-call",
		name: "request_permissions",
		argumentsJson: JSON.stringify({
			permissions: { file_system: { write: [outside] } },
		}),
	}, {
		mode: "workspace-write",
		filesystem: "workspace_write",
		network: "disabled",
		writableRoots: [await realpath(workspace)],
	});

	assert.equal(decision.kind, "request");
	if (decision.kind !== "request") return;
	assert.deepEqual(decision.options, ["approve_once", "reject", "allow_session"]);
	assert.deepEqual(decision.permissionRequest?.fileSystem?.write, [await realpath(outside)]);
});

test("request_permissions reports an approved grant and recognizes existing access", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const outside = await temporaryWorkspace(t);
	const canonicalOutside = await realpath(outside);
	const tool = new RequestPermissionsTool({ workspaceRoot: workspace });
	const argumentsValue = {
		permissions: { file_system: { write: [outside] } },
	};
	const granted = await tool.execute(argumentsValue, executionOptions({
		scope: "session",
		permissions: { fileSystem: { read: [], write: [canonicalOutside] } },
		constrained: false,
	}));
	assert.equal(granted.success, true);
	assert.match(granted.modelOutput, /"scope":"session"/u);

	assert.equal(permissionRequestSatisfied({
		fileSystem: { read: [canonicalOutside], write: [canonicalOutside] },
	}, {
		mode: "workspace-write",
		filesystem: "workspace_write",
		network: "disabled",
		readableRoots: [canonicalOutside],
		writableRoots: [canonicalOutside],
	}), true);
	assert.equal(permissionRequestSatisfied({
		fileSystem: { read: [canonicalOutside], write: [] },
	}, {
		mode: "read-only",
		filesystem: "read_only",
		network: "disabled",
		writableRoots: [],
	}), false);
});

function executionOptions(permissionGrant: Parameters<RequestPermissionsTool["execute"]>[1]["permissionGrant"]) {
	return {
		signal: new AbortController().signal,
		ownerSessionId: "session",
		ownerTurnId: "turn",
		callId: "call",
		publishLifecycle: () => undefined,
		...(permissionGrant ? { permissionGrant } : {}),
	};
}

async function temporaryWorkspace(t: test.TestContext): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "mycli-permission-grant-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => (
		rm(workspace, { recursive: true, force: true })
	)));
	return workspace;
}

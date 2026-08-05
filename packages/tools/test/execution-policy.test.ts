import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executionPolicy } from "../src/index.ts";

test("execution policy maps read-only to an immutable restricted profile", async (t) => {
	const workspace = await temporaryWorkspace(t);

	const profile = executionPolicy("read-only", workspace);

	assert.deepEqual(profile, {
		mode: "read-only",
		filesystem: "read_only",
		network: "disabled",
		writableRoots: [],
	});
	assert.equal(Object.isFrozen(profile), true);
	assert.equal(Object.isFrozen(profile.writableRoots), true);
});

test("execution policy resolves the workspace-write root", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const canonicalWorkspace = await realpath(workspace);

	const profile = executionPolicy("workspace", workspace);

	assert.deepEqual(profile, {
		mode: "workspace-write",
		filesystem: "workspace_write",
		network: "disabled",
		writableRoots: [canonicalWorkspace],
	});
});

test("execution policy maps full access to explicit host access", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const canonicalWorkspace = await realpath(workspace);

	const profile = executionPolicy("full-access", workspace);

	assert.deepEqual(profile, {
		mode: "danger-full-access",
		filesystem: "unrestricted",
		network: "enabled",
		writableRoots: [canonicalWorkspace],
	});
});

async function temporaryWorkspace(t: test.TestContext): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "mycli-execution-policy-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => (
		rm(workspace, { recursive: true, force: true })
	)));
	return workspace;
}

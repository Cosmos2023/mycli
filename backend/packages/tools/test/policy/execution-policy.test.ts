import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	executionPolicy,
	hasUnrestrictedNetwork,
	networkDomainAllowed,
	normalizeNetworkDomains,
} from "../../src/index.ts";

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

test("network domain policy normalizes exact and wildcard hosts", () => {
	const domains = normalizeNetworkDomains([
		"API.Example.com.",
		"*.services.example.com",
		"api.example.com",
	]);

	assert.deepEqual(domains, ["api.example.com", "*.services.example.com"]);
	assert.equal(networkDomainAllowed("api.example.com", domains), true);
	assert.equal(networkDomainAllowed("a.services.example.com", domains), true);
	assert.equal(networkDomainAllowed("services.example.com", domains), false);
	assert.equal(networkDomainAllowed("notexample.com", domains), false);
	assert.equal(networkDomainAllowed("anything.example", undefined), true);
	assert.equal(hasUnrestrictedNetwork({
		...executionPolicy("full-access", process.cwd()),
		networkDomains: domains,
	}), false);
	assert.throws(() => normalizeNetworkDomains(["https://example.com"]));
	assert.throws(() => normalizeNetworkDomains(["*.127.0.0.1"]));
});

async function temporaryWorkspace(t: test.TestContext): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "mycli-execution-policy-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => (
		rm(workspace, { recursive: true, force: true })
	)));
	return workspace;
}

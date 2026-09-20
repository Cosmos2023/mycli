import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SandboxProfile } from "@mycli/tools";
import { pluginWorkerSandboxProfile } from "../../src/plugins/worker-sandbox.ts";

const worker = fileURLToPath(new URL("../../src/plugins/worker-bootstrap.ts", import.meta.url));

test("plugin runtime access preserves managed read bounds and denies", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-runtime-policy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const profile: SandboxProfile = { mode: "read-only", filesystem: "read_only", network: "disabled",
		workspaceRoot: root, cwd: root, writableRoots: [], deniedReadRoots: [worker] };
	const resolved = pluginWorkerSandboxProfile(profile, worker, true, "win32");
	assert.deepEqual(resolved.deniedReadRoots, [worker]);
	assert.deepEqual(resolved.writableRoots, []);
	assert.equal(resolved.network, "disabled");
	assert.throws(() => pluginWorkerSandboxProfile({ ...profile, readableRoots: [] }, worker, true, "win32"),
		/plugin_runtime_read_denied/u);
	assert.doesNotThrow(() => pluginWorkerSandboxProfile({ ...profile, readableRoots: resolved.readableRoots },
		worker, true, "win32"));
	assert.equal(profile.readableRoots, undefined);
	assert.equal(pluginWorkerSandboxProfile(profile, worker, true, "linux"), profile);
});

test("plugin runtime dependency containers cannot overlap writable roots", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-runtime-overlap-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const profile: SandboxProfile = { mode: "workspace-write", filesystem: "workspace_write", network: "disabled",
		workspaceRoot: root, cwd: root, writableRoots: [root] };
	const resolved = pluginWorkerSandboxProfile(profile, worker, true, "win32");
	const container = resolved.readableRoots?.find((path) => path.endsWith("node_modules"));
	assert.ok(container);
	assert.throws(() => pluginWorkerSandboxProfile({ ...profile, writableRoots: [container] }, worker, true, "win32"),
		/plugin_runtime_write_overlap/u);
});

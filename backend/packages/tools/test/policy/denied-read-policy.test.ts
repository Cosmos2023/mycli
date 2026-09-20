import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deniedReadPath, executionPolicy, prepareSandboxedProcess, ReadTool, resolveDeniedReadRoots, validateDeniedReadGlobs, ViewImageTool } from "../../src/index.ts";

async function fixture(t: test.TestContext): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "mycli-denied-read-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "nested"));
	await writeFile(join(root, ".env"), "sensitive-test-value");
	await writeFile(join(root, "nested", ".env"), "nested-secret");
	await writeFile(join(root, "safe.txt"), "public");
	return root;
}

test("denied-read glob snapshots include dotfiles, directory descendants, and canonical aliases", async (t) => {
	const root = await fixture(t);
	await symlink(join(root, "nested"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
	const policy = { deniedReadRoots: [join(root, "nested")], deniedReadGlobs: ["**/.env"] };
	assert.equal(deniedReadPath(root, "alias/.env", policy), true);
	assert.equal(deniedReadPath(root, "nested/new.txt", policy), true);
	assert.equal(deniedReadPath(root, "safe.txt", policy), false);
	assert.deepEqual(new Set(resolveDeniedReadRoots(root, policy)), new Set([join(root, "nested"), join(root, ".env"), join(root, "nested", ".env")]));
	assert.deepEqual(resolveDeniedReadRoots(root, { deniedReadGlobs: ["nested"] }), [join(root, "nested")]);
});

test("invalid and escaping glob syntax is rejected before launching", () => {
	for (const pattern of ["../secret", "/secret", "**\\secret", "secret\0", ""]) {
		assert.throws(() => validateDeniedReadGlobs([pattern]), TypeError);
	}
});

test("Windows launch forwards resolved denies and preserves an absent exact root", async (t) => {
	const root = await fixture(t);
	const absent = join(root, "future-secrets");
	const profile = { ...executionPolicy("workspace", root), workspaceRoot: root, cwd: root,
		deniedReadRoots: [absent], deniedReadGlobs: ["**/.env"] };
	const launch = prepareSandboxedProcess([process.execPath, "-v"], profile,
		{ platform: "win32", windowsHelperPath: "helper.exe", isExecutable: () => true });
	const request = JSON.parse(launch.args[1]!);
	assert.equal(request.protocol_version, 2);
	assert.deepEqual(new Set(request.denied_read_roots), new Set([absent, join(root, ".env"), join(root, "nested", ".env")]));
	assert.deepEqual(request.denied_read_globs, []);
	for (const platform of ["darwin", "linux", "freebsd"] as const) {
		assert.throws(() => prepareSandboxedProcess([process.execPath], profile, { platform }), /Denied-read rules/u);
	}
	const fullAccess = prepareSandboxedProcess([process.execPath],
		{ ...profile, ...executionPolicy("full-access", root) },
		{ platform: "win32", windowsHelperPath: "helper.exe", isExecutable: () => true });
	assert.equal(fullAccess.isolation, "windows_native");
	const fullRequest = JSON.parse(fullAccess.args[1]!);
	assert.equal(fullRequest.filesystem, "unrestricted");
	assert.deepEqual(fullRequest.denied_read_roots, request.denied_read_roots);
	assert.throws(() => prepareSandboxedProcess([process.execPath],
		{ ...profile, ...executionPolicy("full-access", root) },
		{ platform: "win32", isExecutable: () => false }), { kind: "sandbox_unavailable" });
});

test("Read and view_image cannot bypass denies with Full Access or a readable grant", async (t) => {
	const root = await fixture(t);
	const policy = { ...executionPolicy("full-access", root), readableRoots: [root], deniedReadGlobs: ["**/.env"] };
	const options = { ownerSessionId: "denied-read-test", callId: "read", executionPolicy: policy, signal: new AbortController().signal, publishLifecycle: () => undefined };
	const read = new ReadTool({ workspaceRoot: root });
	const image = new ViewImageTool({ workspaceRoot: root, homeDir: root });
	const result = await read.execute({ file_path: ".env", offset: 1, limit: 10 }, options);
	assert.equal(result.success, false);
	assert.equal(result.errorKind, "permission_denied");
	assert.doesNotMatch(JSON.stringify(result), /sensitive-test-value/u);
	const pixels = await image.execute({ path: ".env" }, options);
	assert.equal(pixels.errorKind, "permission_denied");
	assert.equal(pixels.images, undefined);
	assert.equal((await read.execute({ file_path: "safe.txt", offset: 1, limit: 10 }, options)).success, true);
});

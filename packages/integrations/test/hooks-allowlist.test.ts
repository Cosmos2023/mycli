import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	HookAllowlistStore,
	hookCommandDigest,
	hookConfigPathHash,
	hookIdentity,
	type ConfiguredHookSpec,
} from "../src/index.ts";

test("approval binds scope, identity, config path, and canonical argv digest", async (t) => {
	const fixture = await allowlistFixture(t);
	const store = new HookAllowlistStore({
		homeDir: fixture.homeDir,
		now: () => new Date("2026-08-06T12:00:00.000Z"),
	});
	const spec = hookSpec(fixture, [process.execPath, "hook.mjs"]);

	assert.deepEqual(await store.statusFor(spec), {
		allowed: false,
		reason: "allowlist_missing",
		commandDigest: hookCommandDigest(spec.command),
	});
	const approved = await store.approve(spec);

	assert.deepEqual(approved, {
		schemaVersion: 1,
		identity: hookIdentity(spec),
		scope: "repo",
		configPathHash: hookConfigPathHash(spec.configPath),
		commandDigest: hookCommandDigest(spec.command),
		approvedAt: "2026-08-06T12:00:00.000Z",
	});
	assert.deepEqual(await store.statusFor(spec), {
		allowed: true,
		reason: "matched",
		commandDigest: hookCommandDigest(spec.command),
	});

	const changed = hookSpec(fixture, [process.execPath, "hook.mjs", "--strict"]);
	assert.deepEqual(await store.statusFor(changed), {
		allowed: false,
		reason: "digest_changed",
		commandDigest: hookCommandDigest(changed.command),
	});
	const moved = { ...spec, configPath: join(fixture.workspaceRoot, ".mycli", "moved.json") };
	assert.equal((await store.statusFor(moved)).reason, "config_path_changed");
});

test("writes a private atomic allowlist without command or environment values", async (t) => {
	const fixture = await allowlistFixture(t);
	const first = hookSpec(fixture, ["private-command", "api_key=private-value"]);
	const second = Object.freeze({
		...hookSpec(fixture, ["second-private-command"]),
		hookId: "second",
		name: "configured:repo:second",
	});
	const store = new HookAllowlistStore({ homeDir: fixture.homeDir });

	await Promise.all([store.approve(first), store.approve(second)]);
	const path = join(fixture.homeDir, ".mycli", "hook-allowlist.json");
	const raw = await readFile(path, "utf8");
	const directoryMode = (await stat(join(fixture.homeDir, ".mycli"))).mode & 0o777;
	const fileMode = (await stat(path)).mode & 0o777;

	assert.equal(directoryMode, 0o700);
	assert.equal(fileMode, 0o600);
	assert.equal(raw.includes("private-command"), false);
	assert.equal(raw.includes("private-value"), false);
	assert.equal(raw.includes("second-private-command"), false);
	assert.deepEqual((await store.load()).records.map((record) => record.identity).sort(), [
		hookIdentity(first),
		hookIdentity(second),
	].sort());
	assert.equal(await store.revoke(first), true);
	assert.equal(await store.revoke(first), false);
	assert.equal((await store.statusFor(first)).reason, "entry_missing");
	assert.equal((await store.statusFor(second)).allowed, true);
});

test("fails closed on malformed allowlist records", async (t) => {
	const fixture = await allowlistFixture(t);
	const store = new HookAllowlistStore({ homeDir: fixture.homeDir });
	await store.approve(hookSpec(fixture, [process.execPath, "hook.mjs"]));
	const path = join(fixture.homeDir, ".mycli", "hook-allowlist.json");
	await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "{private-token", "utf8"));

	const snapshot = await store.load();
	const status = await store.statusFor(hookSpec(fixture, [process.execPath, "hook.mjs"]));

	assert.deepEqual(snapshot.records, []);
	assert.deepEqual(snapshot.issues, ["allowlist_invalid_json"]);
	assert.equal(status.allowed, false);
	assert.equal(status.reason, "allowlist_invalid");
	assert.equal(JSON.stringify(snapshot).includes("private-token"), false);
	await assert.rejects(() => store.approve(hookSpec(fixture, ["node"])), /hook_allowlist_invalid/);
});

async function allowlistFixture(t: TestContext): Promise<{
	readonly homeDir: string;
	readonly workspaceRoot: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-hook-allowlist-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return {
		homeDir: join(root, "home"),
		workspaceRoot: join(root, "workspace"),
	};
}

function hookSpec(
	fixture: { readonly workspaceRoot: string },
	command: readonly string[],
): ConfiguredHookSpec {
	return Object.freeze({
		hookId: "check-write",
		name: "configured:repo:check-write",
		hookPoint: "pre_tool_use",
		command: Object.freeze([...command]),
		enabled: true,
		timeoutMs: 2_000,
		workingDirectory: "workspace",
		envPolicy: "minimal",
		matcher: Object.freeze({ kind: "tool_name", value: "Write" }),
		scope: "repo",
		configPath: join(fixture.workspaceRoot, ".mycli", "hooks.json"),
	});
}

import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ExecPolicyStore,
	ExecPolicyStoreError,
} from "../../src/index.ts";

test("writes a private parseable global allow rule with JSON token escaping", async (t) => {
	const fixture = await storeFixture(t);
	const store = fixture.store();

	const result = await store.allow(["tool", "quote\"value", "line\nbreak", "你好"]);
	const rules = await store.loadUserRules();

	assert.equal(result.status, "created");
	assert.match(result.patternHash, /^[a-f0-9]{16}$/u);
	assert.deepEqual(rules, [{
		source: "user",
		index: 0,
		pattern: ["tool", "quote\"value", "line\nbreak", "你好"],
		decision: "allow",
	}]);
	assert.equal(await readFile(fixture.rulesPath, "utf8"),
		`prefix_rule(pattern=["tool", "quote\\"value", "line\\nbreak", "\\u4f60\\u597d"], decision="allow")\n`);
	if (process.platform !== "win32") {
		assert.equal((await stat(fixture.rulesDir)).mode & 0o777, 0o700);
		assert.equal((await stat(fixture.rulesPath)).mode & 0o777, 0o600);
	}
});

test("preserves comments, repairs the final newline, and deduplicates identical allows", async (t) => {
	const fixture = await storeFixture(t);
	await mkdir(fixture.rulesDir, { recursive: true });
	await writeFile(fixture.rulesPath,
		'# managed by user\nprefix_rule(pattern=["uv"], decision="ask")', "utf8");

	const created = await fixture.store().allow(["cargo", "test"]);
	const existing = await fixture.store().allow(["cargo", "test"]);

	assert.equal(created.status, "created");
	assert.equal(existing.status, "existing");
	assert.equal(await readFile(fixture.rulesPath, "utf8"), [
		"# managed by user",
		'prefix_rule(pattern=["uv"], decision="ask")',
		'prefix_rule(pattern=["cargo", "test"], decision="allow")',
		"",
	].join("\n"));
});

test("loads user and project rules in precedence order", async (t) => {
	const fixture = await storeFixture(t);
	const projectRulesDir = join(fixture.workspace, ".mycli", "rules");
	await mkdir(fixture.rulesDir, { recursive: true });
	await mkdir(projectRulesDir, { recursive: true });
	await writeFile(fixture.rulesPath,
		'prefix_rule(pattern=["uv","run","pytest"], decision="allow")\n', "utf8");
	await writeFile(join(projectRulesDir, "default.rules"),
		'prefix_rule(pattern=["uv","run","pytest"], decision="deny")\n', "utf8");

	assert.deepEqual(await fixture.store().load(), [
		{ source: "user", index: 0, pattern: ["uv", "run", "pytest"], decision: "allow" },
		{ source: "project", index: 0, pattern: ["uv", "run", "pytest"], decision: "deny" },
	]);
});

test("serializes concurrent writers without losing rules", async (t) => {
	const fixture = await storeFixture(t);
	const patterns = Array.from({ length: 12 }, (_, index) => ["tool", `task-${index}`]);

	const writes = await Promise.allSettled(patterns.map((pattern) => fixture.store({
		lockTimeoutMs: 2_000,
		lockRetryDelayMs: 1,
	}).allow(pattern)));
	for (const result of writes) {
		if (result.status === "rejected") throw result.reason;
	}

	const rules = await fixture.store().loadUserRules();
	assert.equal(rules.length, patterns.length);
	assert.deepEqual(new Set(rules.map((rule) => rule.pattern.join("\0"))),
		new Set(patterns.map((pattern) => pattern.join("\0"))));
	assert.equal((await readdir(fixture.rulesDir)).includes("default.rules.lock"), false);
});

test("retries Windows delete-pending lock errors before writing", async (t) => {
	const fixture = await storeFixture(t);
	let attempts = 0;
	const store = fixture.store({
		lockRetryDelayMs: 1,
		failpoint: (name) => {
			if (name === "exec_policy_before_lock_open" && ++attempts === 1) {
				throw Object.assign(new Error("delete pending"), { code: "EPERM" });
			}
		},
	});
	if (process.platform === "win32") {
		assert.equal((await store.allow(["tool", "retry"])).status, "created");
		assert.equal(attempts, 2);
		assert.equal((await store.loadUserRules()).length, 1);
	} else {
		await assert.rejects(store.allow(["tool", "retry"]), {
			kind: "exec_policy_write_failed",
		});
		assert.equal(attempts, 1);
	}
});

test("persistent lock permission errors remain bounded and never write rules", async (t) => {
	const fixture = await storeFixture(t);
	const store = fixture.store({
		lockTimeoutMs: 20,
		lockRetryDelayMs: 1,
		failpoint: (name) => {
			if (name === "exec_policy_before_lock_open") {
				throw Object.assign(new Error("permission denied"), { code: "EPERM" });
			}
		},
	});
	await assert.rejects(store.allow(["tool", "blocked"]), { kind: "exec_policy_write_failed" });
	assert.deepEqual(await readdir(fixture.rulesDir), []);
});

test("does not recover an old lock whose owner is still alive", async (t) => {
	const fixture = await storeFixture(t);
	await mkdir(fixture.rulesDir, { recursive: true });
	const lockPath = join(fixture.rulesDir, "default.rules.lock");
	const old = Date.now() - 60_000;
	const payload = JSON.stringify({
		version: 1, owner_id: "live-owner", pid: process.pid, created_at_ms: old,
	});
	await writeFile(lockPath, payload, "utf8");
	await utimes(lockPath, new Date(old), new Date(old));
	await assert.rejects(fixture.store({
		lockTimeoutMs: 20, lockRetryDelayMs: 1, lockStaleMs: 1,
	}).allow(["tool", "blocked"]), { kind: "exec_policy_lock_timeout" });
	assert.equal(await readFile(lockPath, "utf8"), payload);
	assert.deepEqual(await fixture.store().loadUserRules(), []);
});

test("recovers a stale lock owned by a dead process", async (t) => {
	const fixture = await storeFixture(t);
	await mkdir(fixture.rulesDir, { recursive: true });
	const lockPath = join(fixture.rulesDir, "default.rules.lock");
	const old = Date.now() - 60_000;
	await writeFile(lockPath, JSON.stringify({
		version: 1,
		owner_id: "dead-owner",
		pid: 999_999,
		created_at_ms: old,
	}), "utf8");
	await chmod(lockPath, 0o600);
	await utimes(lockPath, new Date(old), new Date(old));

	const result = await fixture.store({
		lockStaleMs: 10,
		lockTimeoutMs: 200,
		lockRetryDelayMs: 1,
		processAlive: () => false,
	}).allow(["python", "-m", "pytest"]);

	assert.equal(result.status, "created");
	assert.equal((await readdir(fixture.rulesDir)).includes("default.rules.lock"), false);
});

test("cleans temporary files and preserves the old parseable file on pre-rename failure", async (t) => {
	const fixture = await storeFixture(t);
	await mkdir(fixture.rulesDir, { recursive: true });
	const original = '# keep\nprefix_rule(pattern=["uv"], decision="allow")\n';
	await writeFile(fixture.rulesPath, original, "utf8");

	await assert.rejects(
		fixture.store({
			failpoint: (name) => {
				if (name === "exec_policy_before_rename") throw new Error("injected failure");
			},
		}).allow(["cargo", "test"]),
		(error: unknown) => error instanceof ExecPolicyStoreError
			&& error.kind === "exec_policy_write_failed",
	);

	assert.equal(await readFile(fixture.rulesPath, "utf8"), original);
	assert.deepEqual(await fixture.store().loadUserRules(), [{
		source: "user",
		index: 0,
		pattern: ["uv"],
		decision: "allow",
	}]);
	assert.equal((await readdir(fixture.rulesDir)).some((name) => name.endsWith(".tmp")), false);
});

interface StoreOverrides {
	readonly lockTimeoutMs?: number;
	readonly lockStaleMs?: number;
	readonly lockRetryDelayMs?: number;
	readonly processAlive?: (pid: number) => boolean;
	readonly failpoint?: (name: string) => void;
}

async function storeFixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "mycli-exec-policy-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const rulesDir = join(home, ".mycli", "rules");
	const rulesPath = join(rulesDir, "default.rules");
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	return {
		home,
		workspace,
		rulesDir,
		rulesPath,
		store: (overrides: StoreOverrides = {}) => new ExecPolicyStore({
			homeDir: home,
			workspaceRoot: workspace,
			...overrides,
		}),
	};
}

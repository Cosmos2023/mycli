import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	HookManagementService,
	type HookManagementResponse,
} from "../src/index.ts";

test("lists and inspects configured hooks using only safe provider-free metadata", async (t) => {
	const fixture = await managementFixture(t);
	await writeHooks(fixture.workspaceRoot, [{
		id: "audit",
		hook_point: "post_tool_use",
		command: ["private-command", "--token", "sk-private-value"],
		timeout_seconds: 3,
		working_directory: "config",
		env_policy: "inherit_safe",
	}]);
	const service = new HookManagementService(fixture);

	const listed = await service.list();
	const inspected = await service.inspect("repo:audit:post_tool_use");

	assert.equal(listed.ok, true);
	assert.equal(listed.action, "list");
	assert.equal(listed.hooks[0]?.identity, "repo:audit:post_tool_use");
	assert.equal(listed.hooks[0]?.timeoutMs, 3_000);
	assert.equal(listed.hooks[0]?.workingDirectory, "config");
	assert.equal(listed.hooks[0]?.envPolicy, "inherit_safe");
	assert.equal(listed.hooks[0]?.allowlistStatus, "not_allowed");
	assert.equal(listed.hooks[0]?.allowlistReason, "allowlist_missing");
	assert.match(listed.hooks[0]?.commandDigest ?? "", /^sha256:/u);
	assert.match(listed.hooks[0]?.configPathHash ?? "", /^sha256:/u);
	assert.equal(inspected.ok, true);
	assert.equal(inspected.hook?.identity, "repo:audit:post_tool_use");
	assert.deepEqual(inspected.hooks, inspected.hook ? [inspected.hook] : []);
	const serialized = JSON.stringify({ listed, inspected });
	for (const sensitive of [
		"private-command",
		"sk-private-value",
		fixture.workspaceRoot,
		fixture.homeDir,
	]) {
		assert.equal(serialized.includes(sensitive), false);
	}
});

test("approves and revokes one exact hook identity without starting a provider", async (t) => {
	const fixture = await managementFixture(t);
	await writeHooks(fixture.workspaceRoot, [
		{ id: "audit", hook_point: "post_tool_use", command: [process.execPath, "audit.mjs"] },
		{ id: "guard", hook_point: "pre_tool_use", command: [process.execPath, "guard.mjs"] },
	]);
	const service = new HookManagementService(fixture);

	const approvedAudit = await service.approve("repo:audit:post_tool_use");
	const approvedGuard = await service.approve("repo:guard:pre_tool_use");
	const revoked = await service.revoke("repo:audit:post_tool_use");
	const listed = await service.list();

	assert.equal(approvedAudit.ok, true);
	assert.equal(approvedAudit.hook?.allowlistStatus, "allowed");
	assert.equal(approvedGuard.ok, true);
	assert.equal(revoked.ok, true);
	assert.equal(revoked.removed, true);
	assert.deepEqual(listed.hooks.map((row) => [row.hookId, row.allowlistReason]), [
		["audit", "entry_missing"],
		["guard", "matched"],
	]);
	assert.equal((await service.revoke("repo:audit:post_tool_use")).removed, false);
});

test("reports digest changes and bounded parse issues without exposing config content", async (t) => {
	const fixture = await managementFixture(t);
	await writeHooks(fixture.workspaceRoot, [
		{ id: "audit", hook_point: "post_tool_use", command: [process.execPath, "audit.mjs"] },
	]);
	const service = new HookManagementService(fixture);
	await service.approve("repo:audit:post_tool_use");
	await writeHooks(fixture.workspaceRoot, [
		{ id: "audit", hook_point: "post_tool_use", command: [process.execPath, "changed-secret.mjs"] },
	]);

	const changed = await service.list();
	assert.equal(changed.hooks[0]?.allowlistReason, "digest_changed");
	assert.equal(JSON.stringify(changed).includes("changed-secret.mjs"), false);

	await writeFile(join(fixture.workspaceRoot, ".mycli", "hooks.json"), "{token=private-value", "utf8");
	const malformed = await service.list();
	assert.equal(malformed.ok, true);
	assert.deepEqual(malformed.hooks, []);
	assert.deepEqual(malformed.issues, ["repo:hooks.json:config:invalid_json"]);
	assert.equal(JSON.stringify(malformed).includes("private-value"), false);
	assert.equal((await service.inspect("builtin:guard:pre_tool_use")).ok, false);
});

test("returns typed failure responses when a malformed allowlist blocks mutation", async (t) => {
	const fixture = await managementFixture(t);
	await writeHooks(fixture.workspaceRoot, [
		{ id: "audit", hook_point: "post_tool_use", command: [process.execPath, "audit.mjs"] },
	]);
	await mkdir(join(fixture.homeDir, ".mycli"), { recursive: true });
	await writeFile(join(fixture.homeDir, ".mycli", "hook-allowlist.json"), "{secret=private", "utf8");
	const service = new HookManagementService(fixture);

	const response: HookManagementResponse = await service.approve("repo:audit:post_tool_use");

	assert.equal(response.ok, false);
	assert.equal(response.action, "approve");
	assert.equal(response.message, "configured hook allowlist update failed");
	assert.deepEqual(response.issues, ["allowlist:allowlist_invalid_json"]);
	assert.equal(JSON.stringify(response).includes("private"), false);
});

async function managementFixture(t: TestContext): Promise<{
	readonly homeDir: string;
	readonly workspaceRoot: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-hook-management-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return {
		homeDir: join(root, "home"),
		workspaceRoot: join(root, "workspace"),
	};
}

async function writeHooks(
	workspaceRoot: string,
	hooks: readonly Readonly<Record<string, unknown>>[],
): Promise<void> {
	await mkdir(join(workspaceRoot, ".mycli"), { recursive: true });
	await writeFile(
		join(workspaceRoot, ".mycli", "hooks.json"),
		JSON.stringify({ hooks }),
		"utf8",
	);
}

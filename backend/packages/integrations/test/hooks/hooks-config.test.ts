import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	configuredHookMatches,
	discoverHookConfig,
} from "../../src/index.ts";

test("discovers flat user and repository hooks in precedence order", async (t) => {
	const fixture = await configFixture(t);
	await writeHooks(fixture.homeDir, {
		hooks: [{
			id: "session-context",
			hook_point: "session_start",
			command: [process.execPath, "user-hook.mjs"],
			enabled: false,
		}],
	});
	await writeHooks(fixture.workspaceRoot, {
		hooks: [{
			id: "check-write",
			hook_point: "pre_tool_use",
			command: [process.execPath, "hook.mjs"],
			matcher: { tool_name: "Write" },
			timeout_seconds: 3,
			working_directory: "config",
			env_policy: "inherit_safe",
		}],
	});

	const discovery = await discoverHookConfig(fixture);

	assert.deepEqual(discovery.hooks.map((hook) => hook.name), [
		"configured:user:session-context",
		"configured:repo:check-write",
	]);
	const hook = discovery.hooks[1]!;
	assert.equal(hook.hookPoint, "pre_tool_use");
	assert.deepEqual(hook.command, [process.execPath, "hook.mjs"]);
	assert.equal(hook.timeoutMs, 3_000);
	assert.equal(hook.workingDirectory, "config");
	assert.equal(hook.envPolicy, "inherit_safe");
	assert.equal(hook.shellKind, undefined);
	assert.equal(configuredHookMatches(hook, { toolName: "Write" }), true);
	assert.equal(configuredHookMatches(hook, { toolName: "Read" }), false);
	assert.deepEqual(discovery.diagnostics, []);
});

test("does not read repository hooks when project configuration is disabled", async (t) => {
	const fixture = await configFixture(t);
	await writeHooks(fixture.homeDir, {
		hooks: [{
			id: "user-hook",
			hook_point: "stop",
			command: [process.execPath, "user.mjs"],
		}],
	});
	await mkdir(join(fixture.workspaceRoot, ".mycli"), { recursive: true });
	await writeFile(
		join(fixture.workspaceRoot, ".mycli", "hooks.json"),
		"{not-json",
		"utf8",
	);

	const discovery = await discoverHookConfig({
		...fixture,
		includeRepository: false,
	});

	assert.deepEqual(discovery.hooks.map((hook) => hook.name), ["configured:user:user-hook"]);
	assert.deepEqual(discovery.diagnostics, []);
});

test("normalizes supported Codex groups and resolves string commands through the active shell", async (t) => {
	const fixture = await configFixture(t);
	await writeHooks(fixture.workspaceRoot, {
		PreToolUse: [{
			matcher: "^(Read|Write)$",
			hooks: [{ type: "command", command: "node pre.mjs", timeoutSec: 4 }],
		}],
		PostToolUse: [{ hooks: [{ type: "command", id: "after", command: "node post.mjs" }] }],
		SessionStart: [{
			matcher: "resume|startup",
			hooks: [{ type: "command", command: "node session.mjs" }],
		}],
		UserPromptSubmit: [{ hooks: [{ type: "command", command: "node prompt.mjs" }] }],
		Stop: [{ hooks: [{ type: "command", command: "node stop.mjs" }] }],
	});

	const discovery = await discoverHookConfig({
		...fixture,
		platform: "linux",
		env: { SHELL: "/custom/sh" },
	});

	assert.deepEqual(discovery.hooks.map((hook) => [hook.hookId, hook.hookPoint]), [
		["PreToolUse-0-0", "pre_tool_use"],
		["after", "post_tool_use"],
		["SessionStart-0-0", "session_start"],
		["UserPromptSubmit-0-0", "user_prompt_submit"],
		["Stop-0-0", "stop"],
	]);
	assert.deepEqual(discovery.hooks[0]?.command, ["/custom/sh", "-lc", "node pre.mjs"]);
	assert.equal(discovery.hooks[0]?.shellKind, "posix");
	assert.equal(discovery.hooks[0]?.timeoutMs, 4_000);
	assert.equal(configuredHookMatches(discovery.hooks[0]!, { toolName: "Read" }), true);
	assert.equal(configuredHookMatches(discovery.hooks[0]!, { toolName: "Bash" }), false);
	assert.equal(configuredHookMatches(discovery.hooks[2]!, { source: "resume" }), true);
	assert.equal(configuredHookMatches(discovery.hooks[2]!, { source: "compact" }), false);
	assert.equal(configuredHookMatches(discovery.hooks[3]!, { toolName: "anything" }), true);
});

test("interpolates plugin roots for every supported shell placeholder syntax", async (t) => {
	const fixture = await configFixture(t);
	const pluginRoot = String.raw`C:\Users\demo\.mycli\plugins\demo`;
	await writeHooks(fixture.workspaceRoot, {
		hooks: [
			{
				id: "posix-style",
				hook_point: "stop",
				command: `node "\${CLAUDE_PLUGIN_ROOT}/hook.mjs"`,
			},
			{
				id: "cmd-style",
				hook_point: "stop",
				command: `node "%CODEX_PLUGIN_ROOT%/hook.mjs"`,
			},
			{
				id: "argv-style",
				hook_point: "stop",
				command: [process.execPath, "$env:CODEX_PLUGIN_ROOT/hook.mjs"],
			},
		],
	});

	const discovery = await discoverHookConfig({
		...fixture,
		platform: "linux",
		env: { SHELL: "/custom/sh" },
		pluginRoot,
	});

	assert.deepEqual(discovery.hooks.map((hook) => hook.command), [
		["/custom/sh", "-lc", `node "${pluginRoot}/hook.mjs"`],
		["/custom/sh", "-lc", `node "${pluginRoot}/hook.mjs"`],
		[process.execPath, `${pluginRoot}/hook.mjs`],
	]);
	assert.deepEqual(discovery.hooks[2]?.command, [process.execPath, `${pluginRoot}/hook.mjs`]);
	assert.equal(discovery.hooks[0]?.shellKind, "posix");
	assert.deepEqual(discovery.diagnostics, []);
});

test("isolates invalid entries and emits bounded diagnostics without sensitive config values", async (t) => {
	const fixture = await configFixture(t);
	await writeHooks(fixture.workspaceRoot, {
		hooks: [
			{ id: "valid", hook_point: "stop", command: [process.execPath, "ok.mjs"] },
			{ id: "valid", hook_point: "stop", command: [process.execPath, "duplicate-secret.mjs"] },
			{ id: "bad-timeout-zero", hook_point: "stop", command: ["private-command"], timeout_seconds: 0 },
			{ id: "bad-timeout-large", hook_point: "stop", command: ["private-command"], timeout_seconds: 31 },
			{ id: "bad-regex", hook_point: "pre_tool_use", command: ["private-command"], matcher: "[" },
			{ id: "bad-env", hook_point: "stop", command: ["private-command"], env_policy: "everything" },
			{ id: "bad-cwd", hook_point: "stop", command: ["private-command"], working_directory: "/private/path" },
			{ id: "bad-command", hook_point: "stop", command: ["", "secret-token-value"] },
		],
	});

	const discovery = await discoverHookConfig(fixture);
	const serialized = JSON.stringify(discovery.diagnostics);

	assert.deepEqual(discovery.hooks.map((hook) => hook.hookId), ["valid"]);
	assert.deepEqual(discovery.diagnostics.map((issue) => issue.errorClass).sort(), [
		"duplicate_hook",
		"invalid_command",
		"invalid_env_policy",
		"invalid_matcher",
		"invalid_timeout",
		"invalid_timeout",
		"invalid_working_directory",
	].sort());
	for (const sensitive of [
		"duplicate-secret.mjs",
		"private-command",
		"secret-token-value",
		"/private/path",
		fixture.workspaceRoot,
	]) {
		assert.equal(serialized.includes(sensitive), false);
	}
	for (const issue of discovery.diagnostics) {
		assert.deepEqual(Object.keys(issue).sort(), [
			"errorClass",
			"fileLabel",
			"hookId",
			"scope",
		]);
	}
});

async function configFixture(t: TestContext): Promise<{
	readonly homeDir: string;
	readonly workspaceRoot: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-hook-config-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return {
		homeDir: join(root, "home"),
		workspaceRoot: join(root, "workspace"),
	};
}

async function writeHooks(root: string, payload: unknown): Promise<void> {
	await mkdir(join(root, ".mycli"), { recursive: true });
	await writeFile(
		join(root, ".mycli", "hooks.json"),
		JSON.stringify(payload),
		"utf8",
	);
}

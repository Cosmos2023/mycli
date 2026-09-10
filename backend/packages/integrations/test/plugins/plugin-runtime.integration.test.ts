import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
	HookManager,
	PluginProcessHost,
	PluginRuntime,
} from "../../src/index.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "plugins");

test("plugin runtime adapts one isolated plugin into tools, hooks, and commands", {
	timeout: 10_000,
}, async (t) => {
	const fixture = await runtimeFixture(t, ["good"]);
	const runtime = await PluginRuntime.load({
		workspaceRoot: fixture.workspaceRoot,
		homeDir: fixture.homeDir,
		env: {},
		sandboxProfile: (manifest) => fullAccessSandbox(manifest.pluginRoot),
	}, new AbortController().signal);
	t.after(async () => runtime.close());

	assert.deepEqual(runtime.records.map((record) => [record.pluginId, record.status]), [["good", "loaded"]]);
	assert.deepEqual(runtime.records[0]?.tools, ["echo"]);
	assert.deepEqual(runtime.records[0]?.hooks, ["audit", "guard"]);
	assert.deepEqual(runtime.tools.map((tool) => tool.id), ["plugin:good:echo"]);
	assert.deepEqual(runtime.hooks.map((hook) => hook.id), ["plugin:good:guard", "plugin:good:audit"]);
	assert.deepEqual(runtime.commands.list().map((command) => command.id), [
		"plugin:good:late",
		"plugin:good:status",
	]);

	const toolResult = await runtime.tools[0]!.adapter.execute(
		{ text: "hello" },
		toolExecutionOptions(),
	);
	const hookManager = new HookManager({ pluginHooks: runtime.hooks });
	const hookResult = await hookManager.run({
		point: "pre_tool_use",
		sessionId: "session-1",
		turnId: "turn-1",
		toolName: "Write",
		arguments: { path: "README.md" },
		metadata: {},
	}, new AbortController().signal);
	const secretHookResult = await hookManager.run({
		point: "pre_tool_use",
		sessionId: "session-1",
		turnId: "turn-2",
		metadata: { secret: true },
	}, new AbortController().signal);
	const commandResult = await runtime.commands.execute(
		"good",
		"status",
		{},
		new AbortController().signal,
	);

	assert.deepEqual(toolResult, {
		success: true,
		modelOutput: "hello",
		summary: "echoed",
		metadata: { registrationCount: 1 },
	});
	assert.deepEqual(hookResult[0]?.result, { action: "modify", arguments: { checked: true } });
	assert.deepEqual(secretHookResult[0]?.result, { action: "allow", additionalContexts: ["redacted"] });
	assert.equal(commandResult.ok, true);
	assert.equal(commandResult.summary, "ready");
	assert.deepEqual(commandResult.content, [{ type: "text", text: "ready" }]);
});

test("one crashed plugin fails its command without corrupting another plugin", {
	timeout: 10_000,
}, async (t) => {
	const fixture = await runtimeFixture(t, ["crash", "good"]);
	const runtime = await PluginRuntime.load({
		workspaceRoot: fixture.workspaceRoot,
		homeDir: fixture.homeDir,
		env: { PLUGIN_TEST_MODE: "crash", PLUGIN_TEST_VALUE: "unused" },
		sandboxProfile: (manifest) => fullAccessSandbox(manifest.pluginRoot),
	}, new AbortController().signal);
	t.after(async () => runtime.close());

	const crashed = await runtime.commands.execute(
		"crash",
		"act",
		{},
		new AbortController().signal,
	);
	const healthy = await runtime.tools.find((tool) => tool.id === "plugin:good:echo")!.adapter.execute(
		{ text: "still-ready" },
		toolExecutionOptions(),
	);

	assert.equal(crashed.ok, false);
	assert.equal(crashed.error, "worker_exited");
	assert.equal(JSON.stringify(crashed).includes("91"), false);
	assert.equal(healthy.success, true);
	assert.equal(healthy.modelOutput, "still-ready");
});

test("plugin runtime isolates sandbox construction failures and continues loading", {
	timeout: 10_000,
}, async (t) => {
	const fixture = await runtimeFixture(t, ["crash", "good"]);
	const runtime = await PluginRuntime.load({
		workspaceRoot: fixture.workspaceRoot,
		homeDir: fixture.homeDir,
		env: { PLUGIN_TEST_MODE: "ok", PLUGIN_TEST_VALUE: "unused" },
		sandboxProfile: (manifest) => {
			if (manifest.id === "crash") throw new Error("private sandbox path");
			return fullAccessSandbox(manifest.pluginRoot);
		},
	}, new AbortController().signal);
	t.after(async () => runtime.close());

	assert.deepEqual(runtime.records.map((record) => [record.pluginId, record.status]), [
		["crash", "error"],
		["good", "loaded"],
	]);
	assert.deepEqual(runtime.records[0]?.issues, ["plugin_load_failed"]);
	assert.equal(runtime.tools.some((tool) => tool.id === "plugin:good:echo"), true);
});

test("plugin runtime propagates cancellation during worker startup", {
	timeout: 10_000,
}, async (t) => {
	const fixture = await runtimeFixture(t, ["crash"]);
	const controller = new AbortController();
	const loading = PluginRuntime.load({
		workspaceRoot: fixture.workspaceRoot,
		homeDir: fixture.homeDir,
		env: { PLUGIN_TEST_MODE: "startup_timeout", PLUGIN_TEST_VALUE: "unused" },
		sandboxProfile: (manifest) => fullAccessSandbox(manifest.pluginRoot),
		createHost: (manifest) => new PluginProcessHost({
			manifest,
			env: { PLUGIN_TEST_MODE: "startup_timeout", PLUGIN_TEST_VALUE: "unused" },
			sandboxProfile: fullAccessSandbox(manifest.pluginRoot),
			startupTimeoutMs: 2_000,
		}),
	}, controller.signal);
	setTimeout(() => controller.abort(), 100);

	await assert.rejects(
		() => loading,
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
});

test("plugin runtime does not retain commands from a plugin rejected for route conflicts", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-route-conflict-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	const pluginsRoot = join(workspaceRoot, ".mycli", "plugins");
	await mkdir(pluginsRoot, { recursive: true });
	for (const pluginId of ["a-b", "a_b"] as const) {
		const pluginRoot = join(pluginsRoot, pluginId);
		await cp(join(FIXTURES, "good"), pluginRoot, { recursive: true });
		await writeFile(join(pluginRoot, "plugin.yaml"), goodManifest(pluginId), "utf8");
	}
	await writeFile(join(workspaceRoot, ".mycli", "config.toml"), [
		"[plugins]",
		'enabled = ["a-b", "a_b"]',
		"disabled = []",
	].join("\n"), "utf8");
	const runtime = await PluginRuntime.load({
		workspaceRoot,
		homeDir,
		env: {},
		sandboxProfile: (manifest) => fullAccessSandbox(manifest.pluginRoot),
	}, new AbortController().signal);
	t.after(async () => runtime.close());

	assert.deepEqual(runtime.records.map((record) => [record.pluginId, record.status]), [
		["a-b", "loaded"],
		["a_b", "error"],
	]);
	assert.deepEqual(runtime.commands.list().map((command) => command.id), [
		"plugin:a-b:late",
		"plugin:a-b:status",
	]);
});

async function runtimeFixture(
	t: TestContext,
	pluginIds: readonly ("good" | "crash")[],
): Promise<{ readonly workspaceRoot: string; readonly homeDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-runtime-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	const pluginsRoot = join(workspaceRoot, ".mycli", "plugins");
	await mkdir(pluginsRoot, { recursive: true });
	for (const pluginId of pluginIds) {
		await cp(join(FIXTURES, pluginId), join(pluginsRoot, pluginId), { recursive: true });
	}
	await writeFile(join(workspaceRoot, ".mycli", "config.toml"), [
		"[plugins]",
		`enabled = ${JSON.stringify(pluginIds)}`,
		"disabled = []",
	].join("\n"), "utf8");
	return { workspaceRoot, homeDir };
}

function toolExecutionOptions() {
	return {
		signal: new AbortController().signal,
		ownerSessionId: "session-1",
		callId: "call-1",
		publishLifecycle: () => undefined,
	};
}

function fullAccessSandbox(root: string) {
	return {
		mode: "danger-full-access" as const,
		filesystem: "unrestricted" as const,
		network: "enabled" as const,
		writableRoots: [root],
		workspaceRoot: root,
		cwd: root,
	};
}

function goodManifest(pluginId: string): string {
	return [
		"api_version: 2",
		`id: ${pluginId}`,
		`name: ${JSON.stringify(pluginId)}`,
		"entry: dist/index.js",
		"provides:",
		"  tools: [echo]",
		"  hooks: [pre_tool_use]",
		"  commands: [status, late]",
		"requires_env: []",
		"capabilities: []",
	].join("\n");
}

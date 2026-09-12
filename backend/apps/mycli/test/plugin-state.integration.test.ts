import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readErrorContext } from "@mycli/contracts";
import { PluginProcessHost, PluginRuntime } from "@mycli/integrations";
import { builtinToolManifest } from "@mycli/tools";
import { createRuntimeIntegrationComposition } from "../src/node-runtime/integration-composition.ts";

test("plugin resources publish crashes and recovery without stale state or healthy-call refreshes", { timeout: 15_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-state-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	const pluginRoot = join(workspaceRoot, ".mycli", "plugins", "crash");
	await mkdir(homeDir, { recursive: true });
	await cp(new URL("../../../packages/integrations/test/fixtures/plugins/crash/", import.meta.url), pluginRoot, { recursive: true });
	await writeFile(join(workspaceRoot, ".mycli", "config.toml"), '[plugins]\nenabled = ["crash"]\n', "utf8");
	let mode = "crash";
	let workers = 0;
	const loadPlugins = PluginRuntime.load.bind(PluginRuntime);
	// Exercise real process recovery independently of platform sandbox availability.
	t.mock.method(PluginRuntime, "load", (options: Parameters<typeof PluginRuntime.load>[0], signal: AbortSignal) => loadPlugins({
		...options,
		createHost: (manifest) => {
			workers += 1;
			return new PluginProcessHost({ manifest, env: { PLUGIN_TEST_MODE: mode, PLUGIN_TEST_VALUE: "private-value" },
				sandboxProfile: { mode: "danger-full-access", filesystem: "unrestricted", network: "enabled",
					writableRoots: [manifest.pluginRoot], workspaceRoot: manifest.pluginRoot, cwd: manifest.pluginRoot },
			});
		},
	}, signal));
	const composition = await createRuntimeIntegrationComposition({
		builtinManifest: builtinToolManifest(), workspaceRoot, homeDir, env: {},
		parentSessionId: "plugin-test", parentTurnId: () => "turn", parentTools: () => [],
		createSubagentSupervisor: () => ({
			spawn: async () => assert.fail("no subagents should start"),
			output: () => assert.fail("no subagent output expected"),
			send: async () => assert.fail("no subagent messages expected"),
			interrupt: async () => false, waitFor: async () => undefined, unload: async () => false,
			list: () => [], recoverLegacyAbandoned: () => 0, close: async () => undefined,
		}),
		resolveSubagentSpawnContext: () => assert.fail("no subagents should spawn"),
	});
	t.after(() => composition.close());
	const resource = (): Readonly<Record<string, unknown>> | undefined => composition.resources.find((item) => item.id === "plugin:crash");
	assert.equal(resource()?.status, "enabled");
	const command = composition.commands.find((service) => service.list().some((item) => item.name === "/plugin:crash:act"));
	assert.ok(command);
	const states: unknown[] = [];
	composition.subscribeExtensions(() => states.push(resource()?.status));
	const failed = await command.run("/plugin:crash:act", new AbortController().signal);
	assert.equal(failed?.ok, false);
	const errorContext = readErrorContext(failed?.error_context);
	assert.equal(errorContext?.reason, "integration.unavailable");
	assert.equal(errorContext?.details?.exit_code, 91);
	assert.equal(resource()?.status, "error");
	assert.equal(resource()?.detail, "worker_exited");
	assert.ok(composition.diagnostics.some((item) => item.source === "plugin" && item.errorClass === "crash:worker_exited"));
	assert.equal(workers, 1);
	mode = "ok";
	const recovered = await command.run("/plugin:crash:act", new AbortController().signal);
	assert.equal(recovered?.ok, true);
	assert.equal(workers, 2);
	assert.equal(resource()?.status, "enabled");
	assert.equal(resource()?.detail, undefined);
	assert.ok(states.includes("error"));
	assert.ok(states.includes("loading"));
	assert.equal(composition.diagnostics.some((item) => item.source === "plugin"), false);
	const version = composition.version;
	await command.run("/plugin:crash:act", new AbortController().signal);
	assert.equal(composition.version, version);
	assert.doesNotMatch(JSON.stringify(composition.resources), /private-value/u);

	await composition.prepareRun("command-owner", new AbortController().signal);
	await writeFile(join(workspaceRoot, ".mycli/config.toml"), '[plugins]\ndisabled = ["crash"]\n');
	await composition.refreshConfiguration();
	assert.equal((await command.run("/plugin:crash:act", new AbortController().signal))?.ok, true);
	composition.finishRun("command-owner");
	await composition.refreshConfiguration();
	assert.equal(resource()?.status, "disabled");
	assert.equal(composition.commands.some((service) => service.list().some((item) => item.name === "/plugin:crash:act")), false);
	assert.equal((await command.run("/plugin:crash:act", new AbortController().signal))?.ok, false);
	await writeFile(join(workspaceRoot, ".mycli/config.toml"), '[plugins]\nenabled = ["crash"]\n');
	await composition.prepareRun("new-command-owner", new AbortController().signal);
	const next = composition.commands.find((service) => service.list().some((item) => item.name === "/plugin:crash:act"));
	assert.equal((await next?.run("/plugin:crash:act", new AbortController().signal))?.ok, true);
	assert.equal(workers, 3);
	composition.finishRun("new-command-owner");
	await composition.reloadProjectConfiguration({ workspaceRoot, enabled: false });
	assert.equal(resource(), undefined);
	assert.equal(composition.commands.some((service) => service.list().some((item) => item.name === "/plugin:crash:act")), false);
	const closedVersion = composition.version;
	const retired = await command.run("/plugin:crash:act", new AbortController().signal);
	assert.equal(retired?.ok, false);
	assert.equal(workers, 3);
	assert.equal(composition.version, closedVersion);
	await composition.close();
	assert.equal(workers, 3);
});

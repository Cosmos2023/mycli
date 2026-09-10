import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
	loadPluginManifest,
	PluginHostError,
	PluginProcessHost,
	type LoadedPluginManifest,
} from "../../src/index.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "plugins");

test("plugin host initializes once, correlates concurrent calls, freezes registration, and shuts down", {
	timeout: 10_000,
}, async (t) => {
	const manifest = await fixtureManifest("good");
	const host = hostFor(t, manifest);

	const registrations = await host.start(new AbortController().signal);
	const [slow, fast] = await Promise.all([
		host.invoke("tool:echo", { text: "slow", delay_ms: 30 }, new AbortController().signal),
		host.invoke("tool:echo", { text: "fast" }, new AbortController().signal),
	]);
	const late = await host.invoke("command:late", {}, new AbortController().signal);

	assert.deepEqual(registrations.map((item) => [item.kind, item.name]), [
		["tool", "echo"],
		["hook", "guard"],
		["hook", "audit"],
		["command", "status"],
		["command", "late"],
	]);
	assert.deepEqual(slow, {
		ok: true,
		resultType: "tool_result",
		value: {
			success: true,
			summary: "echoed",
			modelOutput: "slow",
			metadata: { registrationCount: 1 },
		},
	});
	assert.equal(fast.value.modelOutput, "fast");
	assert.equal(late.value.ok, true);
	assert.equal(late.value.summary, "immutable");

	await host.close();
	assert.equal(host.status, "closed");
});

test("plugin host contains malformed output, unknown ids, floods, and crashes", {
	timeout: 15_000,
}, async (t) => {
	const expected = new Map([
		["malformed", "protocol_invalid"],
		["unknown_response", "unknown_response_id"],
		["stdout_flood", "stdout_limit_exceeded"],
		["stderr_flood", "stderr_limit_exceeded"],
		["crash", "worker_exited"],
	]);
	for (const [mode, kind] of expected) {
		const manifest = await fixtureManifest("crash");
		const host = hostFor(t, manifest, { PLUGIN_TEST_MODE: mode, PLUGIN_TEST_VALUE: "unused" });
		await host.start(new AbortController().signal);
		await assert.rejects(
			() => host.invoke("command:act", {}, new AbortController().signal),
			(error: unknown) => error instanceof PluginHostError && error.kind === kind,
		);
		assert.equal(host.status, "failed");
	}
});

test("plugin host rejects undeclared registration and bounds startup and call time", {
	timeout: 10_000,
}, async (t) => {
	for (const [mode, expected] of [
		["undeclared", "registration_mismatch"],
		["missing", "registration_mismatch"],
		["startup_timeout", "startup_timeout"],
	] as const) {
		const manifest = await fixtureManifest("crash");
		const host = hostFor(t, manifest, {
			PLUGIN_TEST_MODE: mode,
			PLUGIN_TEST_VALUE: "unused",
		}, { startupTimeoutMs: mode === "startup_timeout" ? 100 : 2_000 });
		await assert.rejects(
			() => host.start(new AbortController().signal),
			(error: unknown) => error instanceof PluginHostError && error.kind === expected,
		);
	}

	const manifest = await fixtureManifest("crash");
	const host = hostFor(t, manifest, {
		PLUGIN_TEST_MODE: "call_timeout",
		PLUGIN_TEST_VALUE: "unused",
	}, { callTimeoutMs: 100 });
	await host.start(new AbortController().signal);
	await assert.rejects(
		() => host.invoke("command:act", {}, new AbortController().signal),
		(error: unknown) => error instanceof PluginHostError && error.kind === "call_timeout",
	);

	const missingEnvHost = hostFor(t, manifest);
	await assert.rejects(
		() => missingEnvHost.start(new AbortController().signal),
		(error: unknown) => error instanceof PluginHostError && error.kind === "missing_required_env",
	);
});

test("plugin host caps outstanding calls and contains handler failures without leaking errors", {
	timeout: 10_000,
}, async (t) => {
	const goodManifest = await fixtureManifest("good");
	const goodHost = hostFor(t, goodManifest, {}, { maxOutstandingRequests: 1 });
	await goodHost.start(new AbortController().signal);
	const first = goodHost.invoke(
		"tool:echo",
		{ text: "first", delay_ms: 100 },
		new AbortController().signal,
	);
	await new Promise((resolve) => setImmediate(resolve));
	await assert.rejects(
		() => goodHost.invoke("tool:echo", { text: "second" }, new AbortController().signal),
		(error: unknown) => error instanceof PluginHostError && error.kind === "too_many_requests",
	);
	assert.equal((await first).value.modelOutput, "first");

	const crashManifest = await fixtureManifest("crash");
	const crashHost = hostFor(t, crashManifest, {
		PLUGIN_TEST_MODE: "handler_throw",
		PLUGIN_TEST_VALUE: "unused",
	});
	await crashHost.start(new AbortController().signal);
	await assert.rejects(
		() => crashHost.invoke("command:act", {}, new AbortController().signal),
		(error: unknown) => error instanceof PluginHostError
			&& error.kind === "handler_failed"
			&& !error.message.includes("private handler failure"),
	);
	assert.equal(crashHost.status, "ready");
});

test("plugin invocation cancellation terminates the worker process tree", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-tree-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const pidFile = join(root, "grandchild.pid");
	const manifest = await fixtureManifest("crash");
	const host = hostFor(t, manifest, {
		PLUGIN_TEST_MODE: "grandchild",
		PLUGIN_TEST_VALUE: pidFile,
	});
	await host.start(new AbortController().signal);
	const controller = new AbortController();
	const invocation = host.invoke("command:act", {}, controller.signal);
	const grandchildPid = Number(await readEventually(pidFile));
	controller.abort();

	await assert.rejects(
		() => invocation,
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
	await eventually(() => !processExists(grandchildPid));
	assert.equal(host.status, "failed");
});

async function fixtureManifest(id: "good" | "crash"): Promise<LoadedPluginManifest> {
	const result = await loadPluginManifest({
		pluginRoot: join(FIXTURES, id),
		source: "repo",
		expectedPluginId: id,
	});
	assert.equal(result.kind, "loaded");
	if (result.kind !== "loaded") throw new Error("fixture manifest failed");
	return result.manifest;
}

function hostFor(
	t: TestContext,
	manifest: LoadedPluginManifest,
	env: Readonly<NodeJS.ProcessEnv> = {},
	timeouts: {
		readonly startupTimeoutMs?: number;
		readonly callTimeoutMs?: number;
		readonly maxOutstandingRequests?: number;
	} = {},
): PluginProcessHost {
	const host = new PluginProcessHost({
		manifest,
		env,
		sandboxProfile: fullAccessSandbox(manifest.pluginRoot),
		startupTimeoutMs: timeouts.startupTimeoutMs ?? 2_000,
		callTimeoutMs: timeouts.callTimeoutMs ?? 2_000,
		maxOutstandingRequests: timeouts.maxOutstandingRequests ?? 32,
	});
	t.after(async () => host.close());
	return host;
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

async function readEventually(path: string): Promise<string> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		try {
			return await readFile(path, "utf8");
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error("fixture output was not written");
}

async function eventually(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail("condition was not met before timeout");
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

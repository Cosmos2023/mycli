import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { HookInvocation } from "@mycli/core";
import type { SandboxProfile } from "@mycli/tools";
import {
	ConfiguredHookRunner,
	HookAllowlistStore,
	type ConfiguredHookSpec,
	type ConfiguredHookTraceSummary,
} from "../../src/index.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "hook-command.mjs");

test("runs approved JSON hooks with versioned input and maps allow, deny, and modify", async (t) => {
	const fixture = await runnerFixture(t);
	const runner = configuredRunner(fixture);
	const allow = await approvedSpec(fixture, "allow", "session_start");
	const deny = await approvedSpec(fixture, "deny");
	const modify = await approvedSpec(fixture, "modify");

	assert.deepEqual(await runner.run(allow, invocation("session_start"), freshSignal()), {
		action: "allow",
		additionalContexts: ["bounded context"],
	});
	assert.deepEqual(await runner.run(deny, invocation(), freshSignal()), {
		action: "deny",
		message: "blocked by fixture",
	});
	assert.deepEqual(await runner.run(modify, invocation(), freshSignal()), {
		action: "modify",
		arguments: {
			path: "changed.md",
			inputVersion: 1,
			eventName: "PreToolUse",
		},
	});
});

test("maps Codex decisions, exit code two, and allowed plain-text context", async (t) => {
	const fixture = await runnerFixture(t);
	const runner = configuredRunner(fixture);
	const codexBlock = await approvedSpec(fixture, "codex-block", "user_prompt_submit");
	const codexContext = await approvedSpec(fixture, "codex-context", "post_tool_use");
	const exitTwo = await approvedSpec(fixture, "exit2", "stop");
	const plain = await approvedSpec(fixture, "plain", "session_start");

	assert.deepEqual(await runner.run(codexBlock, invocation("user_prompt_submit"), freshSignal()), {
		action: "deny",
		message: "codex blocked",
	});
	assert.deepEqual(await runner.run(codexContext, invocation("post_tool_use"), freshSignal()), {
		action: "allow",
		additionalContexts: ["codex context"],
	});
	assert.deepEqual(await runner.run(exitTwo, invocation("stop"), freshSignal()), {
		action: "deny",
		message: "blocked with exit two",
	});
	assert.deepEqual(await runner.run(plain, invocation("session_start"), freshSignal()), {
		action: "allow",
		additionalContexts: ["plain session context"],
	});
});

test("fails closed for invalid, nonzero, and oversized output with redacted bounded traces", async (t) => {
	const fixture = await runnerFixture(t);
	const traces: ConfiguredHookTraceSummary[] = [];
	const runner = configuredRunner(fixture, { onTrace: (trace) => traces.push(trace) });
	const invalid = await approvedSpec(fixture, "invalid");
	const nonzero = await approvedSpec(fixture, "nonzero");
	const overflow = await approvedSpec(fixture, "overflow");

	assert.deepEqual(await runner.run(invalid, invocation(), freshSignal()), {
		action: "error",
		message: "configured hook output invalid",
	});
	assert.deepEqual(await runner.run(nonzero, invocation(), freshSignal()), {
		action: "error",
		message: "configured hook failed",
	});
	assert.deepEqual(await runner.run(overflow, invocation(), freshSignal()), {
		action: "error",
		message: "configured hook output too large",
	});
	const serialized = JSON.stringify(traces);
	assert.equal(serialized.includes("private-value"), false);
	assert.equal(serialized.includes("hook-command.mjs"), false);
	assert.equal(serialized.includes(fixture.workspaceRoot), false);
	assert.equal(traces[1]?.exitCode, 7);
	assert.equal(traces[2]?.stdoutTruncated || traces[2]?.stderrTruncated, true);
	for (const trace of traces) {
		assert.ok(trace.stdoutChars <= 2_001);
		assert.ok(trace.stderrChars <= 2_001);
	}
});

test("removes private absolute paths from trace messages", async (t) => {
	const fixture = await runnerFixture(t);
	const traces: ConfiguredHookTraceSummary[] = [];
	const runner = configuredRunner(fixture, { onTrace: (trace) => traces.push(trace) });
	const spec = await approvedSpec(fixture, "path-deny");

	const result = await runner.run(spec, invocation(), freshSignal());

	assert.equal(result.action, "deny");
	const serialized = JSON.stringify(traces);
	assert.equal(serialized.includes("/Users/private"), false);
	assert.equal(serialized.includes("C:\\Users\\Private"), false);
});

test("enforces minimal and inherit-safe environments and configured working directories", async (t) => {
	const fixture = await runnerFixture(t);
	const minimalRunner = configuredRunner(fixture, {
		env: {
			PATH: process.env.PATH,
			HOME: "/safe/home",
			PRIVATE_TOKEN: "private-value",
		},
	});
	const inheritedRunner = configuredRunner(fixture, {
		env: {
			PATH: process.env.PATH,
			HOME: "/safe/home",
			PRIVATE_TOKEN: "private-value",
		},
	});
	const minimal = await approvedSpec(fixture, "environment");
	const inherited = await approvedSpec(fixture, "environment", "pre_tool_use", {
		envPolicy: "inherit_safe",
		hookId: "inherited",
	});
	const cwd = await approvedSpec(fixture, "cwd", "pre_tool_use", {
		workingDirectory: "config",
		hookId: "cwd",
	});

	assert.deepEqual(await minimalRunner.run(minimal, invocation(), freshSignal()), {
		action: "modify",
		arguments: { hasHome: false, hasPrivate: false, hasPath: true, hookId: "environment" },
	});
	assert.deepEqual(await inheritedRunner.run(inherited, invocation(), freshSignal()), {
		action: "modify",
		arguments: { hasHome: true, hasPrivate: false, hasPath: true, hookId: "inherited" },
	});
	assert.deepEqual(await minimalRunner.run(cwd, invocation(), freshSignal()), {
		action: "modify",
		arguments: { cwdBase: ".mycli" },
	});
});

test("never spawns unapproved hooks and always uses direct argv execution", async (t) => {
	const fixture = await runnerFixture(t);
	const runner = configuredRunner(fixture);
	const unapprovedMarker = join(fixture.root, "unapproved.txt");
	const changedMarker = join(fixture.root, "digest-changed.txt");
	const shellMarker = join(fixture.root, "shell-expanded.txt");
	const unapproved = hookSpec(fixture, "marker", "pre_tool_use", {
		commandTail: [unapprovedMarker],
	});
	const originallyApproved = await approvedSpec(fixture, "marker", "pre_tool_use", {
		commandTail: [changedMarker],
		hookId: "digest-change",
	});
	const digestChanged = Object.freeze({
		...originallyApproved,
		command: Object.freeze([...originallyApproved.command, "--changed"]),
	});
	const direct = await approvedSpec(fixture, "allow", "pre_tool_use", {
		commandTail: ["&&", "touch", shellMarker],
		hookId: "direct",
	});

	assert.deepEqual(await runner.run(unapproved, invocation(), freshSignal()), {
		action: "error",
		message: "configured hook not allowlisted",
	});
	assert.deepEqual(await runner.run(digestChanged, invocation(), freshSignal()), {
		action: "error",
		message: "configured hook not allowlisted",
	});
	await runner.run(direct, invocation(), freshSignal());
	await assert.rejects(() => access(unapprovedMarker));
	await assert.rejects(() => access(changedMarker));
	await assert.rejects(() => access(shellMarker));
});

test("maps sandbox failure and timeout without leaking process details", async (t) => {
	const fixture = await runnerFixture(t);
	const traces: ConfiguredHookTraceSummary[] = [];
	const sandboxFailure = configuredRunner(fixture, {
		onTrace: (trace) => traces.push(trace),
		prepareProcess: () => { throw new Error("token=private-sandbox-value"); },
	});
	const allowed = await approvedSpec(fixture, "allow");

	assert.deepEqual(await sandboxFailure.run(allowed, invocation(), freshSignal()), {
		action: "error",
		message: "configured hook failed",
	});
	assert.equal(JSON.stringify(traces).includes("private-sandbox-value"), false);

	const marker = join(fixture.root, "timeout-grandchild.pid");
	const timeout = await approvedSpec(fixture, "hang-tree", "pre_tool_use", {
		commandTail: [marker],
		hookId: "timeout",
		timeoutMs: 1_000,
	});
	assert.deepEqual(await configuredRunner(fixture).run(timeout, invocation(), freshSignal()), {
		action: "error",
		message: "configured hook timed out",
	});
	const pid = Number(await readFileEventually(marker));
	await assertProcessStops(pid);
});

test("interrupts the complete hook process tree and rethrows AbortError", async (t) => {
	const fixture = await runnerFixture(t);
	const marker = join(fixture.root, "interrupt-grandchild.pid");
	const spec = await approvedSpec(fixture, "hang-tree", "pre_tool_use", {
		commandTail: [marker],
		hookId: "interrupt",
		timeoutMs: 5_000,
	});
	const traces: ConfiguredHookTraceSummary[] = [];
	const runner = configuredRunner(fixture, { onTrace: (trace) => traces.push(trace) });
	const controller = new AbortController();
	const running = runner.run(spec, invocation(), controller.signal);
	const pid = Number(await readFileEventually(marker));
	controller.abort();

	await assert.rejects(running, (error: unknown) => (
		error instanceof Error && error.name === "AbortError"
	));
	await assertProcessStops(pid);
	assert.equal(traces[0]?.status, "interrupted");
	assert.equal(traces[0]?.message, "interrupted");
});

async function runnerFixture(t: TestContext): Promise<{
	readonly root: string;
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly allowlist: HookAllowlistStore;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-hook-runner-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	await mkdir(join(workspaceRoot, ".mycli"), { recursive: true });
	return {
		root,
		homeDir: join(root, "home"),
		workspaceRoot,
		allowlist: new HookAllowlistStore({ homeDir: join(root, "home") }),
	};
}

function configuredRunner(
	fixture: Awaited<ReturnType<typeof runnerFixture>>,
	options: {
		readonly env?: Readonly<NodeJS.ProcessEnv>;
		readonly onTrace?: (trace: ConfiguredHookTraceSummary) => void;
		readonly prepareProcess?: ConstructorParameters<typeof ConfiguredHookRunner>[0]["prepareProcess"];
	} = {},
): ConfiguredHookRunner {
	return new ConfiguredHookRunner({
		workspaceRoot: fixture.workspaceRoot,
		allowlistStore: fixture.allowlist,
		sandboxProfile: (cwd): SandboxProfile => ({
			mode: "danger-full-access",
			filesystem: "unrestricted",
			network: "enabled",
			writableRoots: [fixture.workspaceRoot],
			workspaceRoot: fixture.workspaceRoot,
			cwd,
		}),
		...(options.env ? { env: options.env } : {}),
		...(options.onTrace ? { onTrace: options.onTrace } : {}),
		...(options.prepareProcess ? { prepareProcess: options.prepareProcess } : {}),
	});
}

async function approvedSpec(
	fixture: Awaited<ReturnType<typeof runnerFixture>>,
	mode: string,
	hookPoint: ConfiguredHookSpec["hookPoint"] = "pre_tool_use",
	overrides: {
		readonly hookId?: string;
		readonly timeoutMs?: number;
		readonly envPolicy?: ConfiguredHookSpec["envPolicy"];
		readonly workingDirectory?: ConfiguredHookSpec["workingDirectory"];
		readonly commandTail?: readonly string[];
	} = {},
): Promise<ConfiguredHookSpec> {
	const spec = hookSpec(fixture, mode, hookPoint, overrides);
	await fixture.allowlist.approve(spec);
	return spec;
}

function hookSpec(
	fixture: Awaited<ReturnType<typeof runnerFixture>>,
	mode: string,
	hookPoint: ConfiguredHookSpec["hookPoint"] = "pre_tool_use",
	overrides: {
		readonly hookId?: string;
		readonly timeoutMs?: number;
		readonly envPolicy?: ConfiguredHookSpec["envPolicy"];
		readonly workingDirectory?: ConfiguredHookSpec["workingDirectory"];
		readonly commandTail?: readonly string[];
	} = {},
): ConfiguredHookSpec {
	const hookId = overrides.hookId ?? mode;
	return Object.freeze({
		hookId,
		name: `configured:repo:${hookId}`,
		hookPoint,
		command: Object.freeze([process.execPath, FIXTURE, mode, ...(overrides.commandTail ?? [])]),
		enabled: true,
		timeoutMs: overrides.timeoutMs ?? 2_000,
		workingDirectory: overrides.workingDirectory ?? "workspace",
		envPolicy: overrides.envPolicy ?? "minimal",
		matcher: Object.freeze({ kind: "any" }),
		scope: "repo",
		configPath: join(fixture.workspaceRoot, ".mycli", "hooks.json"),
	});
}

function invocation(point: HookInvocation["point"] = "pre_tool_use"): HookInvocation {
	return Object.freeze({
		point,
		sessionId: "session-1",
		turnId: "turn-1",
		toolName: "Write",
		arguments: Object.freeze({ path: "README.md" }),
		metadata: Object.freeze({ source: "startup", prompt: "hello" }),
	});
}

function freshSignal(): AbortSignal {
	return new AbortController().signal;
}

async function readFileEventually(path: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const value = (await readFile(path, "utf8")).trim();
			if (/^[1-9]\d*$/u.test(value)) return value;
		} catch {
			// The fixture may not have created the marker yet.
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error(`fixture marker was not written: ${dirname(path)}`);
}

async function assertProcessStops(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	assert.fail(`process ${pid} remained alive`);
}

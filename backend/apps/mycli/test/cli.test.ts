import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
	defaultUserRipgrepRoot,
	ripgrepOutputPath,
	ripgrepPlatformKey,
} from "@mycli/tools";
import type { GatewayTransport } from "mycli-shell-tui/gateway-transport";
import { runCli } from "../src/cli.ts";
import type { NodeBackend } from "../src/node-runtime/node-backend.ts";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function fakeBackend(): {
	backend: NodeBackend;
	completion: Deferred<number>;
	closeCalls: () => number;
	killCalls: () => number;
} {
	const completion = deferred<number>();
	let closeCalls = 0;
	let killCalls = 0;
	return {
		completion,
		closeCalls: () => closeCalls,
		killCalls: () => killCalls,
		backend: {
			transport: { input: new PassThrough(), output: new PassThrough() },
			completion: completion.promise,
			diagnostic: () => "api_key=[REDACTED]",
			close: async () => { closeCalls += 1; },
			kill: () => { killCalls += 1; },
		},
	};
}

function cliHarness(overrides: Record<string, unknown> = {}) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const hooks = new EventEmitter();
	return {
		stdout,
		stderr,
		hooks,
		options: {
			argv: [],
			env: {},
			cwd: "/repo",
			stdin: { isTTY: true },
			stdout: { isTTY: true, write: (value: string) => { stdout.push(value); } },
			stderr: { write: (value: string) => { stderr.push(value); } },
			processHooks: hooks,
			...overrides,
		},
	};
}

test("help and version are local and never start the Node backend", async (t) => {
	for (const scenario of [
		{ argv: ["--help"], expected: "Usage: mycli" },
		{ argv: ["--version"], expected: "0.1.0" },
	]) {
		await t.test(scenario.argv[0] ?? "", async () => {
			let starts = 0;
			const harness = cliHarness({
				argv: scenario.argv,
				stdin: { isTTY: false },
				stdout: { isTTY: false, write: (value: string) => { harness.stdout.push(value); } },
				startNodeBackend: () => { starts += 1; return fakeBackend().backend; },
			});

			assert.equal(await runCli(harness.options), 0);
			assert.equal(starts, 0);
			assert.match(harness.stdout.join(""), new RegExp(scenario.expected.replaceAll(".", "\\.")));
		});
	}
});

test("help advertises the provider-free management surface", async () => {
	const harness = cliHarness({ argv: ["--help"] });

	assert.equal(await runCli(harness.options), 0);
	for (const command of ["setup", "doctor", "hooks", "plugins", "mcp"]) {
		assert.match(harness.stdout.join(""), new RegExp(`\\b${command}\\b`));
	}
	assert.doesNotMatch(harness.stdout.join(""), /runtime-backend|python-sidecar/u);
});

test("CLI startup prepends vendored ripgrep before handling local commands", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-cli-ripgrep-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const binary = ripgrepOutputPath(defaultUserRipgrepRoot(homeDir), ripgrepPlatformKey());
	await mkdir(dirname(binary), { recursive: true });
	await writeFile(binary, "#!/bin/sh\nexit 0\n", "utf8");
	await chmod(binary, 0o755);
	const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
	const harness = cliHarness({ argv: ["--help"], env, homeDir });

	assert.equal(await runCli(harness.options), 0);
	assert.equal(env.PATH, `${dirname(binary)}:/usr/bin`);
	assert.equal(env.MYCLI_RIPGREP_PATH_DIR, dirname(binary));
});

test("retired runtime backend flags fail before starting Node", async () => {
	let starts = 0;
	const harness = cliHarness({
		argv: ["--runtime-backend", "node"],
		startNodeBackend: () => { starts += 1; return fakeBackend().backend; },
	});

	assert.equal(await runCli(harness.options), 2);
	assert.equal(starts, 0);
	assert.match(harness.stderr.join(""), /invalid_arguments/u);
});

test("JSON management commands run without TTY, backend, provider, or TUI startup", async () => {
	let nodeStarts = 0;
	let tuiImports = 0;
	let managementCalls = 0;
	const expected = {
		ok: true,
		action: "list",
		message: "mcp: 0 configured",
		servers: [],
		issues: [],
	};
	const harness = cliHarness({
		argv: ["mcp", "list", "--json"],
		stdin: { isTTY: false },
		stdout: { isTTY: false, write: (value: string) => { harness.stdout.push(value); } },
		startNodeBackend: async () => { nodeStarts += 1; return fakeBackend().backend; },
		importTui: async () => { tuiImports += 1; },
		management: {
			execute: async (command: { kind: string; action: string }) => {
				managementCalls += 1;
				assert.deepEqual(command, { kind: "mcp", action: "list", json: true });
				return expected;
			},
		},
	});

	assert.equal(await runCli(harness.options), 0);
	assert.deepEqual(JSON.parse(harness.stdout.join("")), expected);
	assert.equal(managementCalls, 1);
	assert.equal(nodeStarts, 0);
	assert.equal(tuiImports, 0);
});

test("doctor and setup route before backend selection", async (t) => {
	for (const kind of ["doctor", "setup"] as const) {
		await t.test(kind, async () => {
			let commandKind = "";
			const harness = cliHarness({
				argv: [kind],
				stdin: { isTTY: false },
				stdout: { isTTY: false, write: (value: string) => { harness.stdout.push(value); } },
				management: {
					execute: async (command: { kind: string }) => {
						commandKind = command.kind;
						return { ok: true, action: kind, message: `${kind} complete` };
					},
				},
			});

			assert.equal(await runCli(harness.options), 0);
			assert.equal(commandKind, kind);
			assert.match(harness.stdout.join(""), new RegExp(`${kind} complete`));
		});
	}
});

test("invalid plugin JSON arguments fail before management or backend startup", async () => {
	let starts = 0;
	let managementCalls = 0;
	const harness = cliHarness({
		argv: ["plugins", "run", "demo", "status", "--json-args", "[]"],
		stdin: { isTTY: false },
		startNodeBackend: () => { starts += 1; return fakeBackend().backend; },
		management: {
			execute: async () => { managementCalls += 1; return { ok: true }; },
		},
	});

	assert.equal(await runCli(harness.options), 2);
	assert.equal(starts, 0);
	assert.equal(managementCalls, 0);
	assert.match(harness.stderr.join(""), /invalid_json_arguments/);
});

test("default management composition lists local extensions without backend startup", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-cli-management-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let starts = 0;
	for (const argv of [
		["doctor", "--json"],
		["hooks", "list", "--json"],
		["plugins", "list", "--json"],
		["mcp", "list", "--json"],
	] as const) {
		const harness = cliHarness({
			argv,
			cwd: root,
			homeDir: join(root, "home"),
			stdin: { isTTY: false },
			stdout: { isTTY: false, write: (value: string) => { harness.stdout.push(value); } },
			startNodeBackend: async () => { starts += 1; return fakeBackend().backend; },
		});

		assert.equal(await runCli(harness.options), 0, argv.join(" "));
		assert.equal(JSON.parse(harness.stdout.join("")).ok, true);
	}
	assert.equal(starts, 0);
});

test("default non-TTY setup persists through Node without backend or secret output", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-cli-setup-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const ripgrepPath = ripgrepOutputPath(defaultUserRipgrepRoot(homeDir), ripgrepPlatformKey());
	await mkdir(dirname(ripgrepPath), { recursive: true });
	await writeFile(ripgrepPath, "prepared-test-binary", "utf8");
	await chmod(ripgrepPath, 0o755);
	const input = new PassThrough() as PassThrough & { isTTY?: boolean };
	input.isTTY = false;
	input.end("5\n\n\nsecret-cli-value\n");
	const output = new PassThrough() as PassThrough & { isTTY?: boolean };
	output.isTTY = false;
	let rendered = "";
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => { rendered += chunk; });
	let starts = 0;

	const code = await runCli({
		argv: ["setup"],
		env: {},
		cwd: root,
		homeDir,
		stdin: input,
		stdout: output,
		stderr: { write: () => undefined },
		processHooks: new EventEmitter(),
		startNodeBackend: async () => { starts += 1; return fakeBackend().backend; },
	});

	assert.equal(code, 0);
	assert.equal(starts, 0);
	assert.equal(rendered.includes("secret-cli-value"), false);
	assert.equal(rendered.includes("ripgrep already prepared"), true);
});

test("interactive startup configures transport before importing the TUI", async () => {
	const order: string[] = [];
	const fake = fakeBackend();
	let configured: GatewayTransport | null = null;
	const harness = cliHarness({
		argv: ["--session", "demo", "--model", "gpt-test"],
		startNodeBackend: (options: { args: readonly string[] }) => {
			order.push(`start:${options.args.join(" ")}`);
			return fake.backend;
		},
		configureTransport: (transport: GatewayTransport) => {
			order.push("configure");
			configured = transport;
		},
		importTui: async () => {
			order.push("import");
			await configured?.close?.();
			fake.completion.resolve(0);
		},
	});

	assert.equal(await runCli(harness.options), 0);
	assert.deepEqual(order, [
		"start:--session demo --model gpt-test",
		"configure",
		"import",
	]);
	assert.equal(fake.closeCalls(), 1);
});

test("CLI validates TTY before starting the Node backend", async () => {
	let starts = 0;
	const harness = cliHarness({
		stdin: { isTTY: false },
		startNodeBackend: () => { starts += 1; return fakeBackend().backend; },
	});

	assert.equal(await runCli(harness.options), 2);
	assert.equal(starts, 0);
	assert.match(harness.stderr.join(""), /tty_required/);
});

test("spawn failure returns two with a stable message", async () => {
	const harness = cliHarness({
		startNodeBackend: () => { throw new Error("node_backend_start_failed: unable to start Node backend"); },
	});

	assert.equal(await runCli(harness.options), 2);
	assert.match(harness.stderr.join(""), /node_backend_start_failed/);
	assert.doesNotMatch(harness.stderr.join(""), /private|ENOENT/);
});

test("interactive startup always selects Node and ignores the retired backend environment", async () => {
	let nodeStarts = 0;
	const fake = fakeBackend();
	let configured: GatewayTransport | null = null;
	const harness = cliHarness({
		env: { MYCLI_RUNTIME_BACKEND: "python-sidecar" },
		startNodeBackend: async (): Promise<NodeBackend> => {
			nodeStarts += 1;
			return fake.backend;
		},
		configureTransport: (transport: GatewayTransport) => { configured = transport; },
		importTui: async () => {
			await configured?.close?.();
			fake.completion.resolve(0);
		},
	});

	assert.equal(await runCli(harness.options), 0);
	assert.equal(nodeStarts, 1);
});

test("unexpected Node backend exit returns one without printing its diagnostic", async () => {
	const fake = fakeBackend();
	const harness = cliHarness({
		startNodeBackend: () => fake.backend,
		configureTransport: () => undefined,
		importTui: async () => { fake.completion.resolve(7); },
	});

	assert.equal(await runCli(harness.options), 1);
	assert.doesNotMatch(harness.stderr.join(""), /api_key/);
});

test("abnormal parent exit synchronously kills a running Node backend", async () => {
	const fake = fakeBackend();
	const harness = cliHarness({
		startNodeBackend: () => fake.backend,
		configureTransport: () => undefined,
		importTui: async () => {
			harness.hooks.emit("exit", 1);
			fake.completion.resolve(1);
		},
	});

	assert.equal(await runCli(harness.options), 1);
	assert.equal(fake.killCalls(), 1);
});

test("asynchronous TUI startup failure exits one and prints only sanitized diagnostics", async () => {
	const fake = fakeBackend();
	const startup = deferred<void>();
	void startup.promise.catch(() => undefined);
	const harness = cliHarness({
		startNodeBackend: () => fake.backend,
		configureTransport: () => undefined,
		importTui: async () => {
			queueMicrotask(() => {
				startup.reject(new Error("private module path"));
				fake.completion.resolve(0);
			});
			return { gatewayStartup: startup.promise };
		},
	});

	assert.equal(await runCli(harness.options), 1);
	assert.equal(fake.closeCalls(), 1);
	assert.match(harness.stderr.join(""), /tui_start_failed/);
	assert.match(harness.stderr.join(""), /api_key=\[REDACTED\]/);
	assert.doesNotMatch(harness.stderr.join(""), /private module path/);
});

test("SIGINT before TUI ownership closes the Node backend and returns 130", async () => {
	const fake = fakeBackend();
	const harness = cliHarness({
		startNodeBackend: () => fake.backend,
		configureTransport: () => undefined,
		importTui: async () => {
			harness.hooks.emit("SIGINT");
			fake.completion.resolve(0);
			return { gatewayStartup: Promise.resolve() };
		},
	});

	assert.equal(await runCli(harness.options), 130);
	assert.equal(fake.closeCalls(), 1);
});

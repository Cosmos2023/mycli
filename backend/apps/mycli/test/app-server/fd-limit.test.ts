import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FD_SOFT_LIMIT_TARGET, fdLimitShellCommand, raiseFdSoftLimit } from "../../src/app-server/fd-limit.ts";

type JsonObject = Readonly<Record<string, unknown>>;

function options(overrides: Partial<Parameters<typeof raiseFdSoftLimit>[0]> = {}) {
	return {
		platform: "darwin" as NodeJS.Platform,
		env: {} as Readonly<Record<string, string | undefined>>,
		command: ["/usr/bin/node", "/repo/cli.ts", "app-server"],
		readSoftLimit: async () => 256,
		reexec: async () => 0,
		...overrides,
	};
}

test("a low soft descriptor limit replaces the process once through the shell", async () => {
	const calls: { command: readonly string[]; env: NodeJS.ProcessEnv; target: number }[] = [];
	const code = await raiseFdSoftLimit(options({ reexec: async (command, env, target) => {
		calls.push({ command, env, target });
		return 17;
	} }));

	assert.equal(code, 17);
	assert.deepEqual(calls, [{
		command: ["/usr/bin/node", "/repo/cli.ts", "app-server"],
		env: { MYCLI_FD_LIMIT_RAISED: "1" },
		target: FD_SOFT_LIMIT_TARGET,
	}]);
});

test("the raise is skipped when it is unsupported, already applied, or unnecessary", async () => {
	const reexecs: number[] = [];
	const run = (overrides: Partial<Parameters<typeof raiseFdSoftLimit>[0]>) => raiseFdSoftLimit(options({
		reexec: async () => { reexecs.push(1); return 0; },
		...overrides,
	}));

	assert.equal(await run({ platform: "win32" }), undefined);
	assert.equal(await run({ env: { MYCLI_FD_LIMIT_RAISED: "1" } }), undefined);
	assert.equal(await run({ readSoftLimit: async () => FD_SOFT_LIMIT_TARGET }), undefined);
	assert.equal(await run({ readSoftLimit: async () => FD_SOFT_LIMIT_TARGET * 4 }), undefined);
	assert.equal(await run({ readSoftLimit: async () => undefined }), undefined);
	assert.equal(await run({ readSoftLimit: async () => { throw new Error("no shell"); } }), undefined);
	assert.deepEqual(reexecs, []);
});

test("app-server raises a low soft descriptor limit without breaking the stdio protocol", {
	skip: process.platform === "win32", timeout: 30_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-fd-limit-"));
	const home = join(root, "home");
	await mkdir(join(home, ".mycli"), { recursive: true });
	await writeFile(join(home, ".mycli", "config.toml"), "[updates]\ncheck_on_startup = false\n");
	t.after(() => rm(root, { recursive: true, force: true }));
	const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
	// The outer shell lowers the limit the way a minimal login shell would.
	const child = spawn("/bin/sh", ["-c", 'ulimit -S -n 256; exec "$0" "$@"', process.execPath,
		"--conditions=mycli-source", "--import", "tsx", cli, "app-server", "--session", "fd-session"], {
		cwd: process.cwd(), env: { ...process.env, HOME: home, USERPROFILE: home },
		stdio: ["pipe", "pipe", "pipe"],
	});
	t.after(() => child.kill("SIGKILL"));
	const messages: JsonObject[] = [];
	createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line) as JsonObject));
	await waitFor(() => messages.some((message) => message.method === "runtime.ready"));
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "bootstrap", method: "session.bootstrap",
		params: { protocol_version: 1 } })}\n`);
	const response = await waitFor(() => messages.find((message) => message.id === "bootstrap"));
	assert.equal((response.result as JsonObject | undefined)?.session_id, "fd-session");
	child.stdin.end();
	assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
});

test("the re-exec shell command raises a lowered soft limit to the target", {
	skip: process.platform === "win32", timeout: 20_000,
}, async () => {
	// Node itself raises the macOS limit through libuv, so observe the shell command directly.
	const child = spawn("/bin/sh", ["-c", 'ulimit -S -n 256; exec "$0" "$@"', "/bin/sh",
		"-c", fdLimitShellCommand(FD_SOFT_LIMIT_TARGET), "/bin/sh", "-c", "ulimit -n"],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
	assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
	assert.equal(stdout.trim(), String(FD_SOFT_LIMIT_TARGET));
});

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("timed out waiting for app-server output");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

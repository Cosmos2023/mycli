import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
	createShellEnvironment,
	resolveShellProfile,
	ShellSessionManager,
	windowsConsoleFallbackEncoding,
	type ShellProfile,
	type ShellSessionSnapshot,
	type ShellStartRequest,
} from "../../src/index.ts";

const WINDOWS_ONLY = process.platform !== "win32";

test("PowerShell sessions pin UTF-8 and decode native output", {
	skip: WINDOWS_ONLY,
}, async (t) => {
	const cwd = await workspace(t, {
		"emit-utf8.cjs": "process.stdout.write('中文');\n",
	});
	const profile = resolveShellProfile({ env: process.env });
	if (profile.kind !== "powershell") {
		t.skip("no PowerShell on this host");
		return;
	}
	const output = await runCommand(t, {
		profile,
		cwd,
		command: `[Console]::OutputEncoding.CodePage; & "${process.execPath}" emit-utf8.cjs`,
	});

	assert.match(output, /65001/u);
	assert.equal(output.includes("中文"), true, readable(output));
});

test("cmd sessions decode console code page output instead of mojibake", {
	skip: WINDOWS_ONLY || windowsConsoleFallbackEncoding() !== "gbk",
}, async (t) => {
	const cwd = await workspace(t, {
		// Raw GBK bytes for 中文, exactly like a legacy console program would print.
		"emit-gbk.cjs": "process.stdout.write(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));\n",
	});
	const profile = resolveShellProfile({
		env: process.env,
		shellPath: process.env.ComSpec ?? "cmd.exe",
	});
	const output = await runCommand(t, {
		profile,
		cwd,
		command: `"${process.execPath}" emit-gbk.cjs`,
	});

	assert.equal(output.includes("中文"), true, readable(output));
	assert.equal(output.includes("\uFFFD"), false, readable(output));
});

async function workspace(
	t: test.TestContext,
	files: Readonly<Record<string, string>>,
): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mycli-shell-console-encoding-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const [name, content] of Object.entries(files)) {
		await writeFile(join(directory, name), content, "utf8");
	}
	return directory;
}

async function runCommand(
	t: test.TestContext,
	input: {
		readonly profile: ShellProfile;
		readonly cwd: string;
		readonly command: string;
	},
): Promise<string> {
	const manager = new ShellSessionManager();
	t.after(async () => { await manager.close(); });
	const environment = createShellEnvironment({
		cwd: input.cwd,
		sourceEnv: process.env,
	});
	const snapshot = await manager.start({
		ownerSessionId: "session-console-encoding",
		callId: "call-console-encoding",
		command: input.command,
		executable: input.profile.executable,
		args: input.profile.execArgv(input.command),
		cwd: input.cwd,
		env: environment.env,
		platform: process.platform,
		tty: false,
		rows: 24,
		columns: 120,
		background: false,
		yieldTimeMs: 15_000,
		timeoutSeconds: 30,
		publishLifecycle: () => undefined,
		shellKind: input.profile.kind,
	} satisfies ShellStartRequest);
	return finish(manager, snapshot);
}

async function finish(
	manager: ShellSessionManager,
	snapshot: ShellSessionSnapshot,
): Promise<string> {
	let current = snapshot;
	for (let attempt = 0; attempt < 100 && current.status === "running"; attempt += 1) {
		current = await manager.interact({
			ownerSessionId: "session-console-encoding",
			shellId: current.shellId,
			chars: "",
			yieldTimeMs: 1_000,
		});
	}
	return `${current.stdout}${current.stderr}`;
}

function readable(output: string): string {
	return JSON.stringify(output);
}

import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import {
	startNodePtyTransport,
	type ShellExit,
	type ShellTransport,
} from "../src/index.ts";

test("native PTY lifecycle supports output input resize and completion", { timeout: 5_000 }, async () => {
	const windows = process.platform === "win32";
	const transport = await startNodePtyTransport({
		executable: windows ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh"),
		args: windows ? ["/q"] : ["-i"],
		cwd: process.cwd(),
		env: { ...process.env, TERM: "xterm-256color" },
		platform: process.platform,
		tty: true,
		name: "xterm-256color",
		rows: 24,
		columns: 80,
	});
	let exited = false;
	try {
		const output = collectOutput(transport);
		const exit = nextExit(transport).then((value) => {
			exited = true;
			return value;
		});
		await transport.resize(40, 100);
		await transport.write(windows
			? "echo pty-ready\r\n"
			: "printf 'pty-ready\\n'\n");
		await waitForOutput(output, "pty-ready");
		await transport.write(windows
			? "echo pty-input && exit 0\r\n"
			: "printf 'pty-input\\n'; exit 0\n");
		assert.deepEqual(await exit, { exitCode: 0, signal: null });
		assert.match(output.text, /pty-ready/u);
		assert.match(output.text, /pty-input/u);
	} finally {
		if (!exited) await transport.terminate().catch(() => undefined);
		await transport.close();
	}
});

test("native PTY lifecycle interrupts and cleans the process tree", { timeout: 5_000 }, async () => {
	const windows = process.platform === "win32";
	const transport = await startNodePtyTransport({
		executable: windows ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh"),
		args: windows ? ["/q"] : ["-i"],
		cwd: process.cwd(),
		env: { ...process.env, TERM: "xterm-256color" },
		platform: process.platform,
		tty: true,
		name: "xterm-256color",
		rows: 24,
		columns: 80,
	});
	let exited = false;
	try {
		const output = collectOutput(transport);
		const exit = nextExit(transport).then((value) => {
			exited = true;
			return value;
		});
		await transport.write(windows
			? "echo interrupt-ready && ping -n 30 127.0.0.1 > nul\r\n"
			: "printf 'interrupt-ready\\n'; sleep 30\n");
		await waitForOutput(output, "interrupt-ready");
		const cleanup = await transport.interrupt();
		assert.notEqual(cleanup.state, "inconclusive");
		await exit;
	} finally {
		if (!exited) await transport.terminate().catch(() => undefined);
		await transport.close();
	}
});

function collectOutput(transport: ShellTransport): { text: string } {
	const output = { text: "" };
	transport.onOutput((chunk) => {
		output.text += typeof chunk.data === "string"
			? chunk.data
			: Buffer.from(chunk.data).toString("utf8");
	});
	return output;
}

function nextExit(transport: ShellTransport): Promise<ShellExit> {
	return new Promise((resolve) => {
		const unsubscribe = transport.onExit((exit) => {
			unsubscribe();
			resolve(exit);
		});
	});
}

async function waitForOutput(output: { readonly text: string }, expected: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!output.text.includes(expected)) {
		if (Date.now() >= deadline) throw new Error("native_pty_output_timeout");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

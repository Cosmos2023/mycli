#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startNodePtyTransport } from "../backend/packages/tools/dist/index.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(ROOT, "tui", "mycli-shell", "package.json"));
const { Terminal: XtermHeadless } = require("@xterm/headless");
const runner = join(ROOT, "tui", "mycli-shell", "test", "support", "native-pty-shell-runner.ts");
const terminal = new XtermHeadless({
	cols: 72,
	rows: 16,
	scrollback: 500,
	allowProposedApi: true,
	logLevel: "off",
});
const transport = await startNodePtyTransport({
	executable: process.execPath,
	args: ["--conditions=mycli-source", "--import", "tsx", runner],
	cwd: ROOT,
	env: { ...process.env, TERM: "xterm-256color" },
	platform: process.platform,
	tty: true,
	name: "xterm-256color",
	rows: 16,
	columns: 72,
});

let output = "";
let exited = false;
let terminalWriteTail = Promise.resolve();
let readyResolve;
const ready = new Promise((resolve) => {
	readyResolve = resolve;
});
transport.onOutput((chunk) => {
	const data = typeof chunk.data === "string"
		? chunk.data
		: Buffer.from(chunk.data).toString("utf8");
	output += data;
	terminalWriteTail = terminalWriteTail.then(() => new Promise((resolve) => {
		terminal.write(data, resolve);
	}));
	if (output.includes("MYCLI_TUI_PTY_READY")) readyResolve();
});
const exit = new Promise((resolve) => transport.onExit(resolve)).then((value) => {
	exited = true;
	return value;
});

try {
	await Promise.race([
		ready,
		delay(5_000).then(() => {
			throw new Error("TUI PTY did not become ready");
		}),
	]);
	for (const [rows, columns] of [[13, 43], [19, 91], [12, 37], [17, 78]]) {
		await terminalWriteTail;
		terminal.resize(columns, rows);
		await transport.resize(rows, columns);
		await delay(55);
	}
	const result = await Promise.race([
		exit,
		delay(5_000).then(() => {
			throw new Error("TUI PTY smoke timed out");
		}),
	]);
	await terminalWriteTail;
	const buffer = terminal.buffer.normal;
	const rendered = Array.from({ length: buffer.length }, (_, row) =>
		buffer.getLine(row)?.translateToString(true) ?? "",
	).join("\n");

	assert.equal(result.exitCode, 0);
	assert.match(rendered, /pty-final/u);
	assert.match(rendered, /pty-ready/u);
	assert.match(output, /MYCLI_TUI_PTY_OK/u);
	assert.match(output, /\x1b\[\?2026h/u);
	assert.match(output, /\x1b\[\?2026l/u);
	assert.match(output, /\x1b\[\?2004h/u);
	assert.match(output, /\x1b\[\?2004l/u);
	assert.match(output, /\x1b\[<u/u);
	assert.match(output, /\x1b\[\?25h/u);
	assert.doesNotMatch(output, /\x1b\[\?1049[hl]/u);
} finally {
	if (!exited) await transport.terminate().catch(() => undefined);
	await transport.close();
	await terminalWriteTail.catch(() => undefined);
	terminal.dispose();
}

process.stdout.write("tui-native-pty-ok\n");

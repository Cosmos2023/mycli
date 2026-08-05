#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACES = [
	"@mycli/contracts",
	"@mycli/core",
	"@mycli/config",
	"@mycli/tools",
	"@mycli/providers",
	"@mycli/storage",
	"@mycli/integrations",
	"@mycli/runtime",
	"mycli-shell-tui",
	"@mycli/app",
];
const NATIVE_PTY_SMOKE = String.raw`
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import process from "node:process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { startNodePtyTransport } from "@mycli/tools";

const require = createRequire(import.meta.url);
const nodePtyPackage = require.resolve("node-pty/package.json");
if (process.platform === "darwin") {
	const helper = join(
		dirname(nodePtyPackage),
		"prebuilds",
		process.platform + "-" + process.arch,
		"spawn-helper",
	);
	assert.notEqual(statSync(helper).mode & 0o111, 0, "node-pty spawn-helper is not executable");
}

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
let output = "";
let exited = false;
transport.onOutput((chunk) => {
	output += typeof chunk.data === "string"
		? chunk.data
		: Buffer.from(chunk.data).toString("utf8");
});
const exit = new Promise((resolve) => transport.onExit(resolve)).then((value) => {
	exited = true;
	return value;
});
try {
	await transport.resize(40, 100);
	await transport.write(windows
		? "echo packed-pty-ready && exit 0\r\n"
		: "printf 'packed-pty-ready\\n'; exit 0\n");
	const result = await Promise.race([
		exit,
		new Promise((_, reject) => setTimeout(() => reject(new Error("packed PTY timed out")), 5_000)),
	]);
	assert.equal(result.exitCode, 0);
	assert.match(output, /packed-pty-ready/u);
} finally {
	if (!exited) await transport.terminate().catch(() => undefined);
	await transport.close();
}
process.stdout.write("native-pty-ok\n");
`;

const tempRoot = await mkdtemp(join(tmpdir(), "mycli-packed-cli-"));
try {
	const packDir = join(tempRoot, "packs");
	const installDir = join(tempRoot, "install");
	const cacheDir = join(tempRoot, "npm-cache");
	await mkdir(packDir);
	await mkdir(installDir);
	for (const workspace of WORKSPACES) {
		await run("npm", [
			"pack",
			"--workspace",
			workspace,
			"--pack-destination",
			packDir,
			"--cache",
			cacheDir,
			"--silent",
		], ROOT);
	}
	const tarballs = (await readdir(packDir))
		.filter((name) => name.endsWith(".tgz"))
		.map((name) => join(packDir, name));
	if (tarballs.length !== WORKSPACES.length) {
		throw new Error("packed_cli_smoke_failed: workspace tarball count mismatch");
	}
	await writeFile(join(installDir, "package.json"), JSON.stringify({ private: true }), "utf8");
	await run("npm", [
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--package-lock=false",
		"--cache",
		cacheDir,
		...tarballs,
	], installDir);
	const bin = process.platform === "win32"
		? join(installDir, "node_modules", ".bin", "mycli.cmd")
		: join(installDir, "node_modules", ".bin", "mycli");
	const help = await run(bin, ["--help"], installDir, true);
	if (!help.includes("--runtime-backend <backend>") || !help.includes("python-sidecar or node")) {
		throw new Error("packed_cli_smoke_failed: installed CLI help is incomplete");
	}
	const nativeSmoke = join(installDir, "native-pty-smoke.mjs");
	await writeFile(nativeSmoke, NATIVE_PTY_SMOKE, "utf8");
	const nativeOutput = await run(process.execPath, [nativeSmoke], installDir, true);
	if (!nativeOutput.includes("native-pty-ok")) {
		throw new Error("packed_cli_smoke_failed: installed native PTY smoke is incomplete");
	}
	process.stdout.write(`${JSON.stringify({ status: "completed", packed_workspaces: tarballs.length })}\n`);
} catch {
	process.stderr.write("packed_cli_smoke_failed\n");
	process.exitCode = 1;
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}

function run(command, args, cwd, capture = false) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
			shell: process.platform === "win32",
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve(stdout);
				return;
			}
			reject(new Error(`command_failed: ${command} (${code ?? "signal"}) ${stderr.slice(-512)}`));
		});
	});
}

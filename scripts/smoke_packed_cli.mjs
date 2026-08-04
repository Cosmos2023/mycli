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
	"@mycli/runtime",
	"mycli-shell-tui",
	"@mycli/app",
];

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

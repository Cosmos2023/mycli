#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
const M7_PACKAGE_SMOKE = String.raw`
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	HookAllowlistStore,
	McpClient,
	PluginProcessHost,
	SkillRegistry,
	SubagentController,
} from "@mycli/integrations";

assert.equal(typeof HookAllowlistStore, "function");
assert.equal(typeof McpClient, "function");
assert.equal(typeof PluginProcessHost, "function");
assert.equal(typeof SkillRegistry, "function");
assert.equal(typeof SubagentController, "function");
assert.ok(import.meta.resolve("@anthropic-ai/sdk"));
assert.ok(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
const integrationsEntry = fileURLToPath(import.meta.resolve("@mycli/integrations"));
const workerBootstrap = join(dirname(integrationsEntry), "plugins", "worker-bootstrap.js");
assert.equal(statSync(workerBootstrap).isFile(), true);
process.stdout.write("m7-package-ok\n");
`;

const tempRoot = await mkdtemp(join(tmpdir(), "mycli-packed-cli-"));
try {
	const packDir = join(tempRoot, "packs");
	const installDir = join(tempRoot, "install");
	const cacheDir = join(tempRoot, "npm-cache");
	await mkdir(packDir);
	await mkdir(installDir);
	for (const workspace of WORKSPACES) {
		const output = await run("npm", [
			"pack",
			"--json",
			"--workspace",
			workspace,
			"--pack-destination",
			packDir,
			"--cache",
			cacheDir,
			"--silent",
		], ROOT, true);
		assertPackFileList(JSON.parse(output));
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
	const pythonProbe = await createPythonProbe(tempRoot);
	const guardedEnv = {
		...process.env,
		PATH: `${pythonProbe.binDir}${delimiter}${process.env.PATH ?? dirname(process.execPath)}`,
		MYCLI_PYTHON_PROBE_MARKER: pythonProbe.marker,
	};
	await assertNoPythonRuntimeSurface(join(
		installDir,
		"node_modules",
		"@mycli",
		"app",
		"dist",
	));
	const bin = process.platform === "win32"
		? join(installDir, "node_modules", ".bin", "mycli.cmd")
		: join(installDir, "node_modules", ".bin", "mycli");
	const help = await run(bin, ["--help"], installDir, true, guardedEnv);
	if (help.includes("--runtime-backend") || help.includes("python-sidecar")) {
		throw new Error("packed_cli_smoke_failed: installed CLI still advertises Python runtime selection");
	}
	const nativeSmoke = join(installDir, "native-pty-smoke.mjs");
	await writeFile(nativeSmoke, NATIVE_PTY_SMOKE, "utf8");
	const nativeOutput = await run(process.execPath, [nativeSmoke], installDir, true);
	if (!nativeOutput.includes("native-pty-ok")) {
		throw new Error("packed_cli_smoke_failed: installed native PTY smoke is incomplete");
	}
	const m7PackageSmoke = join(installDir, "m7-package-smoke.mjs");
	await writeFile(m7PackageSmoke, M7_PACKAGE_SMOKE, "utf8");
	const m7PackageOutput = await run(process.execPath, [m7PackageSmoke], installDir, true);
	if (!m7PackageOutput.includes("m7-package-ok")) {
		throw new Error("packed_cli_smoke_failed: installed M7 assets are incomplete");
	}
	const packedHome = join(tempRoot, "home");
	const managementEnv = {
		...guardedEnv,
		HOME: packedHome,
		USERPROFILE: packedHome,
		MYCLI_API_KEY: "",
		MYCLI_AUTH_REF: "",
	};
	for (const [args, action] of [
		[["hooks", "list", "--json"], "list"],
		[["plugins", "list", "--json"], "list"],
		[["mcp", "list", "--json"], "list"],
		[["subagents", "list", "--json"], "list"],
		[["doctor", "--json"], "doctor"],
	]) {
		const output = await run(bin, args, installDir, true, managementEnv);
		const payload = JSON.parse(output);
		if (payload.action !== action || typeof payload.ok !== "boolean") {
			throw new Error("packed_cli_smoke_failed: compiled management command is incomplete");
		}
	}
	const m8RuntimeSmoke = join(installDir, "m8-runtime-smoke.mjs");
	const sourceSmoke = await readFile(join(ROOT, "scripts", "smoke_node_m8.mjs"), "utf8");
	const installedSmoke = sourceSmoke.replace(
		'../apps/mycli/dist/node-runtime/node-backend.js',
		'./node_modules/@mycli/app/dist/node-runtime/node-backend.js',
	);
	if (installedSmoke === sourceSmoke) {
		throw new Error("packed_cli_smoke_failed: M8 runtime smoke entry was not relocated");
	}
	await writeFile(m8RuntimeSmoke, installedSmoke, "utf8");
	const m8Output = await run(process.execPath, [m8RuntimeSmoke], installDir, true, managementEnv);
	const m8Summary = JSON.parse(m8Output);
	if (m8Summary.status !== "completed" || m8Summary.runtime !== "node") {
		throw new Error("packed_cli_smoke_failed: installed Node runtime smoke is incomplete");
	}
	if (existsSync(pythonProbe.marker)) {
		throw new Error("packed_cli_smoke_failed: installed CLI probed for Python");
	}
	process.stdout.write(`${JSON.stringify({ status: "completed", packed_workspaces: tarballs.length })}\n`);
} catch {
	process.stderr.write("packed_cli_smoke_failed\n");
	process.exitCode = 1;
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}

function assertPackFileList(output) {
	const entries = Array.isArray(output) ? output : [];
	const files = Array.isArray(entries[0]?.files) ? entries[0].files : [];
	if (entries.length !== 1 || files.length === 0) {
		throw new Error("packed_cli_smoke_failed: npm pack file inventory is unavailable");
	}
	for (const file of files) {
		const path = typeof file?.path === "string" ? file.path : "";
		if (/\.py$/u.test(path) || /python-sidecar|backend-router/u.test(path)) {
			throw new Error("packed_cli_smoke_failed: Python runtime file entered an npm artifact");
		}
	}
}

async function createPythonProbe(root) {
	const binDir = join(root, "python-probe-bin");
	const marker = join(root, "python-probed");
	await mkdir(binDir);
	if (process.platform === "win32") {
		const source = '@echo off\r\nbreak > "%MYCLI_PYTHON_PROBE_MARKER%"\r\nexit /b 97\r\n';
		await Promise.all(["python.cmd", "python3.cmd", "py.cmd"].map(
			(name) => writeFile(join(binDir, name), source, "utf8"),
		));
	} else {
		const source = '#!/bin/sh\n: > "$MYCLI_PYTHON_PROBE_MARKER"\nexit 97\n';
		const paths = ["python", "python3", "py"].map((name) => join(binDir, name));
		await Promise.all(paths.map((path) => writeFile(path, source, "utf8")));
		await Promise.all(paths.map((path) => chmod(path, 0o755)));
	}
	return { binDir, marker };
}

async function assertNoPythonRuntimeSurface(root) {
	const pending = [root];
	const forbidden = /python-sidecar|MYCLI_RUNTIME_BACKEND|MYCLI_PYTHON|startPythonSidecar|mycli\.cli\.sidecar|backend-router/u;
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
			} else if (entry.isFile() && entry.name.endsWith(".js")) {
				if (forbidden.test(await readFile(path, "utf8"))) {
					throw new Error("packed_cli_smoke_failed: app runtime contains a Python startup surface");
				}
			}
		}
	}
}

function run(command, args, cwd, capture = false, env = process.env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
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

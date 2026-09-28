import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	checkNodeVersion, cleanOutput, createInstallPlan, MIN_NODE_VERSION, PACKAGE_NAME, parseOptions,
	runCommand, shellQuote,
} from "../install.mjs";

const INSTALLER = fileURLToPath(new URL("../install.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const NPM_FIXTURE = `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('11.11.0'); process.exit(0); }
const prefix = args[args.indexOf('--prefix') + 1];
fs.writeFileSync(process.env.MYCLI_INSTALL_TEST_CALL, JSON.stringify(args));
const mode = process.env.MYCLI_INSTALL_TEST_MODE;
if (mode === 'fail') {
 console.error('npm error Authorization: Bearer private-install-sentinel');
 console.error('npm error EACCES: fixture installation failed');
 process.exit(13);
}
if (mode === 'wait') {
 const descendant = spawn(process.execPath, ['-e',
  'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);',
  process.env.MYCLI_INSTALL_TEST_PID], { stdio: 'ignore' });
 descendant.on('error', () => process.exit(1));
 const timer = setInterval(() => {
  if (fs.existsSync(process.env.MYCLI_INSTALL_TEST_PID)) {
   console.log('fixture installation ready'); clearInterval(timer);
  }
 }, 10);
 setInterval(() => {}, 1000);
} else {
 const dir = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', '@cosmos2023', 'mycli');
 fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
 fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@cosmos2023/mycli', version: '0.1.1', type: 'module' }));
 const entry = path.join(dir, 'dist', 'cli.js');
 const entryCode = mode === 'broken-runtime' ? 'throw new Error("fixture native module could not load");' : 'console.log("' + (mode === 'wrong-version' ? '0.1.0' : '0.1.1') + '");';
 fs.writeFileSync(entry, '#!/usr/bin/env node\\n' + entryCode + '\\n', { mode: 0o755 });
 const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
 fs.mkdirSync(binDir, { recursive: true });
 if (mode !== 'missing-bin') {
  if (process.platform === 'win32') {
   fs.writeFileSync(path.join(binDir, 'mycli.cmd'), '@node "%~dp0/node_modules/@cosmos2023/mycli/dist/cli.js" %*\\r\\n');
  } else {
   const link = path.join(binDir, 'mycli');
   try { fs.unlinkSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
   fs.symlinkSync(path.relative(binDir, entry), link);
  }
 }
 console.log('fixture dependencies installed');
}
`;

async function fixture(t, mode = "success") {
	const root = await mkdtemp(path.join(tmpdir(), "mycli-installer-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const npmCli = path.join(root, "npm-cli.js");
	await writeFile(npmCli, NPM_FIXTURE);
	// A semicolon is an ordinary character on POSIX but the PATH separator on
	// Windows, where no single PATH entry can contain one. Keep the rest of the
	// hostile characters on both hosts.
	const prefix = path.join(root, process.platform === "win32"
		? "prefix with spaces & $literal 'quote' (draft)"
		: "prefix with spaces & $literal; 'quote'");
	const cache = path.join(root, "cache");
	const plan = createInstallPlan(parseOptions(["--prefix", prefix, "--cache", cache]));
	const env = { ...process.env, npm_execpath: npmCli, NO_COLOR: "1",
		MYCLI_INSTALL_TEST_CALL: path.join(root, "npm-call.json"), MYCLI_INSTALL_TEST_MODE: mode,
		MYCLI_INSTALL_TEST_PID: path.join(root, "descendant.pid"),
		PATH: `${plan.binDir}${path.delimiter}${process.env.PATH}` };
	return { root, prefix, cache, plan, env };
}

function startInstaller(setup, args = []) {
	const child = spawn(process.execPath, [INSTALLER, "--prefix", setup.prefix, "--cache", setup.cache,
		"--plain", ...args], { env: setup.env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
	child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
	const completion = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("installer test timed out")); }, 15_000);
		child.once("error", (error) => { clearTimeout(timeout); reject(error); });
		child.once("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
	});
	return { child, completion };
}

test("standalone installer identity and minimum Node version match release manifests", async () => {
	const manifest = JSON.parse(await readFile(path.join(ROOT, "backend/apps/mycli/package.json"), "utf8"));
	assert.equal(PACKAGE_NAME, manifest.name);
	assert.equal(`>=${MIN_NODE_VERSION}`, manifest.engines.node);
	for (const version of ["22.19.0", "22.20.0", "24.0.0"]) checkNodeVersion(version);
	for (const version of ["20.19.0", "22.18.9", "22.0.0"]) {
		assert.throws(() => checkNodeVersion(version), /Install Node.js >= 22.19.0/u);
	}
});

test("installer rejects arbitrary package specs, unknown flags, and invalid directories", () => {
	for (const version of ["--force", "file:/tmp/package", "https://example.com/app.tgz", "1.0.0; id", "01.0.0"]) {
		assert.throws(() => parseOptions(["--version", version]));
	}
	assert.throws(() => parseOptions(["--force"]));
	assert.throws(() => parseOptions(["--prefix", ""]));
	assert.throws(() => parseOptions(["--cache", "line\nbreak"]));
	assert.equal(parseOptions(["--version", "0.2.0-beta.1"]).version, "0.2.0-beta.1");
});

test("installation plans use user directories and preserve literal paths on Unix and Windows", () => {
	const unix = createInstallPlan(parseOptions([]), { platform: "darwin", homeDir: "/home/test", cwd: "/work", env: {} });
	assert.equal(unix.prefix, "/home/test/.local");
	assert.equal(unix.cache, "/home/test/.cache/mycli/npm");
	assert.equal(unix.entry, "/home/test/.local/lib/node_modules/@cosmos2023/mycli/dist/cli.js");
	const windows = createInstallPlan(parseOptions(["--version", "next"]), {
		platform: "win32", homeDir: "C:\\Users\\Test User", cwd: "C:\\work", env: {},
	});
	assert.equal(windows.prefix, "C:\\Users\\Test User\\AppData\\Local\\mycli");
	assert.equal(windows.command, `${windows.prefix}\\mycli.cmd`);
	assert.equal(windows.entry, `${windows.prefix}\\node_modules\\@cosmos2023\\mycli\\dist\\cli.js`);
	assert.ok(windows.npmArgs.includes(`${PACKAGE_NAME}@next`));
	assert.ok(windows.npmArgs.includes("--include=optional"));
	assert.equal(windows.npmArgs.includes("--force"), false);
});

test("dry-run and help are independent of installation and do not create directories", async (t) => {
	const setup = await fixture(t);
	const dryRun = await startInstaller(setup, ["--dry-run"]).completion;
	assert.equal(dryRun.code, 0, dryRun.stderr);
	assert.match(dryRun.stdout, /no downloads or filesystem changes/u);
	assert.match(dryRun.stdout, /@cosmos2023\/mycli@latest/u);
	await assert.rejects(access(setup.prefix));
	await assert.rejects(access(setup.cache));
	await assert.rejects(access(setup.env.MYCLI_INSTALL_TEST_CALL));
	const help = await startInstaller(setup, ["--help"]).completion;
	assert.equal(help.code, 0, help.stderr);
	assert.match(help.stdout, /--verbose/u);
	await assert.rejects(access(setup.prefix));
});

test("fresh install reports stages, verifies the new binary, and safely updates the same prefix", async (t) => {
	const setup = await fixture(t);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const result = await startInstaller(setup, ["--version", "0.1.1"]).completion;
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stderr, /\[1\/3\] Checking environment/u);
		assert.match(result.stderr, /\[2\/3\] Downloading and installing OK/u);
		assert.match(result.stderr, /\[3\/3\] Verifying installed command OK/u);
		assert.match(result.stdout, /Installed mycli 0.1.1/u);
		assert.equal(result.stdout.includes("not on your PATH"), false);
		assert.equal(result.stdout.includes("PATH currently selects"), false);
		assert.equal(result.stderr.includes("fixture dependencies"), false);
		assert.equal(result.stderr.includes("\x1b"), false);
	}
	const args = JSON.parse(await readFile(setup.env.MYCLI_INSTALL_TEST_CALL, "utf8"));
	assert.equal(args[args.indexOf("--prefix") + 1], setup.prefix);
	assert.equal(args[args.indexOf("--cache") + 1], setup.cache);
	assert.ok(args.includes(`${PACKAGE_NAME}@0.1.1`));
	assert.equal((await readdir(setup.cache)).filter((name) => name.endsWith(".log")).length, 2);
});

test("verbose mode exposes dependency activity and failed installs retain redacted diagnostics", async (t) => {
	const setup = await fixture(t, "fail");
	const result = await startInstaller(setup).completion;
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Downloading and installing FAILED/u);
	assert.match(result.stderr, /EACCES: fixture installation failed/u);
	assert.match(result.stderr, /Installation log/u);
	assert.equal(result.stdout.includes("Installed mycli"), false);
	assert.equal(result.stderr.includes("[3/3]"), false);
	assert.equal(result.stderr.includes("private-install-sentinel"), false);
	const log = await readFile(path.join(setup.cache, (await readdir(setup.cache))[0]), "utf8");
	assert.match(log, /Authorization: \[redacted\]/u);
	assert.equal(log.includes("private-install-sentinel"), false);
	const verbose = await startInstaller({ ...setup, env: { ...setup.env, MYCLI_INSTALL_TEST_MODE: "success" } }, ["--verbose"]).completion;
	assert.equal(verbose.code, 0, verbose.stderr);
	assert.match(verbose.stderr, /fixture dependencies installed/u);
});

test("an existing unrelated launcher is preserved and npm installation never starts", async (t) => {
	const setup = await fixture(t);
	await mkdir(setup.plan.binDir, { recursive: true });
	if (process.platform === "win32") await writeFile(setup.plan.command, "old unrelated command");
	else await symlink("/missing/old/mycli", setup.plan.command);
	const result = await startInstaller(setup).completion;
	assert.equal(result.code, 1);
	assert.match(result.stderr, /Another command already exists/u);
	assert.equal(result.stderr.includes("[2/3]"), false);
	await assert.rejects(access(setup.env.MYCLI_INSTALL_TEST_CALL));
	assert.ok((await readdir(setup.plan.binDir)).includes(path.basename(setup.plan.command)));
});

test("verification failures never report success even if npm exits successfully", async (t) => {
	for (const mode of ["wrong-version", "missing-bin"]) {
		const setup = await fixture(t, mode);
		const result = await startInstaller(setup).completion;
		assert.equal(result.code, 1, result.stderr);
		assert.match(result.stderr, /Verifying installed command FAILED/u);
		assert.equal(result.stdout.includes("Installed mycli"), false);
	}
});

test("verification preserves the installed command's failure reason", async (t) => {
	const setup = await fixture(t, "broken-runtime");
	const result = await startInstaller(setup).completion;
	assert.equal(result.code, 1);
	assert.match(result.stderr, /fixture native module could not load/u);
	assert.equal(result.stdout.includes("Installed mycli"), false);
});

test("installer detects a shadowing command and prints properly quoted PATH guidance", async (t) => {
	const setup = await fixture(t);
	const oldBin = path.join(setup.root, "old-bin");
	await mkdir(oldBin);
	await writeFile(path.join(oldBin, process.platform === "win32" ? "mycli.cmd" : "mycli"), "old command\n", { mode: 0o755 });
	setup.env.PATH = `${oldBin}${path.delimiter}${setup.env.PATH}`;
	const result = await startInstaller(setup).completion;
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /PATH currently selects/u);
	assert.ok(result.stdout.includes(shellQuote(setup.plan.binDir + (process.platform === "win32" ? ";" : ""))));
	assert.equal(shellQuote("C:\\User's", "win32"), "'C:\\User''s'");
	assert.equal(shellQuote("/home/user's", "linux"), "'/home/user'\\''s'");
});

test("output removes terminal controls and common credential forms", () => {
	const clean = cleanOutput("\x1b[31merror\x1b[0m https://user:secret@registry.example/ npm_123456 Authorization: Bearer token-value");
	assert.equal(clean.includes("\x1b"), false);
	assert.equal(clean.includes("secret"), false);
	assert.equal(clean.includes("npm_123456"), false);
	assert.equal(clean.includes("token-value"), false);
});

test("command runner handles launch failure and bounded timeouts", async () => {
	await assert.rejects(runCommand("/nonexistent/mycli-installer-command", []), /ENOENT/u);
	await assert.rejects(runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 }), /timed out/u);
});

test("Ctrl+C cancels installation and kills a build descendant that ignores SIGTERM", {
	skip: process.platform === "win32" ? "POSIX signal and process-group assertion" : false,
}, async (t) => {
	const setup = await fixture(t, "wait");
	const { child, completion } = startInstaller(setup, ["--verbose"]);
	let descendant;
	t.after(() => {
		child.kill("SIGTERM");
		if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
	});
	await new Promise((resolve, reject) => {
		let output = "";
		const timeout = setTimeout(() => reject(new Error("fixture did not become ready")), 10_000);
		child.stderr.on("data", (data) => {
			output += data;
			if (output.includes("fixture installation ready")) { clearTimeout(timeout); resolve(); }
		});
	});
	descendant = Number(await readFile(setup.env.MYCLI_INSTALL_TEST_PID, "utf8"));
	child.kill("SIGINT");
	const result = await completion;
	assert.equal(result.code, 130, result.stderr);
	assert.match(result.stderr, /CANCELLED/u);
	assert.equal(result.stdout.includes("Installed mycli"), false);
	assert.equal(result.stderr.includes("[3/3]"), false);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
});

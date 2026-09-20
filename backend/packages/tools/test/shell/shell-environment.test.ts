import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createShellEnvironment } from "../../src/index.ts";

test("shell environment keeps core keys and replaces PWD with the canonical cwd", async (t) => {
	const cwd = await temporaryDirectory(t);
	const canonicalCwd = await realpath(cwd);

	const result = createShellEnvironment({
		cwd,
		homeDir: join(cwd, "isolated-home"),
		packageRoot: join(cwd, "isolated-package"),
		platformPackageRoot: null,
		platform: "linux",
		sourceEnv: {
			HOME: "/home/demo",
			LANG: "en_US.UTF-8",
			PATH: "/usr/bin",
			PWD: "/outside",
			CUSTOM: "drop-me",
		},
	});

	assert.deepEqual(result.env, {
		HOME: "/home/demo",
		LANG: "en_US.UTF-8",
		MYCLI_CI: "1",
		PATH: "/usr/bin",
		PWD: canonicalCwd,
	});
	assert.deepEqual(result.diagnostics, {
		policy: "sanitized",
		envKeys: ["HOME", "LANG", "MYCLI_CI", "PATH", "PWD"],
		removedCount: 1,
	});
});

test("Windows shell environment pins UTF-8 instead of the console code page", async (t) => {
	const cwd = await temporaryDirectory(t);
	const result = createShellEnvironment({
		cwd,
		homeDir: join(cwd, "isolated-home"),
		platformPackageRoot: null,
		platform: "win32",
		sourceEnv: {
			LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
			PATH: "C:\\Windows\\System32",
			USERPROFILE: "C:\\Users\\demo",
		},
	});

	assert.equal(result.env.PYTHONUTF8, "1");
	assert.equal(result.env.PYTHONIOENCODING, "utf-8");
	assert.equal(result.env.LOCALAPPDATA, "C:\\Users\\demo\\AppData\\Local");
	assert.equal(result.diagnostics.envKeys.includes("PYTHONUTF8"), true);
});

test("Windows shell environment fills runtime essentials a partial source omits", async (t) => {
	const cwd = await temporaryDirectory(t);
	const result = createShellEnvironment({
		cwd,
		homeDir: join(cwd, "isolated-home"),
		platformPackageRoot: null,
		platform: "win32",
		sourceEnv: { PATH: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\demo" },
	});

	// PowerShell cannot launch native programs without PATHEXT, and programs that
	// toggle the console code page need SystemRoot to load their message tables.
	assert.equal(result.env.PATHEXT, process.env.PATHEXT);
	assert.equal(result.env.SYSTEMROOT, process.env.SystemRoot);
	assert.equal(result.env.COMSPEC, process.env.ComSpec ?? result.env.COMSPEC);
	assert.equal(result.env.WINDIR, process.env.WINDIR);
});

test("shell environment removes secret-like names without exposing their values", async (t) => {
	const cwd = await temporaryDirectory(t);
	const secrets = ["key-value-123", "secret-value-456", "token-value-789"];

	const result = createShellEnvironment({
		cwd,
		homeDir: join(cwd, "isolated-home"),
		packageRoot: join(cwd, "isolated-package"),
		platformPackageRoot: null,
		platform: "linux",
		sourceEnv: {
			PATH: "/usr/bin",
			API_KEY: secrets[0],
			CLIENT_SECRET: secrets[1],
			MYCLI_TOKEN: secrets[2],
		},
	});

	assert.deepEqual(result.env, {
		MYCLI_CI: "1",
		PATH: "/usr/bin",
		PWD: await realpath(cwd),
	});
	assert.equal(result.diagnostics.removedCount, 3);
	const diagnostics = JSON.stringify(result.diagnostics);
	for (const secret of secrets) assert.equal(diagnostics.includes(secret), false);
});

test("shell environment accepts a Windows Path key and injects rg.exe with its marker", async (t) => {
	const cwd = await temporaryDirectory(t);
	const homeDir = join(cwd, "home");
	const directory = join(homeDir, ".mycli", "vendor", "ripgrep", "windows-x86_64");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "rg.exe"), "test", "utf8");

	const result = createShellEnvironment({
		cwd,
		homeDir,
		packageRoot: join(cwd, "isolated-package"),
		platform: "win32",
		platformPackageRoot: null,
		architecture: "x64",
		sourceEnv: {
			Path: "C:\\Windows\\System32",
			USERPROFILE: homeDir,
			LOCALAPPDATA: join(homeDir, "AppData", "Local"),
		},
	});

	assert.equal(result.env.PATH, `${directory};C:\\Windows\\System32`);
	assert.equal(result.env.MYCLI_RIPGREP_PATH_DIR, directory);
	assert.equal(result.env.LOCALAPPDATA, join(homeDir, "AppData", "Local"));
});

async function temporaryDirectory(t: test.TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mycli-shell-environment-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => (
		rm(directory, { recursive: true, force: true })
	)));
	return directory;
}

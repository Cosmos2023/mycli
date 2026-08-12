import assert from "node:assert/strict";
import test from "node:test";
import { resolveShellProfile } from "../src/index.ts";

test("resolves POSIX commands through login command argv", () => {
	const profile = resolveShellProfile({
		platform: "linux",
		shellPath: "/bin/zsh",
	});

	assert.equal(profile.kind, "posix");
	assert.equal(profile.name, "zsh");
	assert.equal(profile.executable, "/bin/zsh");
	assert.deepEqual(profile.execArgv("npm test"), ["-lc", "npm test"]);
});

test("resolves PowerShell and CMD command argv without a shell wrapper", () => {
	const powershell = resolveShellProfile({
		platform: "win32",
		shellPath: String.raw`C:\Program Files\PowerShell\7\pwsh.exe`,
	});
	const cmd = resolveShellProfile({
		platform: "win32",
		shellPath: String.raw`C:\Windows\System32\cmd.exe`,
	});

	assert.equal(powershell.kind, "powershell");
	assert.equal(powershell.name, "powershell");
	assert.deepEqual(powershell.execArgv("npm test"), [
		"-NoLogo",
		"-NoProfile",
		"-Command",
		"npm test",
	]);
	assert.equal(cmd.kind, "cmd");
	assert.equal(cmd.name, "cmd");
	assert.deepEqual(cmd.execArgv("npm test"), ["/d", "/s", "/c", "npm test"]);
});

test("uses the active environment shell when no explicit path is configured", () => {
	const posix = resolveShellProfile({
		platform: "darwin",
		env: { SHELL: "/bin/bash" },
	});
	const windows = resolveShellProfile({
		platform: "win32",
		env: { ComSpec: String.raw`C:\Windows\System32\cmd.exe` },
	});

	assert.equal(posix.executable, "/bin/bash");
	assert.equal(posix.name, "bash");
	assert.equal(windows.executable, String.raw`C:\Windows\System32\cmd.exe`);
	assert.equal(windows.name, "cmd");
});

test("does not expose an unrecognized executable name as a shell contract", () => {
	const profile = resolveShellProfile({
		platform: "linux",
		shellPath: "/usr/local/bin/fish",
	});

	assert.equal(profile.kind, "posix");
	assert.equal(profile.name, "posix");
});

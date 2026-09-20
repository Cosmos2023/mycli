import assert from "node:assert/strict";
import test from "node:test";
import { resolveShellProfile, SHELL_PATH_ENV_KEY } from "../../src/index.ts";
import { windowsCmdVerbatimArguments } from "../../src/shell/shell-profile.ts";

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
		pathExists: () => true,
	});
	const cmd = resolveShellProfile({
		platform: "win32",
		shellPath: String.raw`C:\Windows\System32\cmd.exe`,
	});

	assert.equal(powershell.kind, "powershell");
	assert.equal(powershell.name, "powershell");
	assert.equal(powershell.dialect, "powershell-7");
	assert.deepEqual(powershell.execArgv("npm test"), [
		"-NoLogo",
		"-NoProfile",
		"-Command",
		"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
			+ "$OutputEncoding=[System.Text.Encoding]::UTF8;npm test",
	]);
	assert.equal(cmd.kind, "cmd");
	assert.equal(cmd.name, "cmd");
	assert.equal(cmd.dialect, "cmd");
	assert.deepEqual(cmd.execArgv("npm test"), ["/d", "/s", "/c", "chcp 65001>nul & npm test"]);
});

test("prefers PowerShell on Windows and keeps CMD as the last resort", () => {
	const windowsPowerShell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
	const detected = resolveShellProfile({
		platform: "win32",
		env: { PATH: String.raw`C:\tools`, ComSpec: String.raw`C:\Windows\System32\cmd.exe` },
		findExecutable: (name) => name === "powershell.exe" ? windowsPowerShell : undefined,
	});
	const pwsh7 = resolveShellProfile({
		platform: "win32",
		env: {},
		findExecutable: (name) => name === "pwsh.exe" ? String.raw`C:\Program Files\PowerShell\7\pwsh.exe` : undefined,
	});
	const fallback = resolveShellProfile({
		platform: "win32",
		env: { ComSpec: String.raw`C:\Windows\System32\cmd.exe` },
		findExecutable: () => undefined,
	});

	assert.equal(detected.executable, windowsPowerShell);
	assert.equal(detected.name, "powershell");
	assert.equal(detected.dialect, "windows-powershell-5.1");
	assert.equal(pwsh7.dialect, "powershell-7");
	assert.equal(fallback.executable, String.raw`C:\Windows\System32\cmd.exe`);
	assert.equal(fallback.name, "cmd");
	assert.equal(fallback.dialect, "cmd");
});

test("honors the documented shell override and ignores a broken explicit path", () => {
	const override = resolveShellProfile({
		platform: "win32",
		env: { [SHELL_PATH_ENV_KEY]: String.raw`C:\tools\pwsh.exe` },
		pathExists: () => true,
		findExecutable: () => String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
	});
	const ignored = resolveShellProfile({
		platform: "win32",
		env: {
			[SHELL_PATH_ENV_KEY]: String.raw`C:\missing\pwsh.exe`,
			ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
		},
		pathExists: () => false,
		findExecutable: () => undefined,
	});
	const bare = resolveShellProfile({
		platform: "win32",
		env: { [SHELL_PATH_ENV_KEY]: "pwsh" },
		findExecutable: (name) => name === "pwsh" ? String.raw`C:\tools\pwsh.exe` : undefined,
	});
	const suffixlessDetection = resolveShellProfile({
		platform: "win32",
		env: { PATH: String.raw`C:\tools` },
		pathExists: (candidate) => candidate.toLowerCase() === String.raw`C:\tools\pwsh.exe`.toLowerCase(),
	});

	assert.equal(override.executable, String.raw`C:\tools\pwsh.exe`);
	assert.equal(override.dialect, "powershell-7");
	assert.equal(ignored.name, "cmd");
	assert.equal(bare.executable, String.raw`C:\tools\pwsh.exe`);
	assert.equal(bare.dialect, "powershell-7");
	assert.equal(suffixlessDetection.executable, String.raw`C:\tools\pwsh.exe`);
});

test("uses the active environment shell when no explicit path is configured", () => {
	const posix = resolveShellProfile({
		platform: "darwin",
		env: { SHELL: "/bin/bash" },
	});
	const windows = resolveShellProfile({
		platform: "win32",
		env: { ComSpec: String.raw`C:\Windows\System32\cmd.exe` },
		findExecutable: () => undefined,
	});

	assert.equal(posix.executable, "/bin/bash");
	assert.equal(posix.name, "bash");
	assert.equal(posix.dialect, "posix-sh");
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

test("only canonical cmd command requests use verbatim shell text", () => {
	const command = '"C:\\Program Files\\node.exe" script.cjs "quoted & value"';
	const args = ["/D", "/S", "/C", command];
	assert.deepEqual(windowsCmdVerbatimArguments("C:\\Windows\\cmd.exe", args),
		["/D", "/S", "/C", `"${command}"`]);
	for (const executable of ["powershell.exe", "node.exe", "helper.exe"]) {
		assert.equal(windowsCmdVerbatimArguments(executable, args), undefined);
	}
	for (const unsupported of [["/q"], ["/c", command], [...args, "extra"]]) {
		assert.equal(windowsCmdVerbatimArguments("cmd.exe", unsupported), undefined);
	}
});

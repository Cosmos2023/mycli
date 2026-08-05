import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyShellCommand,
	parseShellArgv,
	parseShellCommand,
} from "../src/index.ts";

test("parses plain POSIX control operators and tracks a leading cd chain", () => {
	const parsed = parseShellCommand("cd src && cat app.py | head -n 20", {
		shellKind: "posix",
	});

	assert.equal(parsed.kind, "plain");
	assert.deepEqual(parsed.kind === "plain" ? parsed.segments : [], [
		{ words: ["cd", "src"], operatorBefore: null, effectiveCwd: null },
		{ words: ["cat", "app.py"], operatorBefore: "&&", effectiveCwd: "src" },
		{ words: ["head", "-n", "20"], operatorBefore: "|", effectiveCwd: "src" },
	]);
	assert.deepEqual(parseShellArgv(["echo", "a>b", "x&&y"], {
		shellKind: "posix",
	}), {
		kind: "plain",
		segments: [{ words: ["echo", "a>b", "x&&y"], operatorBefore: null, effectiveCwd: null }],
	});
});

test("marks dynamic, malformed, and unsupported POSIX syntax closed", () => {
	for (const [command, kind, reason] of [
		["echo hello > out.txt", "complex", "redirection"],
		["cat $(resolve-path)", "complex", "expansion"],
		["NAME=value command", "complex", "assignment"],
		["cat *.py", "complex", "wildcard"],
		["sleep 1 &", "complex", "background"],
		["echo 'unterminated", "invalid", "malformed quoting"],
		["cat README.md &&", "invalid", "empty command segment"],
	] as const) {
		const parsed = parseShellCommand(command, { shellKind: "posix" });
		assert.equal(parsed.kind, kind, command);
		assert.equal(parsed.reason, reason, command);
	}
});

test("classifies known-safe POSIX commands and wrappers without widening mutating forms", () => {
	for (const command of [
		"cat README.md",
		"rg -n approval src | head -n 20",
		"false || git status --short",
		"pwd; ls -la",
		"sed -n 10,20p app.py",
		"find src -name '*.py'",
		"bash -lc 'cd src && git diff --stat'",
		"git branch --list 'feature/*'",
	]) {
		assert.equal(classifyShellCommand(command, { shellKind: "posix" }).decision, "safe", command);
	}
	for (const command of [
		"python script.py",
		"npm install",
		"base64 -o output.txt input.txt",
		"find . -delete",
		"rg --pre processor pattern",
		"sed -i s/a/b/ file.txt",
		"git branch feature/new",
		"git diff --output=changes.patch",
	]) {
		assert.notEqual(classifyShellCommand(command, { shellKind: "posix" }).decision, "safe", command);
	}
	const composite = classifyShellCommand("cat README.md && python script.py", {
		shellKind: "posix",
	});
	assert.equal(composite.decision, "unknown");
	assert.deepEqual(composite.commandPattern, ["python", "script.py"]);
});

test("parses and classifies PowerShell and CMD with shell-specific escaping", () => {
	for (const command of [
		"Get-ChildItem -Force | Select-Object Name",
		"Get-Content README.md | Measure-Object -Line",
		"Get-Location; git status --short",
	]) {
		assert.equal(classifyShellCommand(command, { shellKind: "powershell" }).decision, "safe", command);
	}
	for (const command of [
		"$env:TEMP",
		"Get-Date > date.txt",
		"Get-ChildItem | Where-Object { $_.Length -gt 0 }",
	]) {
		assert.notEqual(classifyShellCommand(command, { shellKind: "powershell" }).decision, "safe", command);
	}
	assert.equal(classifyShellCommand("cd src && dir | findstr py", {
		shellKind: "cmd",
	}).decision, "safe");
	for (const command of ["echo %PATH%", "dir > files.txt", "dir & del /q output.txt"]) {
		assert.notEqual(classifyShellCommand(command, { shellKind: "cmd" }).decision, "safe", command);
	}
});

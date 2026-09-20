import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyShellCommand,
	parseShellArgv,
	parseShellCommand,
} from "../../src/index.ts";

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

test("keeps Git reads safe only for non-executing options and workspace-confined -C", () => {
	const options = { shellKind: "posix" as const, workspaceRoot: "/workspace" };
	for (const command of [
		"git --no-pager status --short",
		"git -C nested status",
		"git -C nested -C .. status",
		"git branch --list 'feature/*'",
	]) {
		assert.equal(classifyShellCommand(command, options).decision, "safe", command);
	}
	for (const command of [
		"git -C ../outside status",
		"git -c core.pager=cat status",
		"git --paginate status",
		"git --git-dir=.git status",
		"git log --exec=touch",
		"git diff --textconv",
	]) {
		assert.notEqual(classifyShellCommand(command, options).decision, "safe", command);
	}
});

test("classifies Codex force-delete POSIX forms as dangerous", () => {
	for (const command of ["rm -f output.txt", "rm -rf build", "sudo rm -rf /"]) {
		assert.equal(classifyShellCommand(command, { shellKind: "posix" }).decision, "dangerous", command);
	}
	assert.equal(classifyShellCommand("rm output.txt", { shellKind: "posix" }).decision, "unknown");
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
	// PowerShell needs the call operator before a quoted executable path; that is
	// a plain invocation, while a bare operator is still unreviewable syntax.
	const invoked = classifyShellCommand(
		'& "C:\\Program Files\\nodejs\\node.exe" script.cjs',
		{ shellKind: "powershell" },
	);
	assert.equal(invoked.decision, "unknown");
	assert.deepEqual(invoked.segments[0]?.words,
		["C:\\Program Files\\nodejs\\node.exe", "script.cjs"]);
	assert.notEqual(classifyShellCommand("&", { shellKind: "powershell" }).decision, "unknown");
	for (const command of ["echo %PATH%", "dir > files.txt", "dir & del /q output.txt"]) {
		assert.notEqual(classifyShellCommand(command, { shellKind: "cmd" }).decision, "safe", command);
	}
});

test("classifies Windows aliases nested mutation force deletion and GUI launches", () => {
	for (const command of [
		"gci -Force | select Name",
		"gc README.md | measure -Line",
		"gc README.md | sort-object",
		"rvpa .",
	]) {
		assert.equal(classifyShellCommand(command, { shellKind: "powershell" }).decision, "safe", command);
	}
	assert.notEqual(classifyShellCommand(
		"Write-Output (Set-Content notes.txt data)",
		{ shellKind: "powershell" },
	).decision, "safe");
	assert.notEqual(classifyShellCommand(
		"sort-object README.md",
		{ shellKind: "powershell" },
	).decision, "safe");
	for (const command of [
		"Remove-Item notes.txt -Force",
		"Start-Process https://example.com",
		"explorer.exe https://example.com",
		"rundll32.exe url.dll,FileProtocolHandler https://example.com",
	]) {
		assert.equal(classifyShellCommand(command, { shellKind: "powershell" }).decision, "dangerous", command);
	}
	for (const command of [
		"del /f notes.txt",
		"rmdir /s /q build",
		"start https://example.com",
		"msedge.exe https://example.com",
	]) {
		assert.equal(classifyShellCommand(command, { shellKind: "cmd" }).decision, "dangerous", command);
	}
});

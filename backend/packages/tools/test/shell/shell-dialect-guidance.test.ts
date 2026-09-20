import assert from "node:assert/strict";
import test from "node:test";
import { shellDialectGuidance } from "../../src/index.ts";

test("POSIX guidance keeps shell-native pipelines and heredocs", () => {
	const guidance = shellDialectGuidance("posix-sh");

	assert.match(guidance, /POSIX shell syntax/u);
	assert.match(guidance, /heredocs are available/u);
	assert.equal(guidance.includes("chcp"), false);
});

test("Windows guidance states the dialect limits and the pinned encoding", () => {
	const windowsPowerShell = shellDialectGuidance("windows-powershell-5.1");
	const pwsh7 = shellDialectGuidance("powershell-7");
	const cmd = shellDialectGuidance("cmd");

	assert.match(windowsPowerShell, /`&&`\/`\|\|` require PowerShell 7/u);
	assert.match(windowsPowerShell, /`\$env:NAME`/u);
	assert.match(pwsh7, /PowerShell 7 syntax/u);
	assert.match(cmd, /`%NAME%`/u);
	assert.match(cmd, /no heredocs/u);
	for (const guidance of [windowsPowerShell, pwsh7, cmd]) {
		assert.match(guidance, /never run `chcp` or set console encodings/u);
	}
});

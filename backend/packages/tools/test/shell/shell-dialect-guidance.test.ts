import assert from "node:assert/strict";
import test from "node:test";
import { shellDialectFact, shellToolGuidance } from "../../src/index.ts";

test("environment facts describe the dialect without stating command rules", () => {
	for (const dialect of ["posix-sh", "powershell-7", "windows-powershell-5.1", "cmd"] as const) {
		const fact = shellDialectFact(dialect);

		assert.match(fact, /syntax/u);
		assert.equal(fact.includes("\n"), false);
		assert.equal(fact.includes("never run `chcp`"), false);
		assert.equal(fact.includes("Windows safety rules"), false);
		assert.equal(fact.includes("BSD userland"), false);
	}
});

test("POSIX tool guidance keeps shell-native pipelines and heredocs", () => {
	const guidance = shellToolGuidance("posix-sh");

	assert.match(guidance, /POSIX shell syntax/u);
	assert.match(guidance, /heredocs are available/u);
	assert.equal(guidance.includes("chcp"), false);
	assert.equal(guidance.includes("BSD userland"), false);
});

test("macOS adds BSD userland caveats to the POSIX tool guidance only", () => {
	const macOS = shellToolGuidance("posix-sh", { platform: "darwin" });
	const linux = shellToolGuidance("posix-sh", { platform: "linux" });
	const macOSPowerShell = shellToolGuidance("powershell-7", { platform: "darwin" });

	assert.match(macOS, /BSD userland/u);
	assert.match(macOS, /`sed -i` needs an explicit suffix/u);
	assert.match(macOS, /`date -d`, `readlink -f`, `stat -c`, `xargs -r`/u);
	assert.equal(linux.includes("BSD userland"), false);
	assert.equal(macOSPowerShell.includes("BSD userland"), false);
});

test("Windows tool guidance states dialect limits, encoding, and safety rules", () => {
	const windowsPowerShell = shellToolGuidance("windows-powershell-5.1");
	const pwsh7 = shellToolGuidance("powershell-7");
	const cmd = shellToolGuidance("cmd");

	assert.match(windowsPowerShell, /`&&`\/`\|\|` require PowerShell 7/u);
	assert.match(windowsPowerShell, /`\$env:NAME`/u);
	assert.match(pwsh7, /PowerShell 7 syntax/u);
	assert.match(cmd, /`%NAME%`/u);
	assert.match(cmd, /no heredocs/u);
	assert.match(cmd, /for a bounded file window use `rg -n -A\/-B` or a short Node script/u);
	for (const guidance of [windowsPowerShell, pwsh7, cmd]) {
		assert.match(guidance, /never run `chcp` or set console encodings/u);
		assert.match(guidance, /Windows safety rules:/u);
		assert.match(guidance, /use one shell end-to-end/iu);
		assert.match(guidance, /verify the resolved absolute target paths/u);
		assert.match(guidance, /`-WindowStyle Hidden`/u);
	}
});

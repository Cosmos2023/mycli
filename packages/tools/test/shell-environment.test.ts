import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createShellEnvironment } from "../src/index.ts";

test("shell environment keeps core keys and replaces PWD with the canonical cwd", async (t) => {
	const cwd = await temporaryDirectory(t);
	const canonicalCwd = await realpath(cwd);

	const result = createShellEnvironment({
		cwd,
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

test("shell environment removes secret-like names without exposing their values", async (t) => {
	const cwd = await temporaryDirectory(t);
	const secrets = ["key-value-123", "secret-value-456", "token-value-789"];

	const result = createShellEnvironment({
		cwd,
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

async function temporaryDirectory(t: test.TestContext): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mycli-shell-environment-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => (
		rm(directory, { recursive: true, force: true })
	)));
	return directory;
}

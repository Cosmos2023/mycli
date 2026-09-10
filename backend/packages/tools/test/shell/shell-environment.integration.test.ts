import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createShellEnvironment, ripgrepOutputPath, ripgrepPlatformKey } from "../../src/index.ts";

test("a real managed child shell resolves the user-vendored ripgrep", {
	skip: process.platform === "win32" ? "POSIX child-shell assertion" : false,
}, async (t) => {
	const root = await temporaryDirectory(t);
	const homeDir = join(root, "home");
	const binary = ripgrepOutputPath(
		join(homeDir, ".mycli", "vendor", "ripgrep"),
		ripgrepPlatformKey(),
	);
	await mkdir(dirname(binary), { recursive: true });
	await writeFile(binary, [
		"#!/bin/sh",
		"printf 'ripgrep-node-test marker=%s' \"$MYCLI_RIPGREP_PATH_DIR\"",
	].join("\n"), "utf8");
	await chmod(binary, 0o755);

	const environment = createShellEnvironment({
		cwd: root,
		homeDir,
		packageRoot: join(root, "package"),
		platformPackageRoot: null,
		sourceEnv: { HOME: homeDir, PATH: "/usr/bin:/bin" },
	});
	const result = spawnSync("/bin/sh", ["-c", "rg --version"], {
		cwd: root,
		env: environment.env,
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, `ripgrep-node-test marker=${dirname(binary)}`);
	assert.equal(environment.env.MYCLI_RIPGREP_PATH_DIR, dirname(binary));
});

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-shell-ripgrep-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

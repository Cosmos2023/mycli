import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

test("gateway slash commands retain UI state and refresh live command and session catalogs", { timeout: 20_000 }, async () => {
	const result = await promisify(execFile)(process.execPath, [
		"--conditions=mycli-source", "--import", "tsx", "--experimental-test-module-mocks",
		fileURLToPath(new URL("../fixtures/slash-command-gateway.ts", import.meta.url)),
	], { timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, MYCLI_TUI_NATIVE: "0" } });
	assert.match(result.stdout, /slash-command-gateway: passed/);
});

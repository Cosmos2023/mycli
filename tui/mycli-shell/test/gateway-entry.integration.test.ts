import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

test("public gateway entry exposes startup failure and closes its configured transport", { timeout: 20_000 }, async () => {
	const result = await promisify(execFile)(process.execPath, [
		"--conditions=mycli-source", "--import", "tsx", "--experimental-test-module-mocks",
		fileURLToPath(new URL("./fixtures/gateway-entry-failure.ts", import.meta.url)),
	], { timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env } });
	assert.match(result.stdout, /gateway-entry-failure: passed/);
});

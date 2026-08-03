import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readApiKey } from "../src/index.ts";

test("auth store reads a trimmed API key by auth_ref", async (t) => {
	const root = await temporaryDirectory(t);
	await mkdir(join(root, ".mycli"), { recursive: true });
	await writeFile(join(root, ".mycli", "auth.json"), JSON.stringify({
		"openai-primary": { type: "api_key", key: "  secret-value  " },
	}), "utf8");

	assert.equal(await readApiKey({ homeDir: root, authRef: "openai-primary" }), "secret-value");
});

test("malformed auth JSON behaves as an empty store", async (t) => {
	const root = await temporaryDirectory(t);
	await mkdir(join(root, ".mycli"), { recursive: true });
	await writeFile(join(root, ".mycli", "auth.json"), "{not-json", "utf8");

	assert.equal(await readApiKey({ homeDir: root, authRef: "openai" }), undefined);
});

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-config-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

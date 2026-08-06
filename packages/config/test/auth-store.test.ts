import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as config from "../src/index.ts";

const { readApiKey } = config;

type WriteApiKey = (input: {
	readonly homeDir: string;
	readonly authRef: string;
	readonly apiKey: string;
	readonly failpoint?: (name: string) => void;
}) => Promise<void>;

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

test("auth writer merges credentials, replaces the target, and hardens the file", async (t) => {
	const root = await temporaryDirectory(t);
	const directory = join(root, ".mycli");
	const path = join(directory, "auth.json");
	await mkdir(directory, { recursive: true });
	await writeFile(path, JSON.stringify({
		openai: { type: "api_key", key: "old-key" },
		anthropic: { type: "api_key", key: "keep-key" },
	}), { encoding: "utf8", mode: 0o644 });
	const writeApiKey = (config as { writeApiKey?: WriteApiKey }).writeApiKey;

	assert.equal(typeof writeApiKey, "function");
	await writeApiKey?.({ homeDir: root, authRef: "openai", apiKey: "  new-key  " });

	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		anthropic: { type: "api_key", key: "keep-key" },
		openai: { type: "api_key", key: "new-key" },
	});
	if (process.platform !== "win32") {
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(directory)).mode & 0o777, 0o700);
	}
	assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("auth writer preserves old data and redacts failures before atomic rename", async (t) => {
	const root = await temporaryDirectory(t);
	const directory = join(root, ".mycli");
	const path = join(directory, "auth.json");
	const oldContent = '{"openai":{"type":"api_key","key":"old-key"}}\n';
	await mkdir(directory, { recursive: true });
	await writeFile(path, oldContent, "utf8");
	const writeApiKey = (config as { writeApiKey?: WriteApiKey }).writeApiKey;

	assert.equal(typeof writeApiKey, "function");
	await assert.rejects(
		() => writeApiKey!({
			homeDir: root,
			authRef: "openai",
			apiKey: "sk-private-secret-value",
			failpoint: () => { throw new Error("sk-private-secret-value"); },
		}),
		(error: unknown) => error instanceof Error
			&& error.message === "auth_write_failed: unable to update credentials"
			&& !error.message.includes("private-secret-value"),
	);
	assert.equal(await readFile(path, "utf8"), oldContent);
	assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});

test("auth writer rejects blank credential fields", async (t) => {
	const root = await temporaryDirectory(t);
	const writeApiKey = (config as { writeApiKey?: WriteApiKey }).writeApiKey;

	assert.equal(typeof writeApiKey, "function");
	await assert.rejects(
		() => writeApiKey!({ homeDir: root, authRef: " ", apiKey: "secret" }),
		/auth_write_failed: authRef and apiKey must be non-empty/,
	);
});

test("concurrent auth writers serialize their merges", async (t) => {
	const root = await temporaryDirectory(t);
	const writeApiKey = (config as { writeApiKey?: WriteApiKey }).writeApiKey;
	assert.equal(typeof writeApiKey, "function");

	await Promise.all([
		writeApiKey!({ homeDir: root, authRef: "openai", apiKey: "openai-key" }),
		writeApiKey!({ homeDir: root, authRef: "anthropic", apiKey: "anthropic-key" }),
	]);

	assert.deepEqual(JSON.parse(await readFile(join(root, ".mycli", "auth.json"), "utf8")), {
		anthropic: { type: "api_key", key: "anthropic-key" },
		openai: { type: "api_key", key: "openai-key" },
	});
});

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-config-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

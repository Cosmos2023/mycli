import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as config from "../../src/index.ts";

const { deleteApiKey, inspectApiKey, readApiKey } = config;

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
	assert.deepEqual(await inspectApiKey({ homeDir: root, authRef: "openai" }), {
		authRef: "openai",
		configured: false,
		storeState: "malformed",
	});
});

test("auth status distinguishes missing, valid absent, and configured references", async (t) => {
	const root = await temporaryDirectory(t);
	assert.deepEqual(await inspectApiKey({ homeDir: root, authRef: "openai" }), {
		authRef: "openai",
		configured: false,
		storeState: "missing",
	});
	await mkdir(join(root, ".mycli"), { recursive: true });
	await writeFile(join(root, ".mycli", "auth.json"), JSON.stringify({
		anthropic: { type: "api_key", key: "stored" },
	}), "utf8");
	assert.deepEqual(await inspectApiKey({ homeDir: root, authRef: "openai" }), {
		authRef: "openai",
		configured: false,
		storeState: "valid",
	});
	assert.deepEqual(await inspectApiKey({ homeDir: root, authRef: "anthropic" }), {
		authRef: "anthropic",
		configured: true,
		storeState: "valid",
	});
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

test("auth writer preserves malformed store bytes instead of replacing unrelated data", async (t) => {
	const root = await temporaryDirectory(t);
	const directory = join(root, ".mycli");
	const path = join(directory, "auth.json");
	const malformed = "{private-malformed-sentinel";
	await mkdir(directory, { recursive: true });
	await writeFile(path, malformed, "utf8");

	await assert.rejects(
		() => config.writeApiKey({ homeDir: root, authRef: "openai", apiKey: "new-key" }),
		(error: unknown) => error instanceof Error
			&& error.message === "auth_write_failed: unable to update credentials"
			&& !error.message.includes("private-malformed-sentinel"),
	);
	assert.equal(await readFile(path, "utf8"), malformed);
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

test("auth deletion preserves unrelated references and removes an empty store", async (t) => {
	const root = await temporaryDirectory(t);
	const directory = join(root, ".mycli");
	const path = join(directory, "auth.json");
	await mkdir(directory, { recursive: true });
	await writeFile(path, JSON.stringify({
		openai: { type: "api_key", key: "remove-key" },
		anthropic: { type: "api_key", key: "keep-key" },
	}), "utf8");

	assert.equal(await deleteApiKey({ homeDir: root, authRef: "openai" }), true);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		anthropic: { type: "api_key", key: "keep-key" },
	});
	assert.equal(await deleteApiKey({ homeDir: root, authRef: "anthropic" }), true);
	await assert.rejects(access(path));
});

test("auth deletion is a no-op for a fresh home and preserves malformed bytes", async (t) => {
	const root = await temporaryDirectory(t);
	assert.equal(await deleteApiKey({ homeDir: root, authRef: "openai" }), false);
	await assert.rejects(access(join(root, ".mycli")));

	const directory = join(root, ".mycli");
	const path = join(directory, "auth.json");
	const malformed = "{private-delete-sentinel";
	await mkdir(directory, { recursive: true });
	await writeFile(path, malformed, "utf8");
	await assert.rejects(
		() => deleteApiKey({ homeDir: root, authRef: "openai" }),
		(error: unknown) => error instanceof Error
			&& error.message === "auth_delete_failed: unable to update credentials"
			&& !error.message.includes("private-delete-sentinel"),
	);
	assert.equal(await readFile(path, "utf8"), malformed);
});

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-config-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

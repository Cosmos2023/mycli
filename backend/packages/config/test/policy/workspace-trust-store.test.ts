import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type TrustState = "trusted" | "untrusted" | "unknown";

type TrustStore = {
	load(workspaceRoot: string): Promise<TrustState>;
	save(workspaceRoot: string, state: TrustState): Promise<void>;
};

type TrustStoreConstructor = new (options: { homeDir: string }) => TrustStore;

test("workspace trust is user-owned, durable, revocable, and fail-closed", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-workspace-trust-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	t.after(async () => { await rm(root, { recursive: true, force: true }); });

	const configModule = await import("../../src/index.ts") as Record<string, unknown>;
	const Store = configModule.WorkspaceTrustStore;
	assert.equal(typeof Store, "function", "@mycli/config must export WorkspaceTrustStore");
	const createStore = Store as TrustStoreConstructor;
	const first = new createStore({ homeDir: home });

	assert.equal(await first.load(workspace), "unknown");
	await first.save(workspace, "trusted");
	assert.equal(await new createStore({ homeDir: home }).load(workspace), "trusted");
	assert.equal(existsSync(join(workspace, ".mycli")), false);

	const trustDirectory = join(home, ".mycli", "trust");
	const files = await readdir(trustDirectory);
	assert.equal(files.length, 1);
	await writeFile(join(trustDirectory, files[0] ?? "missing"), "{broken", "utf8");
	assert.equal(await new createStore({ homeDir: home }).load(workspace), "unknown");

	await first.save(workspace, "untrusted");
	assert.equal(await new createStore({ homeDir: home }).load(workspace), "untrusted");
	await first.save(workspace, "unknown");
	assert.equal(await new createStore({ homeDir: home }).load(workspace), "unknown");
});

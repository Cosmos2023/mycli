import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	BUILTIN_MODEL_CATALOG,
	findModelCatalogEntry,
	loadModelCatalog,
	modelCatalogEntryPayload,
} from "../src/index.ts";

const CURRENT = Object.freeze({
	provider: "openai" as const,
	protocol: "responses" as const,
	model: "private-current",
	apiBaseUrl: "https://models.example/v1/",
	authRef: "private-account",
});

test("model catalog loads Python-compatible models.json and marks the exact current entry", async (t) => {
	const homeDir = await temporaryDirectory(t);
	await writeCatalog(homeDir, [
		{
			model: "other-model",
			provider: "openai",
			protocol: "responses",
			base_url: "https://api.openai.com/v1",
			auth_ref: "openai",
		},
		{
			model: "private-current",
			provider: "openai",
			protocol: "responses",
			base_url: "https://models.example/v1",
			auth_ref: "private-account",
			description: "Configured endpoint",
			reasoning_efforts: ["low", "high"],
			default_reasoning_effort: "high",
		},
	]);

	const entries = await loadModelCatalog({ homeDir, currentConfig: CURRENT });
	assert.equal(entries.length, 2);
	assert.equal(entries[0]?.model, "private-current");
	assert.equal(entries[0]?.isCurrent, true);
	assert.deepEqual(entries[0]?.supportedReasoningEfforts, ["low", "high"]);
	assert.equal(entries[0]?.defaultReasoningEffort, "high");
	assert.equal(entries[1]?.isCurrent, false);
	assert.equal(
		findModelCatalogEntry(entries, {
			provider: "openai",
			protocol: "responses",
			model: "private-current",
			baseUrl: "https://models.example/v1/",
		}),
		entries[0],
	);
	const payload = modelCatalogEntryPayload(entries[0]!);
	assert.equal(payload.current, true);
	assert.equal(payload.default_reasoning_effort, "high");
	assert.equal("auth_ref" in payload, false);
});

test("model catalog bootstraps the Python-compatible registry with private permissions", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const entries = await loadModelCatalog({ homeDir, currentConfig: CURRENT });
	const path = join(homeDir, ".mycli", "models.json");
	const raw = JSON.parse(await readFile(path, "utf8")) as { models: unknown[] };

	assert.equal(entries.length, BUILTIN_MODEL_CATALOG.length + 1);
	assert.equal(entries[0]?.model, CURRENT.model);
	assert.equal(entries[0]?.authRef, CURRENT.authRef);
	assert.equal(raw.models.length, BUILTIN_MODEL_CATALOG.length + 1);
	if (process.platform !== "win32") {
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(homeDir, ".mycli"))).mode & 0o777, 0o700);
	}
});

test("model catalog rejects duplicate identities and invalid reasoning defaults", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const duplicate = {
		model: "gpt-test",
		provider: "openai",
		protocol: "responses",
		base_url: "https://models.example/v1",
	};
	await writeCatalog(homeDir, [duplicate, { ...duplicate, auth_ref: "another" }]);
	await assert.rejects(
		() => loadModelCatalog({ homeDir, currentConfig: CURRENT }),
		/duplicate model entry/i,
	);

	await writeCatalog(homeDir, [{
		...duplicate,
		reasoning_efforts: ["low"],
		default_reasoning_effort: "high",
	}]);
	await assert.rejects(
		() => loadModelCatalog({ homeDir, currentConfig: CURRENT }),
		/unlisted default reasoning effort/i,
	);
});

async function writeCatalog(homeDir: string, models: readonly unknown[]): Promise<void> {
	const directory = join(homeDir, ".mycli");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "models.json"), `${JSON.stringify({ models }, null, 2)}\n`, "utf8");
}

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-model-catalog-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

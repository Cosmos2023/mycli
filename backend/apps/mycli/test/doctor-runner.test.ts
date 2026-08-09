import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelInputSha256 } from "@mycli/core";
import { commitRuntimeProviderStep } from "@mycli/runtime";
import {
	SCHEMA_V2_SQL,
	SCHEMA_V5_SQL,
	SCHEMA_V6_SQL,
	SCHEMA_VERSION,
	SQLiteSessionStore,
} from "@mycli/storage";
import { READ_TOOL_DEFINITION } from "@mycli/tools";
import { renderManagementResponse } from "../src/management/render.ts";
import { collectConfigChecks } from "../src/management/doctor/check-config.ts";
import { collectProcessChecks } from "../src/management/doctor/check-process.ts";
import { collectRuntimeChecks } from "../src/management/doctor/check-runtime.ts";
import { collectStorageChecks } from "../src/management/doctor/check-storage.ts";
import {
	doctorResponseFromReport,
	runDoctorCollectors,
} from "../src/management/doctor/runner.ts";

test("doctor collectors preserve order, isolate failures, and count severities", async () => {
	const calls: string[] = [];
	const report = await runDoctorCollectors([
		{
			name: "first",
			collect: () => {
				calls.push("first");
				return { name: "first", status: "ok", message: "ready" };
			},
		},
		{
			name: "broken",
			collect: () => {
				calls.push("broken");
				throw new Error("Authorization: Bearer test-secret private-command");
			},
		},
		{
			name: "last",
			collect: async () => {
				calls.push("last");
				return { name: "last", status: "warning", message: "optional state missing" };
			},
		},
	]);

	assert.deepEqual(calls, ["first", "broken", "last"]);
	assert.deepEqual(report.checks.map((check) => check.name), ["first", "broken", "last"]);
	assert.deepEqual(
		[report.okCount, report.warningCount, report.failedCount],
		[1, 1, 1],
	);
	assert.doesNotMatch(JSON.stringify(report), /test-secret|Bearer|private-command/u);
});

test("doctor bounds a collector, aborts its cleanup, and continues", { timeout: 500 }, async () => {
	let cleanupCount = 0;
	let lastCount = 0;
	const report = await runDoctorCollectors([
		{
			name: "slow",
			collect: (signal) => new Promise((_, reject) => {
				signal.addEventListener("abort", () => {
					cleanupCount += 1;
					const error = new Error("timed out with private-output");
					error.name = "AbortError";
					reject(error);
				}, { once: true });
			}),
		},
		{
			name: "last",
			collect: () => {
				lastCount += 1;
				return { name: "last", status: "ok", message: "ready" };
			},
		},
	], new AbortController().signal, { collectorTimeoutMs: 5, cleanupTimeoutMs: 50 });

	assert.equal(cleanupCount, 1);
	assert.equal(lastCount, 1);
	assert.deepEqual(report.checks.map((check) => [check.name, check.status]), [
		["slow", "failed"],
		["last", "ok"],
	]);
	assert.match(report.checks[0]?.message ?? "", /timed out/u);
	assert.doesNotMatch(JSON.stringify(report), /private-output/u);
});

test("doctor human and JSON output consume one report and share exit semantics", async () => {
	const warningReport = await runDoctorCollectors([{
		name: "config",
		collect: () => ({ name: "config", status: "warning", message: "api key missing" }),
	}]);
	const warningResponse = doctorResponseFromReport(warningReport);
	const human = renderManagementResponse(
		{ kind: "doctor", json: false },
		warningResponse,
	);
	const json = JSON.parse(renderManagementResponse(
		{ kind: "doctor", json: true },
		warningResponse,
	)) as Readonly<Record<string, unknown>>;

	assert.equal(warningResponse.ok, true);
	assert.equal(warningResponse.exitCode, 0);
	assert.deepEqual(json.checks, warningReport.checks);
	assert.equal(json.warningCount, warningReport.warningCount);
	assert.match(human, /^mycli doctor\n/u);
	assert.match(human, /\[WARN\] config: api key missing/u);
	assert.match(human, /Summary: 0 ok, 1 warning, 0 failed/u);

	const failedReport = await runDoctorCollectors([{
		name: "storage",
		collect: () => ({ name: "storage", status: "failed", message: "database invalid" }),
	}]);
	const failedResponse = doctorResponseFromReport(failedReport);
	assert.equal(failedResponse.ok, false);
	assert.equal(failedResponse.exitCode, 1);
});

test("config doctor validates profiles and reports API key presence without exposing it", async (t) => {
	const root = await doctorFixture(t);
	const checks = await collectConfigChecks({
		workspaceRoot: root.workspaceRoot,
		homeDir: root.homeDir,
		env: {
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_MODEL: "gpt-5",
			MYCLI_API_KEY: "sk-config-test-secret",
		},
	});

	assert.deepEqual(checks.map((check) => [check.name, check.status]), [
		["config", "ok"],
		["api_key", "ok"],
	]);
	assert.match(checks[0]?.message ?? "", /provider=openai protocol=responses model=gpt-5/u);
	assert.match(checks[1]?.message ?? "", /present/u);
	assert.doesNotMatch(JSON.stringify(checks), /sk-config-test-secret/u);

	await mkdir(join(root.workspaceRoot, ".mycli"), { recursive: true });
	await writeFile(join(root.workspaceRoot, ".mycli", "config.toml"), "[model\napi_key='file-test-secret'", "utf8");
	const malformed = await collectConfigChecks({
		workspaceRoot: root.workspaceRoot,
		homeDir: root.homeDir,
		env: {},
	});
	assert.equal(malformed[0]?.status, "failed");
	assert.equal(malformed[1]?.status, "warning");
	assert.doesNotMatch(JSON.stringify(malformed), /file-test-secret|invalid TOML in .*config/u);
});

test("storage doctor validates SQLite through a read-only connection and creates nothing", async (t) => {
	const root = await doctorFixture(t);
	const missing = await collectStorageChecks(root);
	assert.deepEqual(missing.map((check) => [check.name, check.status]), [
		["storage_layout", "ok"],
		["sessions_db", "warning"],
		["model_input_ledger", "warning"],
		["logs", "warning"],
		["traces", "ok"],
		["logs_redaction", "ok"],
	]);
	await assert.rejects(stat(join(root.homeDir, ".mycli")), /ENOENT/u);

	const homeRoot = join(root.homeDir, ".mycli");
	await mkdir(homeRoot, { recursive: true });
	const databasePath = join(homeRoot, "sessions.db");
	const database = new DatabaseSync(databasePath);
	database.exec(SCHEMA_V2_SQL);
	database.exec(SCHEMA_V5_SQL);
	database.exec(SCHEMA_V6_SQL);
	database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
	database.close();
	const before = await stat(databasePath);
	const present = await collectStorageChecks(root);
	const after = await stat(databasePath);

	assert.equal(present.find((check) => check.name === "sessions_db")?.status, "ok");
	assert.deepEqual(
		present.find((check) => check.name === "model_input_ledger"),
		{
			name: "model_input_ledger",
			status: "ok",
			message: "blobs=0 manifests=0 issues=0",
		},
	);
	assert.equal(after.mtimeMs, before.mtimeMs);
});

test("storage doctor reports incomplete and corrupt model-input ledgers read-only", async (t) => {
	const root = await doctorFixture(t);
	const homeRoot = join(root.homeDir, ".mycli");
	await mkdir(homeRoot, { recursive: true });
	const databasePath = join(homeRoot, "sessions.db");
	const database = new DatabaseSync(databasePath);
	database.exec(SCHEMA_V2_SQL);
	database.exec(SCHEMA_V5_SQL);
	database.exec(SCHEMA_V6_SQL);
	database.exec("PRAGMA foreign_keys = OFF");
	database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(
		"doctor-ledger-session",
		root.workspaceRoot,
		"doctor-ledger-session",
		"2026-08-08T00:00:00.000Z",
		"2026-08-08T00:00:00.000Z",
		"2026-08-08T00:00:00.000Z",
		"active",
	);
	database.prepare(`
		INSERT INTO model_input_blobs (blob_id, payload_json, created_at)
		VALUES (?, ?, ?)
	`).run("not-a-content-hash", "{}", "2026-08-08T00:00:00.000Z");
	database.prepare(`
		INSERT INTO instruction_snapshots (
			snapshot_id, session_id, blob_id, content_sha256, created_at
		) VALUES (?, ?, ?, ?, ?)
	`).run(
		"missing-instruction",
		"doctor-ledger-session",
		"missing-blob",
		"0".repeat(64),
		"2026-08-08T00:00:00.000Z",
	);
	database.close();
	const before = await stat(databasePath);

	const checks = await collectStorageChecks(root);
	const ledger = checks.find((check) => check.name === "model_input_ledger");

	assert.equal(ledger?.status, "failed");
	assert.match(ledger?.message ?? "", /blobs=1 manifests=0 issues=2/u);
	assert.match(ledger?.detail ?? "", /invalid_blob_hash=1/u);
	assert.match(ledger?.detail ?? "", /missing_instruction_blob=1/u);
	assert.equal((await stat(databasePath)).mtimeMs, before.mtimeMs);
});

test("storage doctor accepts a reconstructable persisted provider step", async (t) => {
	const root = await doctorFixture(t);
	const homeRoot = join(root.homeDir, ".mycli");
	await mkdir(homeRoot, { recursive: true });
	const databasePath = join(homeRoot, "sessions.db");
	const store = new SQLiteSessionStore({ dbPath: databasePath });
	const now = "2026-08-08T00:00:00.000Z";
	store.reserveTurn({
		sessionId: "healthy-ledger-session",
		clientTurnId: "healthy-client-turn",
		clientUserMessageId: "healthy-user-message",
		turnId: "healthy-turn",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: root.workspaceRoot,
		threadId: "healthy-ledger-session",
		userText: "Inspect README.md",
		startedAt: now,
	});
	let sequence = 0;
	commitRuntimeProviderStep({
		sessionId: "healthy-ledger-session",
		turnId: "healthy-turn",
		providerStep: 1,
		requestConfig: {
			provider: "openai",
			protocol: "responses",
			model: "gpt-test",
		},
		instructionSnapshot: Object.freeze({
			snapshotId: "healthy-instructions",
			version: "test-v1",
			source: "test",
			content: "Test system instructions.",
			contentSha256: modelInputSha256("Test system instructions."),
			createdAt: now,
		}),
		tools: [READ_TOOL_DEFINITION],
		history: store.loadConversationItems("healthy-ledger-session"),
		currentUserRequest: "Inspect README.md",
		sources: Object.freeze({}),
		ledger: store.modelInputLedger,
		maxPromptTokens: 16_000,
		clock: () => now,
		createId: (kind) => `${kind}-${++sequence}`,
	});
	store.close();
	const before = await stat(databasePath);

	const ledger = (await collectStorageChecks(root)).find(
		(check) => check.name === "model_input_ledger",
	);

	assert.equal(ledger?.status, "ok");
	assert.match(ledger?.message ?? "", /manifests=1 issues=0/u);
	assert.equal((await stat(databasePath)).mtimeMs, before.mtimeMs);
});

test("runtime and process doctor validate local contracts without starting work", async (t) => {
	const root = await doctorFixture(t);
	const runtime = await collectRuntimeChecks();
	let executableProbes = 0;
	const processChecks = collectProcessChecks({
		workspaceRoot: root.workspaceRoot,
		platform: "darwin",
		isExecutable: () => {
			executableProbes += 1;
			return true;
		},
		pathExists: () => false,
		isSymbolicLink: () => false,
	});

	assert.deepEqual(runtime.map((check) => [check.name, check.status]), [
		["node_runtime", "ok"],
		["package_layout", "ok"],
		["runtime_contract", "ok"],
		["tool_manifest", "ok"],
	]);
	assert.deepEqual(processChecks.map((check) => [check.name, check.status]), [
		["process_support", "ok"],
		["process_sandbox", "ok"],
	]);
	assert.equal(executableProbes, 1);
	assert.doesNotMatch(JSON.stringify(processChecks), new RegExp(root.workspaceRoot, "u"));
});

async function doctorFixture(t: test.TestContext): Promise<{
	readonly workspaceRoot: string;
	readonly homeDir: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-doctor-runner-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	await mkdir(workspaceRoot, { recursive: true });
	return { workspaceRoot, homeDir: join(root, "home") };
}

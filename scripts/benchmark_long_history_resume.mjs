#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import { clearInterval, setInterval, setTimeout } from "node:timers";
import Database from "better-sqlite3";
import {
	analyzeV10ContentBlobMigration,
	applyV10ContentBlobMigrationCutover,
	applyV9TranscriptNormalizationCutover,
	openRuntimeSessionStore,
	SCHEMA_V12_VERSION,
	SCHEMA_V13_VERSION,
	SCHEMA_V15_VERSION,
	SQLiteSessionStore,
	SQLiteTranscriptEventRepository,
	stageV10ContentBlobMigrationBatch,
	stageV9TranscriptNormalizationBatch,
} from "@mycli/storage";
import { startNodeBackend } from "../backend/apps/mycli/src/node-runtime/node-backend.ts";

const PROFILES = Object.freeze({
	heavy: Object.freeze({
		turns: 600, toolsPerTurn: 3, toolOutputChars: 7_800, compactions: 3, retainedTurns: 20,
	}),
	blob_tool_heavy: Object.freeze({
		turns: 600,
		toolsPerTurn: 3,
		toolOutputChars: 7_800,
		compactions: 3,
		retainedTurns: 20,
		contentPattern: "repeated_source",
	}),
	blob_smoke: Object.freeze({
		turns: 24,
		toolsPerTurn: 3,
		toolOutputChars: 2_000,
		compactions: 3,
		retainedTurns: 8,
		contentPattern: "repeated_source",
	}),
	extreme: Object.freeze({
		turns: 2_000, toolsPerTurn: 3, toolOutputChars: 7_800, compactions: 3, retainedTurns: 20,
	}),
	compact_stress: Object.freeze({
		turns: 520,
		toolsPerTurn: 3,
		toolOutputChars: 7_800,
		compactions: 500,
		compactionSummaryChars: 8_000,
		retainedTurns: 20,
		memoryEnabled: true,
	}),
	blob_compact_stress: Object.freeze({
		turns: 520,
		toolsPerTurn: 3,
		toolOutputChars: 7_800,
		compactions: 500,
		compactionSummaryChars: 8_000,
		retainedTurns: 20,
		memoryEnabled: true,
		contentPattern: "repeated_source",
	}),
});
const REQUEST_TIMEOUT_MS = 15 * 60 * 1_000;
const SAMPLE_INTERVAL_MS = 10;
const CURRENT_STORAGE_SCHEMA = `v${SCHEMA_V15_VERSION}`;
const TIMELINE_STORAGE_SCHEMAS = new Set(["v12", "v13", CURRENT_STORAGE_SCHEMA]);
const STORAGE_SCHEMAS = new Set(["v9", "v10", "v11", ...TIMELINE_STORAGE_SCHEMAS, "paired"]);
const CONTENT_BLOB_BATCH_SIZE = 500;
const TOOL_HEAVY_PAYLOAD_REDUCTION_MINIMUM = 0.35;
const COMPACTION_PHYSICAL_REDUCTION_MINIMUM = 0.30;
const MATERIAL_LATENCY_RATIO = 1.35;
const MATERIAL_LATENCY_ALLOWANCE_MS = 50;
const MATERIAL_MEMORY_RATIO = 1.35;
const MATERIAL_MEMORY_ALLOWANCE_BYTES = 64 * 1024 * 1024;
const TOOL_OUTPUT_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-/";
const SERVER_URL = new URL("./fixtures/responses-long-history-benchmark-server.mjs", import.meta.url);

const exitCode = await main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	return 1;
});
process.exitCode = exitCode;

async function main() {
	let values;
	try {
		({ values } = parseArgs({
			options: {
				profile: { type: "string", default: "heavy" },
				"storage-schema": { type: "string", default: CURRENT_STORAGE_SCHEMA },
				keep: { type: "boolean", default: false },
				"seed-only": { type: "boolean", default: false },
				"fixture-root": { type: "string" },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch {
		return 64;
	}
	const profileName = values.profile;
	if (!(profileName in PROFILES)) return 64;
	const storageSchema = values["storage-schema"];
	if (!STORAGE_SCHEMAS.has(storageSchema)) return 64;
	const profile = PROFILES[profileName];
	if (storageSchema === "paired") {
		if (values["seed-only"] || values["fixture-root"]) return 64;
		return runPairedBenchmark(profileName, values.keep === true);
	}
	if (values["seed-only"]) {
		if (!values["fixture-root"]) return 64;
		const seedStarted = performance.now();
		const seed = seedDatabase({
			dbPath: join(values["fixture-root"], "home", ".mycli", "sessions.db"),
			workspace: join(values["fixture-root"], "workspace"),
			profile,
			storageSchema,
		});
		process.stdout.write(`${JSON.stringify({
			seedMilliseconds: rounded(performance.now() - seedStarted),
			...seed,
		})}\n`);
		return 0;
	}
	const root = await mkdtemp(join(tmpdir(), `mycli-long-history-${profileName}-${storageSchema}-`));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	mkdirSync(home);
	mkdirSync(workspace);
	const dbPath = join(home, ".mycli", "sessions.db");
	let backend;
	let providerServer;
	let sampler;
	try {
		const seed = await seedFixtureInChild(root, profileName, storageSchema);
		globalThis.gc?.();
		providerServer = await startProviderServer(root);
		sampler = startMemorySampler();
		const memoryBeforeBackend = memorySnapshot("before_backend");

		const backendStarted = performance.now();
		backend = await startNodeBackend({
			cwd: workspace,
			args: ["--session", "bootstrap", "--model", "gpt-test"],
			env: {
				HOME: home,
				MYCLI_API_KEY: "benchmark-key",
				MYCLI_BASE_URL: `http://127.0.0.1:${providerServer.port}/v1`,
				MYCLI_PROVIDER: "openai",
				MYCLI_PROTOCOL: "responses",
				MYCLI_THINKING_ENABLED: "false",
				MYCLI_MEMORY_ENABLED: profile.memoryEnabled === true ? "true" : "false",
				MYCLI_STREAM_MAX_RETRIES: "0",
				MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
				MYCLI_AGENT_WORKER_MAX: "2",
				MYCLI_AGENT_WORKER_IDLE_TIMEOUT_MS: "1000",
				MYCLI_MAX_PROMPT_TOKENS: "1000000",
				MYCLI_COMPACTION_TOKEN_LIMIT: "900000",
				MYCLI_COMPACTION_RESERVED_OUTPUT_TOKENS: "100000",
			},
		});
		const messages = [];
		const reader = createInterface({ input: backend.transport.input, crlfDelay: Infinity });
		reader.on("line", (line) => {
			messages.push({
				epochMilliseconds: performance.timeOrigin + performance.now(),
				message: JSON.parse(line),
			});
		});
		await waitFor(() => findEvent(messages, "runtime.ready"));
		const backendReadyMilliseconds = performance.now() - backendStarted;
		const memoryAtReady = memorySnapshot("backend_ready");

		const resumeStarted = performance.now();
		writeRequest(backend, "resume", "session.resume", { session_id: "target" });
		const resumeResponse = await waitFor(() => findResponse(messages, "resume"));
		assertSuccessfulResponse(resumeResponse.message, "session.resume");
		const resumeMilliseconds = performance.now() - resumeStarted;
		const memoryAfterResume = memorySnapshot("after_resume");

		const firstTranscriptPageStarted = performance.now();
		writeRequest(backend, "transcript-0", "transcript.load", {
			session_id: "target",
			before: null,
			limit: 500,
		});
		const firstTranscriptResponse = await waitFor(() => findResponse(messages, "transcript-0"));
		assertSuccessfulResponse(firstTranscriptResponse.message, "transcript.load");
		const transcriptItems = [...arrayResult(firstTranscriptResponse.message, "items")];
		const firstTranscriptPageMilliseconds = performance.now() - firstTranscriptPageStarted;
		const memoryAfterFirstTranscriptPage = memorySnapshot("after_first_transcript_page");
		let transcriptBefore = typeof firstTranscriptResponse.message.result?.next_before === "string"
			? firstTranscriptResponse.message.result.next_before
			: undefined;
		let transcriptPage = 1;
		const allTranscriptPagesStarted = performance.now();
		while (transcriptBefore) {
			const requestId = `transcript-${transcriptPage}`;
			writeRequest(backend, requestId, "transcript.load", {
				session_id: "target",
				before: transcriptBefore,
				limit: 500,
			});
			const transcriptResponse = await waitFor(() => findResponse(messages, requestId));
			assertSuccessfulResponse(transcriptResponse.message, "transcript.load");
			transcriptItems.unshift(...arrayResult(transcriptResponse.message, "items"));
			transcriptBefore = typeof transcriptResponse.message.result?.next_before === "string"
				? transcriptResponse.message.result.next_before
				: undefined;
			transcriptPage += 1;
		}
		const remainingTranscriptPagesMilliseconds = performance.now() - allTranscriptPagesStarted;
		const memoryAfterAllTranscriptPages = memorySnapshot("after_all_transcript_pages");
		const databaseBeforeTurn = inspectDatabase(dbPath);

		const turnStartedEpochMilliseconds = performance.timeOrigin + performance.now();
		const turnStarted = performance.now();
		writeRequest(backend, "turn", "turn.submit", {
			message: "Continue after this very large tool-heavy history.",
			client_turn_id: "benchmark-turn",
			client_user_message_id: "benchmark-message",
		});
		const submitResponse = await waitFor(() => findResponse(messages, "turn"));
		assertSuccessfulResponse(submitResponse.message, "turn.submit");
		const submitAcceptedMilliseconds = performance.now() - turnStarted;
		const terminal = await waitFor(() => messages.find(({ message }) => (
			(message.method === "message.complete" && message.params?.final === true
				|| message.method === "turn.failed")
			&& message.params?.client_turn_id === "benchmark-turn"
		)), REQUEST_TIMEOUT_MS);
		const turnCompleteMilliseconds = terminal.epochMilliseconds - turnStartedEpochMilliseconds;
		const memoryAfterTurn = memorySnapshot("after_turn");
		const compactionStarted = findEvent(messages, "compaction.started", "benchmark-turn");
		const compactionCompleted = findEvent(messages, "compaction.completed", "benchmark-turn");
		if (terminal.message.method === "message.complete") {
			await waitFor(() => providerServer.requests.length >= 1, REQUEST_TIMEOUT_MS);
			await delay(100);
		} else {
			await delay(100);
		}
		const providerRequests = [...providerServer.requests];
		assertResumeSemantics({
			profile,
			storageSchema,
			transcriptItems,
			providerRequests,
			compactionStarted,
			compactionCompleted,
		});

		await delay(1_500);
		globalThis.gc?.();
		await delay(100);
		const memoryAfterIdle = memorySnapshot("after_idle_gc");
		const workerCountAfterIdle = process.report.getReport().workers?.length ?? 0;
		const databaseAfterTurn = inspectDatabase(dbPath);
		const peak = sampler.snapshot();

		writeRequest(backend, "shutdown", "shutdown", {});
		await backend.completion;
		backend = undefined;
		await providerServer.close();
		providerServer = undefined;
		sampler.stop();
		sampler = undefined;
		const semanticProjections = inspectSemanticProjections(dbPath, workspace, root);

		const turnRequest = providerRequests.find((request) => request.kind === "provider_turn");
		const result = {
			schemaVersion: 5,
			profile: profileName,
			storageSchema,
			platform: process.platform,
			arch: process.arch,
			nodeVersion: process.versions.node,
			fixture: {
				turns: profile.turns,
				toolsPerTurn: profile.toolsPerTurn,
				toolOutputChars: profile.toolOutputChars,
				compactions: profile.compactions,
				compactionSummaryChars: profile.compactionSummaryChars ?? 0,
				memoryEnabled: profile.memoryEnabled === true,
				retainedTurnsAfterLatestCompaction: profile.retainedTurns,
				conversationItems: profile.turns * (profile.toolsPerTurn + 3),
				historyItems: profile.turns * (profile.toolsPerTurn * 2 + 3) + profile.compactions,
				rollouts: profile.turns,
				seedMilliseconds: rounded(seed.seedMilliseconds),
				...(seed.normalizationVacuum ? { normalizationVacuum: seed.normalizationVacuum } : {}),
				...(seed.contentBlobMigration
					? { contentBlobMigration: seed.contentBlobMigration }
					: {}),
				...databaseAfterTurn,
			},
			timingsMilliseconds: {
				backendReady: rounded(backendReadyMilliseconds),
				resumeRpc: rounded(resumeMilliseconds),
				firstTranscriptPageRpc: rounded(firstTranscriptPageMilliseconds),
				remainingTranscriptPagesRpc: rounded(remainingTranscriptPagesMilliseconds),
				allTranscriptPagesRpc: rounded(
					firstTranscriptPageMilliseconds + remainingTranscriptPagesMilliseconds,
				),
				turnSubmitAccepted: rounded(submitAcceptedMilliseconds),
				turnToCompactionStarted: eventOffset(compactionStarted, turnStartedEpochMilliseconds),
				turnToProviderRequestFirstByte: requestOffset(turnRequest, turnStartedEpochMilliseconds),
				turnComplete: rounded(turnCompleteMilliseconds),
			},
			resumeProjection: {
				compactionTriggered: compactionStarted !== undefined || compactionCompleted !== undefined,
				providerUsedLatestBoundary: turnRequest?.latestCompactionSummaryPresent === true,
				providerIncludedPreBoundaryHistory: turnRequest?.oldestTurnPresent === true,
				providerToolCalls: turnRequest?.functionCalls,
				providerToolResults: turnRequest?.functionCallOutputs,
			},
			turnOutcome: terminal.message.method === "message.complete"
				? { status: "completed" }
				: {
					status: "failed",
					code: stringParam(terminal, "code"),
					message: stringParam(terminal, "message"),
				},
			requests: providerRequests,
			semanticProjections: {
				readableSha256: sha256Json(transcriptItems),
				...semanticProjections,
			},
			transcriptItems: transcriptItems.length,
				transcriptPages: transcriptPage,
			transcriptWritePerTurn: transcriptWriteDelta(databaseBeforeTurn, databaseAfterTurn),
			memoryBytes: {
				beforeBackend: memoryBeforeBackend,
				atReady: memoryAtReady,
				afterResume: memoryAfterResume,
				afterFirstTranscriptPage: memoryAfterFirstTranscriptPage,
				afterAllTranscriptPages: memoryAfterAllTranscriptPages,
				afterTurn: memoryAfterTurn,
				afterIdleGc: memoryAfterIdle,
				peakSinceBackendStart: peak,
				processHighWaterRss: process.resourceUsage().maxRSS * 1024,
				peakRssDeltaFromReady: Math.max(0, peak.rss - memoryAtReady.rss),
				idleRssDeltaFromReady: memoryAfterIdle.rss - memoryAtReady.rss,
				readyRssDeltaFromBaseline: Math.max(0, memoryAtReady.rss - memoryBeforeBackend.rss),
				resumeRssDeltaFromBaseline: Math.max(
					0,
					memoryAfterResume.rss - memoryBeforeBackend.rss,
				),
			},
			workerCountAfterIdle,
		};
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (values.keep) process.stderr.write(`benchmark fixture kept at ${root}\n`);
		return 0;
	} finally {
		sampler?.stop();
		if (backend) await backend.close().catch(() => undefined);
		if (providerServer) await providerServer.close().catch(() => undefined);
		if (!values.keep) rmSync(root, { recursive: true, force: true });
	}
}

async function runPairedBenchmark(profileName, keep) {
	const v10 = await runBenchmarkChild(profileName, "v10", keep);
	const v11 = await runBenchmarkChild(profileName, "v11", keep);
	const acceptance = pairedAcceptance(profileName, v10, v11);
	process.stdout.write(`${JSON.stringify({
		schemaVersion: 1,
		kind: "v10_v11_pair",
		profile: profileName,
		platform: process.platform,
		arch: process.arch,
		nodeVersion: process.versions.node,
		acceptance,
		runs: { v10, v11 },
	}, null, 2)}\n`);
	return acceptance.passed ? 0 : 2;
}

async function runBenchmarkChild(profileName, storageSchema, keep) {
	const child = spawn(process.execPath, [
		...process.execArgv,
		fileURLToPath(import.meta.url),
		"--profile",
		profileName,
		"--storage-schema",
		storageSchema,
		...(keep ? ["--keep"] : []),
	], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	if (code !== 0) {
		throw new Error(`long_history_${storageSchema}_benchmark_failed:${code}:${stderr.length}`);
	}
	if (keep && stderr) process.stderr.write(stderr);
	return JSON.parse(stdout);
}

function pairedAcceptance(profileName, v10, v11) {
	const v10PayloadBytes = v10.fixture.payloadStorage.payloadStorageBytes;
	const v11PayloadBytes = v11.fixture.payloadStorage.payloadStorageBytes;
	const payloadReduction = reduction(v10PayloadBytes, v11PayloadBytes);
	const v10VacuumedBytes = v10.fixture.normalizationVacuum.databaseBytesAfter;
	const v11VacuumedBytes = v11.fixture.contentBlobMigration.vacuum.physicalAfter.databaseBytes;
	const physicalReduction = reduction(v10VacuumedBytes, v11VacuumedBytes);
	const migration = v11.fixture.contentBlobMigration;
	const semanticParity = v10.semanticProjections.readableSha256
		=== v11.semanticProjections.readableSha256
		&& v10.semanticProjections.searchSha256 === v11.semanticProjections.searchSha256
		&& v10.semanticProjections.ledgerReconstructed === true
		&& v11.semanticProjections.ledgerReconstructed === true
		&& v11.fixture.contentBlobMigration.cutover.parityValidated === true
		&& providerTurn(v10)?.semanticRequestSha256
			=== providerTurn(v11)?.semanticRequestSha256
		&& v10.transcriptItems === v11.transcriptItems
		&& v10.resumeProjection.providerToolCalls === v11.resumeProjection.providerToolCalls
		&& v10.resumeProjection.providerToolResults === v11.resumeProjection.providerToolResults
		&& v10.turnOutcome.status === "completed"
		&& v11.turnOutcome.status === "completed";
	const latencyBounded = boundedRegression(
		v10.timingsMilliseconds.backendReady,
		v11.timingsMilliseconds.backendReady,
		MATERIAL_LATENCY_RATIO,
		MATERIAL_LATENCY_ALLOWANCE_MS,
	) && boundedRegression(
		v10.timingsMilliseconds.resumeRpc,
		v11.timingsMilliseconds.resumeRpc,
		MATERIAL_LATENCY_RATIO,
		MATERIAL_LATENCY_ALLOWANCE_MS,
	);
	const memoryBounded = boundedRegression(
		v10.memoryBytes.readyRssDeltaFromBaseline,
		v11.memoryBytes.readyRssDeltaFromBaseline,
		MATERIAL_MEMORY_RATIO,
		MATERIAL_MEMORY_ALLOWANCE_BYTES,
	) && boundedRegression(
		v10.memoryBytes.resumeRssDeltaFromBaseline,
		v11.memoryBytes.resumeRssDeltaFromBaseline,
		MATERIAL_MEMORY_RATIO,
		MATERIAL_MEMORY_ALLOWANCE_BYTES,
	);
	const migrationHeadroomBounded = migration.headroom.sufficientFreeSpace !== false
		&& migration.measuredTemporaryAdditionalBytes
			<= migration.headroom.estimatedTemporaryPeakBytes;
	const gates = [
		gate("semantic_search_ledger_parity", true, semanticParity),
		gate("migration_headroom_bounded", true, migrationHeadroomBounded),
		gate("startup_resume_latency_bounded", true, latencyBounded),
		gate("startup_resume_memory_bounded", true, memoryBounded),
		gate(
			"tool_heavy_payload_reduction",
			profileName === "blob_tool_heavy",
			payloadReduction >= TOOL_HEAVY_PAYLOAD_REDUCTION_MINIMUM,
			payloadReduction,
			TOOL_HEAVY_PAYLOAD_REDUCTION_MINIMUM,
		),
		gate(
			"five_hundred_compaction_physical_reduction",
			profileName === "blob_compact_stress",
			physicalReduction >= COMPACTION_PHYSICAL_REDUCTION_MINIMUM,
			physicalReduction,
			COMPACTION_PHYSICAL_REDUCTION_MINIMUM,
		),
	];
	return Object.freeze({
		passed: gates.every((entry) => !entry.required || entry.passed),
		payloadReductionRatio: rounded(payloadReduction),
		physicalReductionRatio: rounded(physicalReduction),
		gates: Object.freeze(gates),
	});
}

function gate(name, required, passed, actual, minimum) {
	return Object.freeze({
		name,
		required,
		passed,
		...(actual === undefined ? {} : { actual: rounded(actual) }),
		...(minimum === undefined ? {} : { minimum }),
	});
}

function providerTurn(result) {
	return result.requests.find((request) => request.kind === "provider_turn");
}

function reduction(before, after) {
	if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(after) || after < 0) return 0;
	return Math.max(0, (before - after) / before);
}

function boundedRegression(baseline, candidate, ratio, allowance) {
	if (!Number.isFinite(baseline) || baseline < 0 || !Number.isFinite(candidate) || candidate < 0) {
		return false;
	}
	return candidate <= Math.max(baseline * ratio, baseline + allowance);
}

async function seedFixtureInChild(root, profileName, storageSchema) {
	const scriptPath = fileURLToPath(import.meta.url);
	const child = spawn(process.execPath, [
		...process.execArgv,
		scriptPath,
		"--profile",
		profileName,
		"--storage-schema",
		storageSchema,
		"--seed-only",
		"--fixture-root",
		root,
	], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	if (code !== 0) throw new Error(`long_history_seed_failed:${code}:${stderr.length}`);
	return JSON.parse(stdout);
}

function seedDatabase({ dbPath, workspace, profile, storageSchema }) {
	if (TIMELINE_STORAGE_SCHEMAS.has(storageSchema)) {
		return seedCurrentDatabase({ dbPath, workspace, profile, storageSchema });
	}
	const initialize = new SQLiteSessionStore({ dbPath });
	initialize.close();
	const database = new Database(dbPath);
	database.pragma("journal_mode = DELETE");
	database.pragma("synchronous = OFF");
	const now = "2026-08-13T00:00:00.000Z";
	const insertSession = database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, 'active')
	`);
	const insertConversation = database.prepare(`
		INSERT INTO conversation_messages (session_id, message_index, payload_json)
		VALUES (?, ?, ?)
	`);
	const insertHistory = database.prepare(`
		INSERT INTO history_items (session_id, item_id, payload_json)
		VALUES (?, ?, ?)
	`);
	const insertRollout = database.prepare(`
		INSERT INTO turn_rollouts (session_id, turn_id, payload_json)
		VALUES (?, ?, ?)
	`);
	const insertSummary = database.prepare(`
		INSERT INTO session_summaries (session_id, summary_text, created_at)
		VALUES (?, ?, ?)
	`);
	const saveState = database.prepare(`
		INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
		VALUES (?, 'compact_checkpoint', ?, ?)
		ON CONFLICT(session_id, state_key) DO UPDATE SET
			payload_json = excluded.payload_json,
			updated_at = excluded.updated_at
	`);
	database.transaction(() => {
		insertSession.run("bootstrap", workspace, "bootstrap", now, now, now);
		insertSession.run("target", workspace, "target", now, now, now);
		let messageIndex = 0;
		const compactAfterTurns = compactionTurnCounts(profile);
		for (let turnIndex = 0; turnIndex < profile.turns; turnIndex += 1) {
			const turnId = `seed-turn-${turnIndex}`;
			const clientTurnId = `seed-client-${turnIndex}`;
			const userText = `User request ${turnIndex}: ${denseText(480, turnIndex + 1)}`;
			const assistantPreamble = `Inspecting turn ${turnIndex}: ${denseText(180, turnIndex + 17)}`;
			const assistantText = `Completed turn ${turnIndex}: ${denseText(480, turnIndex + 31)}`;
			const calls = Array.from({ length: profile.toolsPerTurn }, (_value, toolIndex) => ({
				callId: `call-${turnIndex}-${toolIndex}`,
				name: toolIndex % 2 === 0 ? "Read" : "Bash",
				arguments: { target: `fixture-${turnIndex}-${toolIndex}`, offset: turnIndex },
			}));
			insertConversation.run("target", messageIndex++, JSON.stringify({
				role: "user", content: userText, tool_call_id: null, response_id: null,
				metadata: {
					turn_id: turnId, client_turn_id: clientTurnId,
					client_user_message_id: clientTurnId, source: "submit",
				},
				blocks: [], tool_calls: [],
			}));
			insertHistory.run("target", `${turnId}:user:${clientTurnId}`, JSON.stringify({
				id: `${turnId}:user:${clientTurnId}`, thread_id: "target", turn_id: turnId,
				type: "user_message", text: userText, tool_name: null, call_id: null,
				metadata: { client_turn_id: clientTurnId, client_user_message_id: clientTurnId,
					source: "submit", image_paths: [] },
			}));
			insertConversation.run("target", messageIndex++, JSON.stringify({
				role: "assistant", content: assistantPreamble, tool_call_id: null,
				response_id: `resp-seed-${turnIndex}`, metadata: { turn_id: turnId, source: "node_runtime" },
				blocks: calls.map((call) => ({
					type: "tool_call", text: null, tool_name: call.name,
					tool_arguments: call.arguments, call_id: call.callId, provider_id: null, metadata: {},
				})),
				tool_calls: calls.map((call) => ({
					name: call.name, arguments: call.arguments,
					reason: "model requested tool", call_id: call.callId,
				})),
			}));
			insertHistory.run("target", `${turnId}:assistant-tool-preamble`, JSON.stringify({
				id: `${turnId}:assistant-tool-preamble`, thread_id: "target", turn_id: turnId,
				type: "assistant_message", text: assistantPreamble, tool_name: null, call_id: null,
				metadata: { source: "node_runtime", response_id: `resp-seed-${turnIndex}` },
			}));
			for (const [toolIndex, call] of calls.entries()) {
				insertHistory.run("target", `${turnId}:tool-call:${call.callId}`, JSON.stringify({
					id: `${turnId}:tool-call:${call.callId}`, thread_id: "target", turn_id: turnId,
					type: "tool_call", text: "", tool_name: call.name, call_id: call.callId,
					metadata: { arguments: call.arguments, source: "node_runtime",
						response_id: `resp-seed-${turnIndex}` },
				}));
				const output = benchmarkToolOutput(profile, turnIndex, toolIndex);
				insertConversation.run("target", messageIndex++, JSON.stringify({
					role: "tool", content: output, tool_call_id: call.callId, response_id: null,
					metadata: { turn_id: turnId, source: "node_runtime", tool_name: call.name,
						success: true, summary: `${call.name} completed` },
					blocks: [{
						type: "tool_result", text: output, tool_name: call.name,
						tool_arguments: null, call_id: call.callId, provider_id: null,
						metadata: { success: true },
					}],
					tool_calls: [],
				}));
				insertHistory.run("target", `${turnId}:tool-result:${call.callId}`, JSON.stringify({
					id: `${turnId}:tool-result:${call.callId}`, thread_id: "target", turn_id: turnId,
					type: "tool_result", text: `${call.name} completed`,
					tool_name: call.name, call_id: call.callId,
					metadata: { turn_id: turnId, source: "node_runtime", tool_name: call.name,
						success: true, summary: `${call.name} completed`, transcript_content: output },
				}));
			}
			insertConversation.run("target", messageIndex++, JSON.stringify({
				role: "assistant", content: assistantText, tool_call_id: null,
				response_id: `resp-seed-final-${turnIndex}`,
				metadata: { turn_id: turnId, source: "node_runtime" }, blocks: [], tool_calls: [],
			}));
			insertHistory.run("target", `${turnId}:assistant:1`, JSON.stringify({
				id: `${turnId}:assistant:1`, thread_id: "target", turn_id: turnId,
				type: "assistant_message", text: assistantText, tool_name: null, call_id: null,
				metadata: { source: "node_runtime", response_id: `resp-seed-final-${turnIndex}` },
			}));
			insertRollout.run("target", turnId, JSON.stringify({
				thread_id: "target", turn_id: turnId, status: "completed",
				started_at: now, completed_at: now, stop_reason: "assistant_completed",
				events: [], continuation_state: { response_id: `resp-seed-final-${turnIndex}`, usage: {} },
			}));
			const windowIndex = compactAfterTurns.indexOf(turnIndex + 1);
			if (windowIndex >= 0) {
				const windowNumber = windowIndex + 1;
				const windowId = `benchmark-window-${windowNumber}`;
				const marker = windowNumber === profile.compactions
					? "LATEST_COMPACTION_SUMMARY_MARKER"
					: `OLDER_COMPACTION_SUMMARY_MARKER_${windowNumber}`;
				const summary = benchmarkCompactionSummary(
					marker,
					profile.compactionSummaryChars,
					windowNumber,
					profile.contentPattern,
				);
				const replacementMessages = [storedMessage("user", `[compact-summary]\n${summary}`)];
				const checkpoint = {
					version: 1,
					turn_id: turnId,
					reason: "context_limit",
					phase: "pre_turn",
					window_number: windowNumber,
					window_id: windowId,
					history_item_count: (turnIndex + 1) * (profile.toolsPerTurn * 2 + 3) + windowIndex,
					input_history_hash: `benchmark-input-${windowNumber}`,
					replacement_history_hash: `benchmark-replacement-${windowNumber}`,
					replacement_messages: replacementMessages,
					status: "completed",
					summary_request_fingerprint: `benchmark-summary-${windowNumber}`,
					updated_at: now,
				};
				insertHistory.run("target", `compaction:${windowId}`, JSON.stringify({
					id: `compaction:${windowId}`,
					type: "compaction_boundary",
					schema_version: 1,
					boundary_id: windowId,
					turn_id: turnId,
					source_message_count: messageIndex,
					summary,
					replacement_messages: replacementMessages,
					checkpoint,
					created_at: now,
				}));
				insertSummary.run("target", summary, now);
				saveState.run("target", JSON.stringify(checkpoint), now);
			}
		}
	})();
	database.pragma("optimize");
	database.close();
	if (storageSchema === "v9") return {};
	const normalizationVacuum = normalizeSeedDatabase(dbPath);
	if (storageSchema === "v10") return { normalizationVacuum };
	return {
		normalizationVacuum,
		contentBlobMigration: migrateSeedDatabaseToV11(dbPath),
	};
}

function seedCurrentDatabase({ dbPath, workspace, profile, storageSchema }) {
	const now = "2026-08-13T00:00:00.000Z";
	const store = storageSchema === "v12"
		? new SQLiteTranscriptEventRepository({ dbPath, clock: () => now, initializeSchemaVersion: SCHEMA_V12_VERSION })
		: storageSchema === "v13"
			? new SQLiteTranscriptEventRepository({ dbPath, clock: () => now, initializeSchemaVersion: SCHEMA_V13_VERSION })
			: openRuntimeSessionStore({ dbPath, clock: () => now });
	try {
		const compactAfterTurns = compactionTurnCounts(profile);
		for (let turnIndex = 0; turnIndex < profile.turns; turnIndex += 1) {
			const turnId = `seed-turn-${turnIndex}`;
			const clientTurnId = `seed-client-${turnIndex}`;
			const userText = `User request ${turnIndex}: ${denseText(480, turnIndex + 1)}`;
			const assistantPreamble = `Inspecting turn ${turnIndex}: ${denseText(180, turnIndex + 17)}`;
			const assistantText = `Completed turn ${turnIndex}: ${denseText(480, turnIndex + 31)}`;
			const calls = Array.from({ length: profile.toolsPerTurn }, (_value, toolIndex) => ({
				callId: `call-${turnIndex}-${toolIndex}`,
				name: toolIndex % 2 === 0 ? "Read" : "Bash",
				argumentsJson: JSON.stringify({
					target: `fixture-${turnIndex}-${toolIndex}`,
					offset: turnIndex,
				}),
			}));
			store.reserveTurn({
				sessionId: "target",
				clientTurnId,
				clientUserMessageId: clientTurnId,
				turnId,
				requestFingerprint: benchmarkFingerprint(`turn:${turnIndex}`),
				workspaceRoot: workspace,
				threadId: "target",
				userText,
				startedAt: now,
			});
			store.appendAssistantToolCalls({
				sessionId: "target",
				clientTurnId,
				assistantText: assistantPreamble,
				calls,
				responseId: `resp-seed-${turnIndex}`,
			});
			for (const [toolIndex, call] of calls.entries()) {
				store.appendToolResult({
					sessionId: "target",
					clientTurnId,
					result: {
						callId: call.callId,
						toolName: call.name,
						output: benchmarkToolOutput(profile, turnIndex, toolIndex),
						success: true,
					},
					summary: `${call.name} completed`,
				});
			}
			store.completeTurn({
				sessionId: "target",
				clientTurnId,
				assistantText,
				usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				responseId: `resp-seed-final-${turnIndex}`,
				completedAt: now,
			});

			const windowIndex = compactAfterTurns.indexOf(turnIndex + 1);
			if (windowIndex < 0) continue;
			const windowNumber = windowIndex + 1;
			const windowId = `benchmark-window-${windowNumber}`;
			const marker = windowNumber === profile.compactions
				? "LATEST_COMPACTION_SUMMARY_MARKER"
				: `OLDER_COMPACTION_SUMMARY_MARKER_${windowNumber}`;
			const summary = benchmarkCompactionSummary(
				marker,
				profile.compactionSummaryChars,
				windowNumber,
				profile.contentPattern,
			);
			const replacementText = `[compact-summary]\n${summary}`;
			store.commitCompaction({
				sessionId: "target",
				replacementMessages: [storedMessage("user", replacementText)],
				replacementItems: [{ type: "user", text: replacementText }],
				summary,
				checkpoint: {
					version: 1,
					turn_id: turnId,
					reason: "context_limit",
					phase: "pre_turn",
					window_number: windowNumber,
					window_id: windowId,
					history_item_count: (turnIndex + 1) * (profile.toolsPerTurn * 2 + 3)
						+ windowIndex,
					input_history_hash: benchmarkFingerprint(`input:${windowNumber}`),
					replacement_history_hash: benchmarkFingerprint(`replacement:${windowNumber}`),
					replacement_messages: [storedMessage("user", replacementText)],
					status: "completed",
					summary_request_fingerprint: benchmarkFingerprint(`summary:${windowNumber}`),
					updated_at: now,
				},
			});
		}
		return {};
	} finally {
		store.close();
	}
}

function benchmarkFingerprint(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeSeedDatabase(dbPath) {
	let batches = 0;
	while (true) {
		const batch = stageV9TranscriptNormalizationBatch({ dbPath, batchSize: 500 });
		batches += 1;
		if (batch.excludedActiveSessionCount > 0) {
			throw new Error("long_history_v10_seed_has_active_recovery");
		}
		if (batch.complete) break;
		if (batch.selectedSourceRowCount === 0 || batches > 100_000) {
			throw new Error("long_history_v10_seed_staging_stalled");
		}
	}
	let cutover;
	try {
		cutover = applyV9TranscriptNormalizationCutover({ dbPath });
	} catch (error) {
		const diagnostics = error && typeof error === "object" && "diagnostics" in error
			? error.diagnostics
			: {};
		throw new Error(`long_history_v10_seed_cutover_failed:${JSON.stringify(diagnostics)}`);
	}
	if (cutover.schemaVersion !== 10) throw new Error("long_history_v10_seed_cutover_failed");
	const before = physicalDatabaseMetrics(dbPath);
	const database = new Database(dbPath);
	try {
		database.exec("VACUUM");
	} finally {
		database.close();
	}
	const after = physicalDatabaseMetrics(dbPath);
	return Object.freeze({
		performed: true,
		databaseBytesBefore: before.databaseBytes,
		walBytesBefore: before.walBytes,
		databaseStorageBytesBefore: before.databaseStorageBytes,
		databaseBytesAfter: after.databaseBytes,
		walBytesAfter: after.walBytes,
		databaseStorageBytesAfter: after.databaseStorageBytes,
	});
}

function migrateSeedDatabaseToV11(dbPath) {
	const migrationStarted = performance.now();
	const dryRunStarted = performance.now();
	const dryRun = analyzeV10ContentBlobMigration({
		dbPath,
		batchSize: CONTENT_BLOB_BATCH_SIZE,
	});
	const dryRunMilliseconds = performance.now() - dryRunStarted;
	const physicalBefore = physicalDatabaseMetrics(dbPath);
	let measuredTemporaryPeakBytes = physicalBefore.databaseStorageBytes;
	let batches = 0;
	let stagedSourceRows = 0;
	let stagedReferenceCount = 0;
	const stagingStarted = performance.now();
	while (true) {
		const batch = stageV10ContentBlobMigrationBatch({
			dbPath,
			batchSize: CONTENT_BLOB_BATCH_SIZE,
		});
		batches += 1;
		stagedSourceRows += batch.selectedSourceRowCount;
		stagedReferenceCount += batch.stagedReferenceCount;
		measuredTemporaryPeakBytes = Math.max(
			measuredTemporaryPeakBytes,
			physicalDatabaseMetrics(dbPath).databaseStorageBytes,
		);
		if (batch.complete) break;
		if (batch.selectedSourceRowCount === 0 || batches > 100_000) {
			throw new Error("long_history_v11_seed_staging_stalled");
		}
	}
	const stagingMilliseconds = performance.now() - stagingStarted;
	const cutoverStarted = performance.now();
	const cutover = applyV10ContentBlobMigrationCutover({ dbPath });
	const cutoverMilliseconds = performance.now() - cutoverStarted;
	if (cutover.schemaVersion !== 11 || cutover.parityValidated !== true) {
		throw new Error("long_history_v11_seed_cutover_failed");
	}
	const physicalAfterCutover = physicalDatabaseMetrics(dbPath);
	measuredTemporaryPeakBytes = Math.max(
		measuredTemporaryPeakBytes,
		physicalAfterCutover.databaseStorageBytes,
	);

	const store = openRuntimeSessionStore({ dbPath });
	let beforeGc;
	let gc;
	let afterGc;
	let vacuum;
	const gcStarted = performance.now();
	try {
		beforeGc = store.sessionMaintenanceReport();
		gc = store.collectSessionContentBlobOrphans();
		afterGc = store.sessionMaintenanceReport();
		const gcMilliseconds = performance.now() - gcStarted;
		const physicalBeforeVacuum = physicalDatabaseMetrics(dbPath);
		const vacuumStarted = performance.now();
		vacuum = store.vacuumSessionStorage();
		const vacuumMilliseconds = performance.now() - vacuumStarted;
		store.close();
		const physicalAfterVacuum = physicalDatabaseMetrics(dbPath);
		return Object.freeze({
			dryRunMilliseconds: rounded(dryRunMilliseconds),
			stagingMilliseconds: rounded(stagingMilliseconds),
			cutoverMilliseconds: rounded(cutoverMilliseconds),
			migrationMilliseconds: rounded(performance.now() - migrationStarted),
			batchCount: batches,
			stagedSourceRows,
			stagedReferenceCount,
			headroom: Object.freeze({
				estimatedTemporaryPeakBytes: dryRun.temporarySpace.estimatedTemporaryPeakBytes,
				requiredFreeBytes: dryRun.temporarySpace.requiredFreeBytes,
				availableFreeBytes: dryRun.temporarySpace.availableFreeBytes,
				sufficientFreeSpace: dryRun.temporarySpace.sufficientFreeSpace,
			}),
			measuredTemporaryPeakBytes,
			measuredTemporaryAdditionalBytes: Math.max(
				0,
				measuredTemporaryPeakBytes - physicalBefore.databaseStorageBytes,
			),
			physicalBefore,
			physicalAfterCutover,
			cutover: Object.freeze({
				migratedTranscriptEvents: cutover.migratedTranscriptEventCount,
				migratedModelInputBlobs: cutover.migratedModelInputBlobCount,
				installedContentBlobs: cutover.installedContentBlobCount,
				installedReferences: cutover.installedReferenceCount,
				indexedEvents: cutover.indexedEventCount,
				uniqueRawBytes: cutover.uniqueRawBytes,
				storedBytes: cutover.storedBytes,
				parityValidated: cutover.parityValidated,
			}),
			gc: Object.freeze({
				milliseconds: rounded(gcMilliseconds),
				deletedBlobCount: gc.deletedBlobCount,
				deletedRawBytes: gc.deletedRawBytes,
				deletedStoredBytes: gc.deletedStoredBytes,
				freelistBytes: gc.freelistBytes,
				before: beforeGc.contentBlobs,
				after: afterGc.contentBlobs,
			}),
			vacuum: Object.freeze({
				milliseconds: rounded(vacuumMilliseconds),
				databaseBytesBefore: vacuum.beforeDbSizeBytes,
				databaseBytesAfter: vacuum.afterDbSizeBytes,
				pageCountBefore: vacuum.beforePageCount,
				pageCountAfter: vacuum.afterPageCount,
				freelistCountBefore: vacuum.beforeFreelistCount,
				freelistCountAfter: vacuum.afterFreelistCount,
				physicalBefore: physicalBeforeVacuum,
				physicalAfter: physicalAfterVacuum,
			}),
		});
	} finally {
		store.close();
	}
}

function compactionTurnCounts(profile) {
	const latest = profile.turns - profile.retainedTurns;
	return Array.from({ length: profile.compactions }, (_value, index) => (
		index === profile.compactions - 1
			? latest
			: Math.max(1, Math.floor(latest * (index + 1) / profile.compactions))
	));
}

function benchmarkCompactionSummary(marker, length, seed, contentPattern) {
	if (!Number.isSafeInteger(length) || length <= marker.length) return marker;
	const bodyLength = length - marker.length - 1;
	const body = contentPattern === "repeated_source"
		? structuredText(bodyLength, seed % 16)
		: denseText(bodyLength, seed + 50_000);
	return `${marker}\n${body}`;
}

function benchmarkToolOutput(profile, turnIndex, toolIndex) {
	if (profile.contentPattern === "repeated_source") {
		const variant = (turnIndex * profile.toolsPerTurn + toolIndex) % 16;
		return structuredText(profile.toolOutputChars, variant);
	}
	return `turn=${turnIndex};tool=${toolIndex};${denseText(
		profile.toolOutputChars - 30,
		turnIndex * profile.toolsPerTurn + toolIndex + 101,
	)}`.slice(0, profile.toolOutputChars);
}

function structuredText(length, variant) {
	const record = [
		`src/fixture_${variant}.ts:${variant + 1}`,
		`export function transform_${variant}(input: string): string {`,
		`  const normalized = input.trim().replaceAll("fixture-${variant}", "value");`,
		"  return normalized.length === 0 ? \"empty\" : normalized;",
		"}",
		`test transform_${variant}: passed duration_ms=${variant + 3}`,
	].join("\n");
	let output = "";
	while (output.length < length) output += `${record}\n`;
	return output.slice(0, length);
}

function storedMessage(role, content) {
	return {
		role,
		content,
		tool_call_id: null,
		response_id: null,
		metadata: {},
		blocks: [],
		tool_calls: [],
	};
}

function inspectDatabase(dbPath) {
	const database = new Database(dbPath, { readonly: true });
	try {
		const storageSchemaVersion = Number(database.prepare(
			"SELECT version FROM schema_version",
		).get().version);
		const transcriptTables = storageSchemaVersion >= 10
			? ["transcript_events"]
			: ["conversation_messages", "history_items", "turn_rollouts"];
		const transcriptTableRows = Object.fromEntries(transcriptTables.map((table) => [
			table,
			Number(database.prepare(
				`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = 'target'`,
			).get().count),
		]));
		const transcriptTablePayloadBytes = Object.fromEntries(transcriptTables.map((table) => [
			table,
			Number(database.prepare(`
				SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
				FROM ${table} WHERE session_id = 'target'
			`).get().bytes),
		]));
		const boundary = storageSchemaVersion >= 10
			? Number(database.prepare(`
				SELECT COUNT(*) AS count FROM transcript_events
				WHERE session_id = 'target' AND event_type = 'compaction'
			`).get().count)
			: Number(database.prepare(`
				SELECT COUNT(*) AS count FROM history_items
				WHERE session_id = 'target'
				  AND json_extract(payload_json, '$.type') = 'compaction_boundary'
			`).get().count);
		const physical = physicalDatabaseMetrics(dbPath);
		const pageSize = Number(database.pragma("page_size", { simple: true }));
		const freelistCount = Number(database.pragma("freelist_count", { simple: true }));
		const transcriptPayloadBytes = Object.values(transcriptTablePayloadBytes)
			.reduce((total, value) => total + value, 0);
		const modelInput = database.prepare(`
			SELECT COUNT(*) AS count,
			       COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS payload_bytes
			FROM model_input_blobs
		`).get();
		const modelInputPayloadBytes = Number(modelInput.payload_bytes);
		const manifestColumns = new Set(database.prepare(`
			PRAGMA table_info(provider_request_manifests)
		`).all().map((row) => row.name));
		const providerLedger = Object.freeze({
			providerStepCount: Number(database.prepare(`
				SELECT COUNT(*) AS count FROM provider_request_manifests
			`).get().count),
			requestHashRows: Number(database.prepare(`
				SELECT COUNT(*) AS count FROM provider_request_manifests
				WHERE length(logical_request_sha256) = 64
			`).get().count),
			logicalRequestBlobOwnershipCount: manifestColumns.has("logical_request_blob_id")
				? Number(database.prepare(`
					SELECT COUNT(*) AS count FROM provider_request_manifests
					WHERE logical_request_blob_id IS NOT NULL
				`).get().count)
				: 0,
			databaseBytes: physical.databaseStorageBytes,
		});
		const contentBlobs = storageSchemaVersion >= 11
			? inspectContentBlobs(database)
			: emptyContentBlobMetrics();
		const inlineEnvelopeBytes = transcriptPayloadBytes + modelInputPayloadBytes;
		return {
			storageSchemaVersion,
			dbSizeBytes: physical.databaseBytes,
			walSizeBytes: physical.walBytes,
			databaseStorageBytes: physical.databaseStorageBytes,
			pageSize,
			freelistCount,
			freelistBytes: pageSize * freelistCount,
			transcriptRows: Object.values(transcriptTableRows)
				.reduce((total, value) => total + value, 0),
			transcriptPayloadBytes,
			transcriptTableRows,
			transcriptTablePayloadBytes,
			modelInputRows: Number(modelInput.count),
			modelInputPayloadBytes,
			providerLedger,
			contentBlobs,
			payloadStorage: Object.freeze({
				inlineEnvelopeBytes,
				logicalRawBytes: inlineEnvelopeBytes + contentBlobs.logicalReferenceBytes,
				uniqueRawBytes: contentBlobs.reachableRawBytes,
				uniqueStoredBytes: contentBlobs.reachableStoredBytes,
				logicalReferenceBytes: contentBlobs.logicalReferenceBytes,
				deduplicatedReferenceBytes: contentBlobs.deduplicatedReferenceBytes,
				referenceMetadataBytes: contentBlobs.referenceMetadataBytes,
				payloadStorageBytes: inlineEnvelopeBytes
					+ contentBlobs.reachableStoredBytes + contentBlobs.referenceMetadataBytes,
			}),
			compactionBoundaries: boundary,
		};
	} finally {
		database.close();
	}
}

function inspectContentBlobs(database) {
	const row = database.prepare(`
		WITH all_references(blob_id) AS (
			SELECT blob_id FROM transcript_event_blob_refs
			UNION ALL
			SELECT content_blob_id FROM model_input_blob_refs
		), reachable(blob_id) AS (
			SELECT DISTINCT blob_id FROM all_references
		)
		SELECT
			COUNT(*) AS blob_count,
			(SELECT COUNT(*) FROM all_references) AS reference_count,
			(SELECT COUNT(*) FROM transcript_event_blob_refs) AS transcript_reference_count,
			(SELECT COUNT(*) FROM model_input_blob_refs) AS model_input_reference_count,
			COALESCE(SUM(CASE WHEN reachable.blob_id IS NOT NULL THEN 1 ELSE 0 END), 0)
				AS reachable_blob_count,
			COALESCE(SUM(CASE WHEN reachable.blob_id IS NOT NULL THEN raw_bytes ELSE 0 END), 0)
				AS reachable_raw_bytes,
			COALESCE(SUM(CASE WHEN reachable.blob_id IS NOT NULL THEN stored_bytes ELSE 0 END), 0)
				AS reachable_stored_bytes,
			COALESCE((
				SELECT SUM(content.raw_bytes)
				FROM all_references AS reference
				JOIN session_content_blobs AS content ON content.blob_id = reference.blob_id
			), 0) AS logical_reference_bytes,
			COALESCE(SUM(CASE WHEN reachable.blob_id IS NULL THEN 1 ELSE 0 END), 0)
				AS orphan_blob_count,
			COALESCE(SUM(CASE WHEN reachable.blob_id IS NULL THEN raw_bytes ELSE 0 END), 0)
				AS orphan_raw_bytes,
			COALESCE(SUM(CASE WHEN reachable.blob_id IS NULL THEN stored_bytes ELSE 0 END), 0)
				AS orphan_stored_bytes
		FROM session_content_blobs AS content
		LEFT JOIN reachable ON reachable.blob_id = content.blob_id
	`).get();
	const referenceMetadataBytes = Number(database.prepare(`
		SELECT COALESCE((
			SELECT SUM(length(CAST(json_pointer AS BLOB)) + length(CAST(blob_id AS BLOB)))
			FROM transcript_event_blob_refs
		), 0) + COALESCE((
			SELECT SUM(length(CAST(blob_id AS BLOB)) + length(CAST(content_blob_id AS BLOB)))
			FROM model_input_blob_refs
		), 0) AS bytes
	`).get().bytes);
	const reachableRawBytes = Number(row.reachable_raw_bytes);
	const logicalReferenceBytes = Number(row.logical_reference_bytes);
	return Object.freeze({
		available: true,
		blobCount: Number(row.blob_count),
		referenceCount: Number(row.reference_count),
		transcriptReferenceCount: Number(row.transcript_reference_count),
		modelInputReferenceCount: Number(row.model_input_reference_count),
		reachableBlobCount: Number(row.reachable_blob_count),
		reachableRawBytes,
		reachableStoredBytes: Number(row.reachable_stored_bytes),
		logicalReferenceBytes,
		deduplicatedReferenceBytes: logicalReferenceBytes - reachableRawBytes,
		referenceMetadataBytes,
		orphanBlobCount: Number(row.orphan_blob_count),
		orphanRawBytes: Number(row.orphan_raw_bytes),
		orphanStoredBytes: Number(row.orphan_stored_bytes),
	});
}

function emptyContentBlobMetrics() {
	return Object.freeze({
		available: false,
		blobCount: 0,
		referenceCount: 0,
		transcriptReferenceCount: 0,
		modelInputReferenceCount: 0,
		reachableBlobCount: 0,
		reachableRawBytes: 0,
		reachableStoredBytes: 0,
		logicalReferenceBytes: 0,
		deduplicatedReferenceBytes: 0,
		referenceMetadataBytes: 0,
		orphanBlobCount: 0,
		orphanRawBytes: 0,
		orphanStoredBytes: 0,
	});
}

function transcriptWriteDelta(before, after) {
	const tables = new Set([
		...Object.keys(before.transcriptTableRows),
		...Object.keys(after.transcriptTableRows),
	]);
	return {
		rows: after.transcriptRows - before.transcriptRows,
		payloadBytes: after.transcriptPayloadBytes - before.transcriptPayloadBytes,
		databaseStorageBytes: after.databaseStorageBytes - before.databaseStorageBytes,
		rowsByTable: Object.fromEntries([...tables].map((table) => [
			table,
			(after.transcriptTableRows[table] ?? 0) - (before.transcriptTableRows[table] ?? 0),
		])),
		payloadBytesByTable: Object.fromEntries([...tables].map((table) => [
			table,
			(after.transcriptTablePayloadBytes[table] ?? 0)
				- (before.transcriptTablePayloadBytes[table] ?? 0),
		])),
	};
}

function optionalFileSize(path) {
	try {
		return statSync(path).size;
	} catch (error) {
		if (error?.code === "ENOENT") return 0;
		throw error;
	}
}

function physicalDatabaseMetrics(dbPath) {
	const databaseBytes = statSync(dbPath).size;
	const walBytes = optionalFileSize(`${dbPath}-wal`);
	const shmBytes = optionalFileSize(`${dbPath}-shm`);
	const journalBytes = optionalFileSize(`${dbPath}-journal`);
	return Object.freeze({
		databaseBytes,
		walBytes,
		shmBytes,
		journalBytes,
		databaseStorageBytes: databaseBytes + walBytes + shmBytes + journalBytes,
	});
}

function inspectSemanticProjections(dbPath, workspaceRoot, fixtureRoot) {
	const store = openRuntimeSessionStore({ dbPath });
	try {
		const search = store.searchMessages("Completed", {
			workspaceRoot,
			limit: 100,
		});
		const manifest = store.modelInputLedger.loadLatestProviderRequestManifest("target");
		if (!manifest) throw new Error("long_history_provider_manifest_missing");
		const reconstructed = store.modelInputLedger.reconstructProviderStep(manifest.requestId);
		return Object.freeze({
			searchResultCount: search.length,
			searchSha256: sha256Json(search),
			ledgerReconstructed: true,
			ledgerRequestSha256: sha256Json(withoutPromptCacheKeys(
				reconstructed.request,
				fixtureRoot,
			)),
		});
	} finally {
		store.close();
	}
}

function sha256Json(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function withoutPromptCacheKeys(value, fixtureRoot) {
	if (typeof value === "string") return value.replaceAll(fixtureRoot, "<benchmark-root>");
	if (Array.isArray(value)) return value.map((item) => withoutPromptCacheKeys(item, fixtureRoot));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (
		key === "promptCacheKey" || key === "prompt_cache_key"
			? []
			: [[key, withoutPromptCacheKeys(item, fixtureRoot)]]
	)));
}

async function startProviderServer(fixtureRoot) {
	const child = spawn(process.execPath, [fileURLToPath(SERVER_URL)], {
		env: { ...process.env, MYCLI_BENCHMARK_ROOT: fixtureRoot },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const requests = [];
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	let resolveReady;
	let rejectReady;
	const ready = new Promise((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	lines.on("line", (line) => {
		const message = JSON.parse(line);
		if (message.type === "ready") resolveReady(message.port);
		if (message.type === "request") requests.push(message.stats);
	});
	child.once("error", rejectReady);
	child.once("exit", (code) => {
		if (code !== 0 && code !== null) rejectReady(new Error(
			`benchmark_provider_server_failed:${code}:${stderr.length}`,
		));
	});
	const port = await ready;
	return {
		port,
		requests,
		close: async () => {
			if (child.exitCode !== null) return;
			child.kill("SIGTERM");
			await new Promise((resolve) => child.once("exit", resolve));
		},
	};
}

function startMemorySampler() {
	let peak = memorySnapshot("peak");
	const timer = setInterval(() => {
		const current = memorySnapshot("peak");
		peak = {
			label: "peak",
			rss: Math.max(peak.rss, current.rss),
			heapUsed: Math.max(peak.heapUsed, current.heapUsed),
			heapTotal: Math.max(peak.heapTotal, current.heapTotal),
			external: Math.max(peak.external, current.external),
			arrayBuffers: Math.max(peak.arrayBuffers, current.arrayBuffers),
		};
	}, SAMPLE_INTERVAL_MS);
	return {
		snapshot: () => ({ ...peak }),
		stop: () => clearInterval(timer),
	};
}

function memorySnapshot(label) {
	const usage = process.memoryUsage();
	return { label, ...usage };
}

function denseText(length, seed) {
	let state = seed >>> 0;
	let output = "";
	while (output.length < length) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		output += TOOL_OUTPUT_ALPHABET[Math.abs(state) % TOOL_OUTPUT_ALPHABET.length];
	}
	return output;
}

function writeRequest(backend, id, method, params) {
	backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function findEvent(messages, method, clientTurnId) {
	return messages.find(({ message }) => message.method === method
		&& !("id" in message)
		&& (clientTurnId === undefined || message.params?.client_turn_id === clientTurnId));
}

function findResponse(messages, id) {
	return messages.find(({ message }) => String(message.id) === id);
}

function assertSuccessfulResponse(message, method) {
	if (message.error) throw new Error(`${method}_failed:${JSON.stringify(message.error)}`);
}

function assertResumeSemantics({
	profile,
	storageSchema,
	transcriptItems,
	providerRequests,
	compactionStarted,
	compactionCompleted,
}) {
	const turnRequests = providerRequests.filter((request) => request.kind === "provider_turn");
	if (providerRequests.some((request) => request.kind === "compaction_summary")
		|| compactionStarted !== undefined
		|| compactionCompleted !== undefined) {
		throw new Error("resume_triggered_unexpected_compaction");
	}
	if (turnRequests.length !== 1) throw new Error("resume_provider_request_count_mismatch");
	const request = turnRequests[0];
	if (request.latestCompactionSummaryPresent !== true || request.oldestTurnPresent === true) {
		throw new Error("resume_did_not_use_latest_compaction_window");
	}
	if (profile.memoryEnabled === true && request.oldestCompactionSummaryPresent === true) {
		throw new Error("resume_loaded_unbounded_session_summaries");
	}
	const expectedToolItems = profile.retainedTurns * profile.toolsPerTurn;
	if (request.functionCalls !== expectedToolItems
		|| request.functionCallOutputs !== expectedToolItems) {
		throw new Error("resume_provider_tool_window_mismatch");
	}
	const expectedTranscriptItems = profile.turns * (
		profile.toolsPerTurn + (TIMELINE_STORAGE_SCHEMAS.has(storageSchema) ? 4 : 3)
	);
	if (transcriptItems.length !== expectedTranscriptItems) {
		throw new Error("resume_transcript_projection_count_mismatch");
	}
	if (TIMELINE_STORAGE_SCHEMAS.has(storageSchema)) {
		const counts = Object.fromEntries([
			"user",
			"assistant_final",
			"tool_summary",
			"turn_completed",
		].map((type) => [
			type,
			transcriptItems.filter((item) => item.type === type).length,
		]));
		if (counts.user !== profile.turns
			|| counts.assistant_final !== profile.turns * 2
			|| counts.tool_summary !== profile.turns * profile.toolsPerTurn
			|| counts.turn_completed !== profile.turns) {
			throw new Error("resume_transcript_projection_type_mismatch");
		}
	}
	const transcriptJson = JSON.stringify(transcriptItems);
	if (!transcriptJson.includes("User request 0:")
		|| !transcriptJson.includes(`Completed turn ${profile.turns - 1}:`)
		|| transcriptJson.includes("COMPACTION_SUMMARY_MARKER")) {
		throw new Error("resume_transcript_filter_mismatch");
	}
}

function arrayResult(message, key) {
	return Array.isArray(message.result?.[key]) ? message.result[key] : [];
}

function stringParam(entry, key) {
	return typeof entry?.message.params?.[key] === "string" ? entry.message.params[key] : undefined;
}

function eventOffset(entry, origin) {
	return entry ? rounded(entry.epochMilliseconds - origin) : undefined;
}

function requestOffset(request, origin) {
	return request ? rounded(request.firstByteEpochMilliseconds - origin) : undefined;
}

function rounded(value) {
	return Math.round(value * 100) / 100;
}

async function waitFor(read, timeoutMs = REQUEST_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await delay(5);
	}
	throw new Error("long_history_benchmark_timeout");
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

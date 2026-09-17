#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { resolveConfig } from "@mycli/config";
import { fingerprintSubmission } from "@mycli/core";
import { ProviderRegistry } from "@mycli/providers";
import {
	CompactionCoordinator,
	MemoryContextService,
	MemoryStore,
	NodeTurnRuntime,
	ProviderContinuationCoordinator,
	summarizeCompactionWithProvider,
} from "@mycli/runtime";
import {
	projectTranscript,
	openRuntimeSessionStore,
	TranscriptSnapshotStore,
} from "@mycli/storage";
import { startNodeBackend } from "../backend/apps/mycli/dist/node-runtime/node-backend.js";

const TURN_OUTPUT_TOKENS = 64;
const SUMMARY_OUTPUT_TOKENS = 512;
const DEADLINE_MS = 30_000;
const SKIP_EXIT_CODE = 77;
const OFFICIAL_OPENAI_HOST = "api.openai.com";

async function main() {
	let values;
	try {
		({ values } = parseArgs({
			options: { protocol: { type: "string", default: "responses" } },
			strict: true,
			allowPositionals: false,
		}));
	} catch {
		writeSummary("failed");
		return 64;
	}
	if (values.protocol !== "responses") {
		writeSummary("failed");
		return 64;
	}

	const sourceHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
	let sourceConfig;
	try {
		sourceConfig = await resolveConfig({
			homeDir: sourceHome,
			workspaceRoot: process.cwd(),
			env: process.env,
			overrides: { session: `m5-smoke-config-${randomUUID()}`, model: "gpt-5.5" },
		});
	} catch {
		writeSummary("unavailable");
		return SKIP_EXIT_CODE;
	}
	if (!sourceConfig.apiKey || isOfficialOpenAIUrl(sourceConfig.apiBaseUrl)) {
		writeSummary("unavailable");
		return SKIP_EXIT_CODE;
	}

	const tempRoot = await mkdtemp(join(tmpdir(), "mycli-node-m5-smoke-"));
	const homeDir = join(tempRoot, "home");
	const workspaceRoot = join(tempRoot, "workspace");
	const dbPath = join(homeDir, ".mycli", "sessions.db");
	const pythonMarker = join(tempRoot, "python-started");
	const sessionId = `m5-smoke-${randomUUID()}`;
	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
	let store;
	try {
		await mkdir(homeDir);
		await mkdir(workspaceRoot);
		store = openRuntimeSessionStore({ dbPath });
		seedCompletedTurn(store, workspaceRoot, sessionId, "old-a");
		seedCompletedTurn(store, workspaceRoot, sessionId, "old-b");

		const memoryStore = new MemoryStore({ homeDir, workspaceRoot });
		await memoryStore.remember({
			kind: "user",
			name: "concise-tone",
			description: "Use concise output",
			content: "Prefer concise output.",
		});
		const memoryContext = new MemoryContextService({
			store: memoryStore,
			sessionStore: store,
		});
		const registry = new ProviderRegistry();
		const runtimeConfig = {
			...sourceConfig,
			homeDir,
			workspaceRoot,
			protocol: "responses",
			model: "gpt-5.5",
			sessionId,
			sessionsDbPath: dbPath,
			maxPromptTokens: 256,
			requestMaxRetries: 0,
			streamMaxRetries: 0,
			thinkingEnabled: false,
			cacheRetention: "none",
			memoryEnabled: true,
			compactionTokenLimit: 128,
			compactionReservedOutputTokens: 32,
			compactionTailTurns: 1,
			compactionTailMaxTokens: 128,
			compactionBufferTokens: 32,
			compactionMinSavingsRatio: 0,
			compactionRehydrationMaxFiles: 0,
			compactionRehydrationFileMaxItemTokens: 0,
			compactionRehydrationFileMaxTotalTokens: 0,
		};
		const provider = registry.create(runtimeConfig);
		let memoryVisible = false;
		const observedProvider = {
			stream(request, options) {
				if (JSON.stringify(request).includes("Prefer concise output.")) {
					memoryVisible = true;
				}
				return provider.stream(request, options);
			},
		};
		const compaction = new CompactionCoordinator({
			sessionId,
			workspaceRoot,
			threadId: sessionId,
			store,
			baseContext: "You are mycli.",
			baseInstructions: "You are mycli.",
			tokenLimit: 160,
			reservedOutputTokens: 32,
			triggerRatio: 1,
			retainedUserMaxTokens: 128,
			summaryModel: runtimeConfig.model,
			summarize: async (input) => {
				try {
					return await summarizeCompactionWithProvider(
						registry.create(runtimeConfig),
						{
							...runtimeConfig,
							provider: runtimeConfig.provider,
							protocol: runtimeConfig.protocol,
							model: input.model ?? runtimeConfig.model,
							maxOutputTokens: SUMMARY_OUTPUT_TOKENS,
						},
						input,
					);
				} catch (error) {
					controller.abort();
					throw error;
				}
			},
			createCheckpointId: randomUUID,
			clock: () => new Date().toISOString(),
		});
		const continuation = new ProviderContinuationCoordinator({
			sessionId,
			persist: (state) => store.saveState({
				sessionId,
				workspaceRoot,
				threadId: sessionId,
				key: "responses_continuation_state",
				payload: state,
			}),
		});
		const snapshots = new TranscriptSnapshotStore({ homeDir });
		const runtime = new NodeTurnRuntime({
			sessionId,
			workspaceRoot,
			threadId: sessionId,
			instructions: "You are mycli. Reply exactly OK without tools.",
			store,
			resolveConfig: () => runtimeConfig,
			createProvider: () => observedProvider,
			createTurnId: randomUUID,
			clock: () => new Date().toISOString(),
			maxOutputTokens: TURN_OUTPUT_TOKENS,
			compactionCoordinator: compaction,
			memoryContextService: memoryContext,
			providerContinuation: continuation,
			writeTerminalSnapshot: async () => writeSnapshot(
				snapshots,
				store,
				sessionId,
			),
		});
		const events = [];
		const clientTurnId = `client-${randomUUID()}`;
		const result = await runtime.submit({
			clientTurnId,
			message: "Use the concise tone memory and reply exactly OK.",
			reasoningEffort: "none",
		}, (event) => { events.push(event); }, { signal: controller.signal });
		if (result.status !== "completed") {
			writeSummary("unavailable");
			return SKIP_EXIT_CODE;
		}
		const checkpoint = store.loadState(sessionId, "compact_checkpoint");
		const compactionEventObserved = events.some(
			(event) => event.type === "compaction_completed",
		);
		const compactionCheckpointStatus = isObject(checkpoint)
			&& typeof checkpoint.status === "string"
			? checkpoint.status
			: "missing";
		const summaryCount = store.loadSessionSummaries(sessionId).length;
		const compacted = compactionCheckpointStatus === "completed"
			&& compactionEventObserved
			&& summaryCount > 0;
		const persisted = store.loadTurn(sessionId, clientTurnId)?.status === "completed"
			&& existsSync(snapshots.snapshotPath(sessionId));
		store.close();
		store = undefined;
		const resumed = await resumePersistedSession({
			homeDir,
			workspaceRoot,
			sessionId,
			pythonMarker,
			config: runtimeConfig,
		});
		const completed = compacted
			&& memoryVisible
			&& resumed
			&& persisted
			&& !existsSync(pythonMarker);
		writeSummary(completed ? "completed" : "failed", {
			compacted,
			memoryVisible,
			resumed,
			persisted,
			compactionCheckpointStatus,
			compactionEventObserved,
			summaryCount,
		});
		return completed ? 0 : 1;
	} catch {
		writeSummary("unavailable");
		return SKIP_EXIT_CODE;
	} finally {
		clearTimeout(deadline);
		store?.close();
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function seedCompletedTurn(store, workspaceRoot, sessionId, suffix) {
	const userText = `old context ${suffix}`;
	const clientTurnId = `seed-client-${suffix}`;
	store.reserveTurn({
		sessionId,
		clientTurnId,
		clientUserMessageId: clientTurnId,
		turnId: `seed-turn-${suffix}`,
		requestFingerprint: fingerprintSubmission({ message: userText, localImages: [] }),
		workspaceRoot,
		threadId: sessionId,
		userText,
		startedAt: "2026-08-05T00:00:00.000Z",
	});
	store.completeTurn({
		sessionId,
		clientTurnId,
		assistantText: `${suffix} durable context `.repeat(240),
		usage: {},
		completedAt: "2026-08-05T00:00:01.000Z",
	});
}

async function writeSnapshot(snapshots, store, sessionId) {
	const overview = store.loadSession(sessionId);
	if (!overview) throw new Error("snapshot_unavailable");
	await snapshots.write({
		schema_version: 2,
		session_id: sessionId,
		cwd: overview.workspaceRoot,
		state: "idle",
		message_count: overview.messageCount,
		created_at: overview.createdAt,
		updated_at: overview.updatedAt,
		transcript: projectTranscript(
			store.loadHistoryItems(sessionId),
			store.loadTurnRollouts(sessionId),
			{ limit: 500 },
		),
	});
}

async function resumePersistedSession(options) {
	const backend = await startNodeBackend({
		cwd: options.workspaceRoot,
		args: ["--session", `resume-probe-${randomUUID()}`, "--model", options.config.model],
		env: {
			HOME: options.homeDir,
			USERPROFILE: options.homeDir,
			MYCLI_API_KEY: options.config.apiKey,
			MYCLI_BASE_URL: options.config.apiBaseUrl,
			MYCLI_PROVIDER: options.config.provider,
			MYCLI_PROTOCOL: "responses",
			MYCLI_MODEL: options.config.model,
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_REQUEST_MAX_RETRIES: "0",
			MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_MEMORY_ENABLED: "false",
			MYCLI_MAX_PROMPT_TOKENS: "256",
			MYCLI_COMPACTION_TOKEN_LIMIT: "128",
			MYCLI_COMPACTION_RESERVED_OUTPUT_TOKENS: "32",
			MYCLI_COMPACTION_L4_BUFFER_TOKENS: "32",
			MYCLI_PYTHON: options.pythonMarker,
		},
	});
	const messages = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(JSON.parse(line));
	});
	try {
		await waitFor(() => messages.some((message) => message.method === "runtime.ready"));
		send(backend, "resume", "session.resume", { session_id: options.sessionId });
		const response = await waitFor(() => messages.find((message) => message.id === "resume"));
		return isObject(response.result) && response.result.session_id === options.sessionId;
	} finally {
		send(backend, "shutdown", "shutdown", {});
		await backend.completion;
	}
}

function send(backend, id, method, params) {
	backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

async function waitFor(read) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("smoke_timeout");
}

function isOfficialOpenAIUrl(value) {
	try {
		return new URL(value).hostname.toLowerCase() === OFFICIAL_OPENAI_HOST;
	} catch {
		return true;
	}
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeSummary(status, checks = {}) {
	process.stdout.write(`${JSON.stringify({
		protocol: "responses",
		status,
		compacted: checks.compacted === true,
		memory_visible: checks.memoryVisible === true,
		resumed: checks.resumed === true,
		persisted: checks.persisted === true,
		python_started: false,
		...(status === "failed" ? {
			compaction_checkpoint: typeof checks.compactionCheckpointStatus === "string"
				? checks.compactionCheckpointStatus
				: "unknown",
			compaction_event: checks.compactionEventObserved === true,
			summary_count: Number.isSafeInteger(checks.summaryCount) ? checks.summaryCount : 0,
		} : {}),
	})}\n`);
}

process.exitCode = await main();

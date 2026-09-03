import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parseJsonRpcMessage, type RuntimeStateRecord } from "@mycli/contracts";
import { fingerprintSubmission } from "@mycli/core";
import { MemoryStore } from "@mycli/runtime";
import { openRuntimeSessionStore, type RuntimeSessionStore } from "@mycli/storage";
import type { NodeBackend } from "../src/node-runtime/node-backend.ts";
import { startTestNodeBackend as startNodeBackend } from "./support/offline-update-fetch.ts";
import {
	responsesAuthorityText,
	responsesTextEvents,
} from "./support/responses-sse.ts";

type Protocol = "responses" | "chat_completions";
type JsonObject = Record<string, unknown>;

const ROOT = new URL("../../../../", import.meta.url);

test("Worker-backed Responses root compacts, injects memory, resumes, and completes", async (t) => {
	const paths = await scenarioPaths(t, "responses");
	const store = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		seedCompletedTurn(store, paths.workspace, paths.sessionId, "old-a", longText("alpha"));
		seedCompletedTurn(store, paths.workspace, paths.sessionId, "old-b", longText("beta"));
	} finally {
		store.close();
	}
	await new MemoryStore({ homeDir: paths.home, workspaceRoot: paths.workspace }).remember({
		kind: "user",
		name: "tone",
		description: "Preferred answer style",
		content: "Prefer concise output.",
	});
	const provider = await providerFixture(t, (body, index) => {
		const instructions = responsesAuthorityText(body);
		if (instructions.includes("select memory files")) {
			return responsesFinal(JSON.stringify({ selected_memories: ["tone.md"] }), `selector-${index}`);
		}
		if (instructions.includes("Summarize the supplied conversation")) {
			return responsesFinal("Earlier turns established the compacted baseline.", `summary-${index}`);
		}
		return responsesFinal("M5 completed.", `turn-${index}`);
	});
	const first = await startBackend(paths, provider.baseUrl, {
		MYCLI_MEMORY_ENABLED: "true",
		MYCLI_MAX_PROMPT_TOKENS: "16000",
		MYCLI_COMPACTION_TOKEN_LIMIT: "128",
		MYCLI_COMPACTION_RESERVED_OUTPUT_TOKENS: "32",
		MYCLI_COMPACTION_TAIL_TURNS: "1",
		MYCLI_COMPACTION_TAIL_MAX_TOKENS: "128",
		MYCLI_COMPACTION_L4_BUFFER_TOKENS: "32",
		MYCLI_COMPACTION_L4_MIN_SAVINGS_RATIO: "0",
		MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
	});
	t.after(() => first.close());

	send(first.backend, "turn", "turn.submit", {
		message: "Continue this session using the preferred tone.",
		client_turn_id: "m5-responses-turn",
		client_user_message_id: "m5-responses-user",
	});
	await waitForFinal(first.messages, "m5-responses-turn");
	assert.equal(events(first.messages, "compaction.started").length, 1);
	assert.equal(events(first.messages, "compaction.completed").length, 1);
	assert.equal(provider.requests.filter((request) => (
		responsesAuthorityText(request.body).includes("select memory files")
	)).length, 0);
	assert.equal(provider.requests.length, 2);
	const summaryRequest = provider.requests.find((request) => (
		responsesAuthorityText(request.body).includes("Summarize the supplied conversation")
	));
	assert.equal(summaryRequest?.body.max_output_tokens, 4_096);
	const mainRequest = provider.requests.find((request) => (
		responsesAuthorityText(request.body).startsWith("# Identity\n")
	));
	assert.ok(mainRequest);
	assert.match(JSON.stringify(mainRequest.body.input), /Prefer concise output\./u);
	assert.match(JSON.stringify(mainRequest.body.input), /\[compact-summary\]/u);
	assert.equal(existsSync(paths.pythonMarker), false);
	await first.close();

	const persisted = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		const checkpoint = persisted.loadState(paths.sessionId, "compact_checkpoint") as JsonObject;
		assert.equal(checkpoint.status, "completed");
		assert.equal(persisted.loadSessionSummaries(paths.sessionId).length, 1);
		assert.equal(persisted.loadTurn(paths.sessionId, "m5-responses-turn")?.status, "completed");
	} finally {
		persisted.close();
	}
	assert.equal(existsSync(join(
		paths.home,
		".mycli",
		"sessions",
		paths.sessionId,
		"session.json",
	)), true);

	const restarted = await startBackend(
		{ ...paths, sessionId: "m5-responses-restart" },
		provider.baseUrl,
		{
			MYCLI_MEMORY_ENABLED: "false",
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
		},
	);
	t.after(() => restarted.close());
	send(restarted.backend, "resume", "session.resume", { session_id: paths.sessionId });
	const resumed = await waitFor(() => rpcResponse(restarted.messages, "resume"));
	assert.equal(resultValue(resumed, "session_id"), paths.sessionId);
	assert.ok(sessionEvent(restarted.messages, "session.changed", paths.sessionId));
	assert.equal(existsSync(paths.pythonMarker), false);
	await restarted.close();
});

test("queued input survives restart and drains automatically in durable order", async (t) => {
	const paths = await scenarioPaths(t, "queue");
	const seed = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		seed.saveState({
			sessionId: paths.sessionId,
			workspaceRoot: paths.workspace,
			threadId: paths.sessionId,
			key: "input_queue",
			payload: queuePayload(paths.sessionId, [{
				queueId: "queue-steer",
				clientTurnId: "m5-steer",
				kind: "rejected_steer",
				text: "defer this steer",
			}, {
				queueId: "queue-follow",
				clientTurnId: "m5-follow",
				kind: "follow_up",
				text: "run this next",
			}]),
		});
	} finally {
		seed.close();
	}
	const provider = await providerFixture(t, (_body, index) => (
		responsesFinal(`Queued turn ${index} completed.`, `queue-${index}`)
	));
	const restarted = await startBackend(paths, provider.baseUrl, {
		MYCLI_MEMORY_ENABLED: "false",
	});
	t.after(() => restarted.close());
	await waitForFinal(restarted.messages, "m5-steer");
	await waitForFinal(restarted.messages, "m5-follow");

	assert.equal(provider.requests.length, 2);
	assert.match(JSON.stringify(provider.requests[0]?.body.input), /defer this steer/u);
	assert.match(JSON.stringify(provider.requests[1]?.body.input), /run this next/u);
	const persisted = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		const queue = persisted.loadState(paths.sessionId, "input_queue") as JsonObject;
		assert.deepEqual(queue.rejected_steers, []);
		assert.deepEqual(queue.follow_ups, []);
		assert.deepEqual([...persisted.loadCommittedQueueIds(paths.sessionId)], [
			"queue-steer",
			"queue-follow",
		]);
	} finally {
		persisted.close();
	}
	assert.equal(existsSync(paths.pythonMarker), false);
	await restarted.close();
});

test("restart releases orphaned queue claims and retires committed claims", async (t) => {
	await t.test("orphaned claim", async (subtest) => {
		const paths = await scenarioPaths(subtest, "queue-claim-orphan");
		const seed = openRuntimeSessionStore({ dbPath: paths.dbPath });
		try {
			seed.saveState({
				sessionId: paths.sessionId,
				workspaceRoot: paths.workspace,
				threadId: paths.sessionId,
				key: "input_queue",
				payload: queuePayload(paths.sessionId, [{
					queueId: "queue-orphan",
					clientTurnId: "client-orphan",
					kind: "follow_up",
					state: "claimed",
					claimTurnId: "turn-abandoned",
					text: "recover orphaned claim",
				}]),
			});
		} finally {
			seed.close();
		}
		const provider = await providerFixture(subtest, (_body, index) => (
			responsesFinal("Orphan recovered.", `orphan-${index}`)
		));
		const backend = await startBackend(paths, provider.baseUrl, {
			MYCLI_MEMORY_ENABLED: "false",
		});
		subtest.after(() => backend.close());
		await waitForFinal(backend.messages, "client-orphan");
		assert.equal(provider.requests.length, 1);
		assert.match(JSON.stringify(provider.requests[0]?.body.input), /recover orphaned claim/u);
		await backend.close();
	});

	await t.test("committed claim", async (subtest) => {
		const paths = await scenarioPaths(subtest, "queue-claim-committed");
		const seed = openRuntimeSessionStore({ dbPath: paths.dbPath });
		try {
			seed.saveState({
				sessionId: paths.sessionId,
				workspaceRoot: paths.workspace,
				threadId: paths.sessionId,
				key: "input_queue",
				payload: queuePayload(paths.sessionId, [{
					queueId: "queue-committed",
					clientTurnId: "client-committed",
					kind: "follow_up",
					state: "claimed",
					claimTurnId: "turn-committed",
					text: "already committed",
				}]),
			});
			seed.reserveTurn({
				sessionId: paths.sessionId,
				clientTurnId: "client-committed",
				clientUserMessageId: "client-committed",
				turnId: "turn-committed",
				requestFingerprint: fingerprintSubmission({ message: "already committed" }),
				workspaceRoot: paths.workspace,
				threadId: paths.sessionId,
				userText: "already committed",
				queueId: "queue-committed",
				inputSource: "submit",
				startedAt: "2026-08-05T00:00:00.000Z",
			});
		} finally {
			seed.close();
		}
		const provider = await providerFixture(subtest, (_body, index) => (
			responsesFinal("Must not run.", `committed-${index}`)
		));
		const backend = await startBackend(paths, provider.baseUrl, {
			MYCLI_MEMORY_ENABLED: "false",
		});
		subtest.after(() => backend.close());
		await waitFor(() => event(backend.messages, "runtime.ready"));
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(provider.requests.length, 0);
		await backend.close();

		const persisted = openRuntimeSessionStore({ dbPath: paths.dbPath });
		try {
			const queue = persisted.loadState(paths.sessionId, "input_queue") as JsonObject;
			assert.deepEqual(queue.follow_ups, []);
			assert.equal(persisted.loadTurn(paths.sessionId, "client-committed")?.status, "interrupted");
			assert.equal([...persisted.loadCommittedQueueIds(paths.sessionId)].length, 1);
		} finally {
			persisted.close();
		}
	});
});

test("a strict Write approval resumes compactly after restart and executes once", async (t) => {
	const paths = await scenarioPaths(t, "approval");
	const seed = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		seedWaitingApproval(seed, paths.workspace, paths.sessionId, "call-write");
	} finally {
		seed.close();
	}
	const provider = await providerFixture(t, (_body, index) => (
		responsesFinal("Approved write completed.", `approval-${index}`)
	));
	const restarted = await startBackend(paths, provider.baseUrl, {
		MYCLI_MEMORY_ENABLED: "false",
	});
	t.after(() => restarted.close());
	send(restarted.backend, "bootstrap", "session.bootstrap", { protocol_version: 1 });
	await waitFor(() => rpcResponse(restarted.messages, "bootstrap"));
	const approval = await waitFor(() => sessionEvent(
		restarted.messages,
		"approval.request",
		paths.sessionId,
	));
	assert.equal(paramValue(approval, "decision_id"), "call-write");
	assert.equal(paramValue(approval, "preview"), "Write notes.txt");
	for (const detail of [
		"content_preview",
		"content_line_count",
		"content_chars",
		"content_truncated",
		"diff",
		"diff_chars",
		"diff_truncated",
	]) {
		assert.equal(paramValue(approval, detail), undefined);
	}
	send(restarted.backend, "approve", "approval.respond", {
		decision_id: "call-write",
		choice: "approve_once",
	});
	const accepted = await waitFor(() => rpcResponse(restarted.messages, "approve"));
	assert.equal(resultValue(accepted, "accepted"), true);
	await waitForFinal(restarted.messages, `approval-client-${paths.sessionId}`);
	assert.equal(await readFile(join(paths.workspace, "notes.txt"), "utf8"), "hello\n");
	assert.equal(provider.requests.length, 1);
	assert.equal(events(restarted.messages, "tool.start").length, 1);
	assert.equal(events(restarted.messages, "tool.complete").length, 1);
	await restarted.close();

	const persisted = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		assert.equal(persisted.loadState(paths.sessionId, "pending_decision"), undefined);
		assert.equal(
			persisted.loadTurn(paths.sessionId, `approval-client-${paths.sessionId}`)?.status,
			"completed",
		);
	} finally {
		persisted.close();
	}
	assert.equal(existsSync(paths.pythonMarker), false);
});

test("an orphaned claimed effect becomes explicit unknown without tool replay", async (t) => {
	const paths = await scenarioPaths(t, "claimed-effect");
	const seed = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		seedWaitingApproval(seed, paths.workspace, paths.sessionId, "call-claimed");
		seed.compareAndSetApproval({
			sessionId: paths.sessionId,
			expectedStatus: "waiting",
			transition: { type: "approve_once" },
		});
		seed.compareAndSetApproval({
			sessionId: paths.sessionId,
			expectedStatus: "approved",
			transition: { type: "claim_effect", fingerprint: "sha256:claimed" },
		});
	} finally {
		seed.close();
	}
	const restarted = await startBackend(paths, "http://127.0.0.1:9/v1", {
		MYCLI_MEMORY_ENABLED: "false",
	});
	t.after(() => restarted.close());
	await restarted.close();
	assert.equal(existsSync(join(paths.workspace, "notes.txt")), false);

	const persisted = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		const turn = persisted.loadTurn(paths.sessionId, `approval-client-${paths.sessionId}`);
		assert.equal(turn?.status, "interrupted");
		assert.equal((turn?.result as JsonObject | null)?.error_kind, "effect_outcome_unknown");
		assert.equal(persisted.loadState(paths.sessionId, "pending_decision"), undefined);
	} finally {
		persisted.close();
	}
});

test("corrupt target state fails closed and a later cross-session resume is atomic", async (t) => {
	const paths = await scenarioPaths(t, "source");
	const seed = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		seedCompletedTurn(seed, paths.workspace, paths.sessionId, "source", "source answer");
		seedCompletedTurn(seed, paths.workspace, "target", "target question", "target answer");
		seedCompletedTurn(seed, paths.workspace, "corrupt", "corrupt question", "corrupt answer");
		seed.saveState({
			sessionId: "corrupt",
			workspaceRoot: paths.workspace,
			threadId: "corrupt",
			key: "input_queue",
			payload: {
				session_id: "corrupt",
				revision: 0,
				pending_steers: [],
				rejected_steers: [],
				follow_ups: [],
			},
		});
	} finally {
		seed.close();
	}
	const database = await openDatabase(paths.dbPath);
	database.prepare(`
		UPDATE session_state SET payload_json = '[]'
		WHERE session_id = 'corrupt' AND state_key = 'input_queue'
	`).run();
	database.close();
	const provider = await providerFixture(t, (_body, index) => (
		responsesFinal("Target continued.", `target-${index}`)
	));
	const backend = await startBackend(paths, provider.baseUrl, {
		MYCLI_MEMORY_ENABLED: "false",
	});
	t.after(() => backend.close());
	send(backend.backend, "corrupt", "session.resume", { session_id: "corrupt" });
	const corrupt = await waitFor(() => rpcResponse(backend.messages, "corrupt"));
	assert.equal(errorValue(corrupt, "code"), "session_state_invalid");
	send(backend.backend, "status", "status.get", {});
	const sourceStatus = await waitFor(() => rpcResponse(backend.messages, "status"));
	assert.equal(resultValue(sourceStatus, "session_id"), paths.sessionId);

	send(backend.backend, "target", "session.resume", { session_id: "target" });
	const resumed = await waitFor(() => rpcResponse(backend.messages, "target"));
	assert.equal(resultValue(resumed, "session_id"), "target");
	send(backend.backend, "turn", "turn.submit", {
		message: "continue target",
		client_turn_id: "target-m5-turn",
		client_user_message_id: "target-m5-user",
	});
	await waitForFinal(backend.messages, "target-m5-turn");
	const providerInput = JSON.stringify(provider.requests.at(-1)?.body.input);
	assert.match(providerInput, /seed question target/u);
	assert.doesNotMatch(providerInput, /seed question source/u);
	await backend.close();

	const persisted = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		assert.ok(persisted.loadTurn("target", "target-m5-turn"));
		assert.equal(persisted.loadTurn(paths.sessionId, "target-m5-turn"), undefined);
	} finally {
		persisted.close();
	}
});

test("Chat rebuilds canonical history and persists without Responses continuation", async (t) => {
	const paths = await scenarioPaths(t, "chat", "chat_completions");
	const seed = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		seedCompletedTurn(seed, paths.workspace, paths.sessionId, "prior question", "prior answer");
	} finally {
		seed.close();
	}
	const provider = await providerFixture(t, (_body, index) => (
		chatFinal("Chat completed.", `chat-${index}`)
	));
	const backend = await startBackend(paths, provider.baseUrl, {
		MYCLI_MEMORY_ENABLED: "false",
	});
	t.after(() => backend.close());
	send(backend.backend, "turn", "turn.submit", {
		message: "continue canonically",
		client_turn_id: "m5-chat-turn",
		client_user_message_id: "m5-chat-user",
	});
	await waitForFinal(backend.messages, "m5-chat-turn");
	assert.equal(provider.requests.length, 1);
	assert.equal(provider.requests[0]?.path, "/v1/chat/completions");
	const requestJson = JSON.stringify(provider.requests[0]?.body);
	assert.match(requestJson, /prior question/u);
	assert.match(requestJson, /prior answer/u);
	assert.equal(occurrences(requestJson, "continue canonically"), 1);
	assert.doesNotMatch(requestJson, /previous_response_id/u);
	await backend.close();

	const persisted = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		assert.equal(persisted.loadTurn(paths.sessionId, "m5-chat-turn")?.status, "completed");
		const continuation = persisted.loadState(paths.sessionId, "responses_continuation_state") as
			| JsonObject
			| undefined;
		assert.notEqual(continuation?.eligible, true);
	} finally {
		persisted.close();
	}
	assert.equal(existsSync(paths.pythonMarker), false);
});

test("M5 live smoke exits 77 with one sanitized result when credentials are unavailable", async (t) => {
	const paths = await scenarioPaths(t, "smoke-unavailable");
	const result = await runProcess(
		process.execPath,
		[fileURLToPath(new URL("scripts/smoke_node_m5_state.mjs", ROOT)), "--protocol", "responses"],
		paths.workspace,
		{
			...process.env,
			HOME: paths.home,
			USERPROFILE: paths.home,
			MYCLI_API_KEY: "",
			MYCLI_AUTH_REF: "",
			MYCLI_BASE_URL: "",
		},
	);
	assert.equal(result.code, 77);
	assert.equal(result.stderr, "");
	assert.deepEqual(singleJsonLine(result.stdout), smokeResult("unavailable"));
});

test("M5 live smoke bounds provider calls and reports only structural recovery state", async (t) => {
	const paths = await scenarioPaths(t, "smoke-completed");
	const secret = "test-live-secret";
	const provider = await providerFixture(t, (body, index) => {
		const instructions = responsesAuthorityText(body);
		return instructions.includes("Summarize the supplied conversation")
			? responsesFinal("A compact safe summary.", `smoke-summary-${index}`)
			: responsesFinal("OK", `smoke-turn-${index}`);
	});
	const result = await runProcess(
		process.execPath,
		[fileURLToPath(new URL("scripts/smoke_node_m5_state.mjs", ROOT)), "--protocol", "responses"],
		paths.workspace,
		{
			...process.env,
			HOME: paths.home,
			USERPROFILE: paths.home,
			MYCLI_API_KEY: secret,
			MYCLI_BASE_URL: provider.baseUrl,
			MYCLI_PROVIDER: "openai",
			MYCLI_MODEL: "gpt-test",
		},
	);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.deepEqual(singleJsonLine(result.stdout), smokeResult("completed", true));
	assert.equal(provider.requests.length, 2);
	assert.equal(
		provider.requests.filter((request) => request.body.max_output_tokens === 64).length,
		1,
	);
	assert.equal(
		provider.requests.filter((request) => request.body.max_output_tokens === 512).length,
		1,
	);
	assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${secret}|127\\.0\\.0\\.1`, "u"));
});

test("M5 scripts are declared and the compiled package executable starts without Python", async (t) => {
	const rootPackage = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")) as JsonObject;
	const rootScripts = rootPackage.scripts as JsonObject;
	assert.equal(
		rootScripts["test:m5"],
		"npm run build && node --import tsx --test backend/apps/mycli/test/m5-state-recovery.integration.test.ts",
	);
	assert.equal(rootScripts["smoke:m5"], "node scripts/smoke_node_m5_state.mjs --protocol responses");
	const appPackage = JSON.parse(readFileSync(new URL("backend/apps/mycli/package.json", ROOT), "utf8")) as JsonObject;
	assert.equal(
		(appPackage.scripts as JsonObject)["test:m5"],
		"node --import tsx --test test/m5-state-recovery.integration.test.ts",
	);
	assert.equal(existsSync(fileURLToPath(new URL("scripts/smoke_node_m5_state.mjs", ROOT))), true);

	const marker = fileURLToPath(new URL("python-must-not-start", ROOT));
	const result = await runProcess(
		process.execPath,
		[fileURLToPath(new URL("backend/apps/mycli/dist/cli.js", ROOT)), "--help"],
		fileURLToPath(ROOT),
		{ ...process.env, MYCLI_PYTHON: marker },
	);
	assert.equal(result.code, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /--runtime-backend|python-sidecar/u);
	assert.equal(existsSync(marker), false);
	t.after(() => rm(marker, { force: true }));
});

interface ScenarioPaths {
	readonly root: string;
	readonly home: string;
	readonly workspace: string;
	readonly dbPath: string;
	readonly sessionId: string;
	readonly protocol: Protocol;
	readonly pythonMarker: string;
}

interface RunningBackend {
	readonly backend: NodeBackend;
	readonly messages: JsonObject[];
	close(): Promise<void>;
}

interface ProviderRequest {
	readonly path: string;
	readonly body: JsonObject;
}

async function scenarioPaths(
	t: TestContext,
	label: string,
	protocol: Protocol = "responses",
): Promise<ScenarioPaths> {
	const root = await mkdtemp(join(tmpdir(), `mycli-node-m5-${label}-`));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	t.after(() => rm(root, { recursive: true, force: true }));
	return {
		root,
		home,
		workspace,
		dbPath: join(home, ".mycli", "sessions.db"),
		sessionId: `m5-${label}`,
		protocol,
		pythonMarker: join(root, "python-started"),
	};
}

async function providerFixture(
	t: TestContext,
	respond: (body: JsonObject, index: number) => readonly JsonObject[],
): Promise<{ readonly baseUrl: string; readonly requests: ProviderRequest[] }> {
	const requests: ProviderRequest[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			const body = JSON.parse(raw) as JsonObject;
			requests.push({ path: request.url ?? "", body });
			writeSse(response, respond(body, requests.length));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	}));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function startBackend(
	paths: ScenarioPaths,
	baseUrl: string,
	envOverrides: NodeJS.ProcessEnv = {},
): Promise<RunningBackend> {
	const backend = await startNodeBackend({
		cwd: paths.workspace,
		args: ["--session", paths.sessionId, "--model", "gpt-test"],
		env: {
			HOME: paths.home,
			USERPROFILE: paths.home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: baseUrl,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: paths.protocol,
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_REQUEST_MAX_RETRIES: "0",
			MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_CACHE_RETENTION: "none",
			MYCLI_PYTHON: paths.pythonMarker,
			...envOverrides,
		},
	});
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as JsonObject);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	let closed = false;
	return {
		backend,
		messages,
		close: async () => {
			if (closed) return;
			closed = true;
			send(backend, `shutdown-${Date.now()}`, "shutdown", {});
			assert.equal(await backend.completion, 0);
		},
	};
}

function seedCompletedTurn(
	store: RuntimeSessionStore,
	workspaceRoot: string,
	sessionId: string,
	suffix: string,
	assistantText: string,
): void {
	const clientTurnId = `seed-client-${sessionId}-${suffix}`;
	const userText = `seed question ${suffix}`;
	store.reserveTurn({
		sessionId,
		clientTurnId,
		clientUserMessageId: clientTurnId,
		turnId: `seed-turn-${sessionId}-${suffix}`,
		requestFingerprint: fingerprintSubmission({ message: userText, localImages: [] }),
		workspaceRoot,
		threadId: sessionId,
		userText,
		startedAt: "2026-08-04T00:00:00.000Z",
	});
	store.completeTurn({
		sessionId,
		clientTurnId,
		assistantText,
		usage: {},
		completedAt: "2026-08-04T00:00:01.000Z",
	});
}

function queuePayload(
	sessionId: string,
	records: readonly {
		readonly queueId: string;
		readonly clientTurnId: string;
		readonly kind: "pending_steer" | "rejected_steer" | "follow_up";
		readonly state?: "queued" | "accepted" | "claimed" | "committed";
		readonly claimTurnId?: string;
		readonly targetTurnId?: string | null;
		readonly text: string;
		readonly imagePaths?: readonly string[];
		readonly source?: string;
	}[],
): JsonObject {
	const now = "2026-08-05T00:00:00.000Z";
	const persisted = records.map((record) => ({
		queue_id: record.queueId,
		session_id: sessionId,
		client_turn_id: record.clientTurnId,
		target_turn_id: record.targetTurnId ?? null,
		kind: record.kind,
		state: record.state ?? (record.kind === "pending_steer" ? "accepted" : "queued"),
		...(record.claimTurnId ? { claim_turn_id: record.claimTurnId } : {}),
		text: record.text,
		image_paths: [...(record.imagePaths ?? [])],
		source: record.source ?? "user",
		created_at: now,
		updated_at: now,
	}));
	return {
		session_id: sessionId,
		revision: records.length,
		pending_steers: persisted.filter((record) => record.kind === "pending_steer"),
		rejected_steers: persisted.filter((record) => record.kind === "rejected_steer"),
		follow_ups: persisted.filter((record) => record.kind === "follow_up"),
	};
}

function seedWaitingApproval(
	store: RuntimeSessionStore,
	workspaceRoot: string,
	sessionId: string,
	callId: string,
): void {
	const clientTurnId = `approval-client-${sessionId}`;
	const turnId = `approval-turn-${sessionId}`;
	const userText = "update the notes";
	store.reserveTurn({
		sessionId,
		clientTurnId,
		clientUserMessageId: clientTurnId,
		turnId,
		requestFingerprint: fingerprintSubmission({ message: userText, localImages: [] }),
		workspaceRoot,
		threadId: sessionId,
		userText,
		startedAt: "2026-08-04T00:00:02.000Z",
	});
	store.appendAssistantToolCalls({
		sessionId,
		clientTurnId,
		assistantText: "",
		calls: [{
			callId,
			name: "Write",
			argumentsJson: JSON.stringify({ file_path: "notes.txt", content: "hello\n" }),
		}],
		responseId: "resp-tools",
	});
	const toolCall = {
		name: "Write",
		arguments: { file_path: "notes.txt", content: "hello\n" },
		reason: "Update notes",
		call_id: callId,
	};
	store.saveApprovalSuspension({
		sessionId,
		workspaceRoot,
		threadId: sessionId,
		pendingDecision: {
			kind: "pending_decision",
			version: 1,
			payload: {
				tool_call: toolCall,
				kind: "needs_choice",
				reason: "A workspace file will change.",
				preview: "Write notes.txt",
				options: ["approve_once", "reject"],
				command_pattern: null,
				proposed_execpolicy_pattern: null,
				metadata: { policy: "medium_risk_requires_approval" },
			} as Extract<RuntimeStateRecord, { kind: "pending_decision" }>["payload"],
		},
		suspendedTurn: {
			kind: "suspended_turn",
			version: 1,
			payload: {
				user_message: userText,
				conversation: [{ role: "user", content: userText }],
				suspend_reason: "approval_required",
				plan_items: [],
				pending_approval: {
					tool_call: toolCall,
					reason: "A workspace file will change.",
					preview: "Write notes.txt",
					command_pattern: null,
					proposed_execpolicy_pattern: null,
					metadata: { policy: "medium_risk_requires_approval" },
				},
				pending_clarification: null,
				session_id: sessionId,
				client_turn_id: clientTurnId,
				turn_id: turnId,
				provider_protocol: "responses",
				remaining_tool_calls: [],
				continuation: { assistant_text: "", response_id: "resp-tools", usage: {} },
			} as Extract<RuntimeStateRecord, { kind: "suspended_turn" }>["payload"],
		},
		turnRecord: {
			turn_id: turnId,
			client_turn_id: clientTurnId,
			user_message: userText,
			status: "waiting_approval",
			stop_reason: "approval_required",
			updated_at: "2026-08-04T00:00:02.000Z",
		},
		checkpoint: {
			sessionId,
			clientTurnId,
			turnId,
			decisionId: callId,
			callId,
			toolName: "Write",
			status: "waiting",
			updatedAt: "2026-08-04T00:00:02.000Z",
		},
	});
}

function responsesFinal(text: string, responseId: string): readonly JsonObject[] {
	return responsesTextEvents(text, responseId, {
		input_tokens: 4,
		output_tokens: 1,
		total_tokens: 5,
	});
}

function chatFinal(text: string, responseId: string): readonly JsonObject[] {
	return [
		{
			id: responseId,
			choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
		},
		{
			id: responseId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
		},
	];
}

function writeSse(
	response: ServerResponse,
	items: readonly JsonObject[],
): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const item of items) response.write(`data: ${JSON.stringify(item)}\n\n`);
	response.end("data: [DONE]\n\n");
}

function send(backend: NodeBackend, id: string, method: string, params: JsonObject): void {
	backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function event(messages: readonly JsonObject[], method: string): JsonObject | undefined {
	return messages.find((message) => message.method === method && !("id" in message));
}

function events(messages: readonly JsonObject[], method: string): JsonObject[] {
	return messages.filter((message) => message.method === method && !("id" in message));
}

function sessionEvent(
	messages: readonly JsonObject[],
	method: string,
	sessionId: string,
): JsonObject | undefined {
	return messages.find((message) => (
		message.method === method
		&& !("id" in message)
		&& paramValue(message, "session_id") === sessionId
	));
}

function rpcResponse(messages: readonly JsonObject[], id: string): JsonObject | undefined {
	return messages.find((message) => String(message.id) === id);
}

function resultValue(message: JsonObject, key: string): unknown {
	return isObject(message.result) ? message.result[key] : undefined;
}

function errorValue(message: JsonObject, key: string): unknown {
	return isObject(message.error) ? message.error[key] : undefined;
}

function paramValue(message: JsonObject, key: string): unknown {
	return isObject(message.params) ? message.params[key] : undefined;
}

async function waitForFinal(messages: readonly JsonObject[], clientTurnId: string): Promise<JsonObject> {
	const terminal = await waitFor(() => messages.find((message) => (
		isObject(message.params)
		&& message.params.client_turn_id === clientTurnId
		&& (message.method === "turn.failed"
			|| (message.method === "message.complete" && message.params.final === true))
	)));
	assert.notEqual(terminal.method, "turn.failed", JSON.stringify(terminal.params));
	return terminal;
}

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("timed out waiting for Node M5 integration state");
}

function runProcess(
	command: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function longText(label: string): string {
	return `${label} context `.repeat(240);
}

function occurrences(value: string, needle: string): number {
	return value.split(needle).length - 1;
}

function smokeResult(status: string, value = false): JsonObject {
	return {
		protocol: "responses",
		status,
		compacted: value,
		memory_visible: value,
		resumed: value,
		persisted: value,
		python_started: false,
	};
}

function singleJsonLine(stdout: string): JsonObject {
	const lines = stdout.trim().split(/\r?\n/u);
	assert.equal(lines.length, 1);
	const value = JSON.parse(lines[0] ?? "") as unknown;
	assert.ok(isObject(value));
	return value;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function openDatabase(path: string) {
	const module = await import("better-sqlite3");
	return new module.default(path);
}

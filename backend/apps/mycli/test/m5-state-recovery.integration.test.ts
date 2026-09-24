import assert from "node:assert/strict";
import { removeFixtureDirectoryAfterTests } from "../../../packages/storage/test/fixtures/directory-cleanup.ts";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parseGatewayEvent, parseJsonRpcMessage, parseProviderAttemptRecord, TURN_INTERRUPTED_NOTICE, turnFailedNoticeId, type ProviderAttemptRecord, type RuntimeStateRecord } from "@mycli/contracts";
import { fingerprintSubmission } from "@mycli/core";
import { MemoryStore } from "@mycli/runtime";
import { openRuntimeSessionStore, type RuntimeSessionStore } from "@mycli/storage";
import type { NodeBackend } from "../src/node-runtime/node-backend.ts";
import { startTestNodeBackend as startNodeBackend } from "./support/offline-update-fetch.ts";
import {
	responsesAuthorityText,
	responsesTextEvents,
	responsesToolEvents,
} from "./support/responses-sse.ts";

type Protocol = "responses" | "chat_completions";
type JsonObject = Record<string, unknown>;

const ROOT = new URL("../../../../", import.meta.url);

test("Worker upstream stream failure retries once and preserves one safe failure across resume", async (t) => {
	await verifyProviderFailureResume(t, "response.failed");
});

test("Worker nested upstream error retains diagnostics, retries, and resumes with the same visible detail", async (t) => {
	await verifyProviderFailureResume(t, "nested_error");
});

test("Worker root accepts immediate messages after repeated streamed turn interruptions", { timeout: 20_000 }, async (t) => {
	const paths = await scenarioPaths(t, "interrupt-resubmit");
	const provider = await providerFixture(t, (_body, index) => index % 2 === 1
		? responsesTextEvents("Still working.", `resp-wait-${index}`).slice(0, 3)
		: responsesFinal("Follow-up complete.", `resp-complete-${index}`),
	(index) => index % 2 === 1);
	const running = await startBackend(paths, provider.baseUrl, {
		MYCLI_MEMORY_ENABLED: "false", MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
	});
	t.after(() => running.close());
	for (const index of [1, 2]) {
		const interruptedClient = `client-interrupt-${index}`;
		send(running.backend, `submit-${index}`, "turn.submit", {
			message: "Start working.", client_turn_id: interruptedClient,
			client_user_message_id: `user-interrupt-${index}`,
		});
		const accepted = await waitFor(() => rpcResponse(running.messages, `submit-${index}`));
		assert.equal(accepted.error, undefined);
		await waitFor(() => events(running.messages, "message.delta").find((message) =>
			paramValue(message, "client_turn_id") === interruptedClient));
		send(running.backend, `interrupt-${index}`, "turn.interrupt", {
			turn_id: resultValue(accepted, "turn_id"),
		});
		const interrupted = await waitFor(() => rpcResponse(running.messages, `interrupt-${index}`));
		assert.equal(interrupted.error, undefined);
		assert.equal(resultValue(interrupted, "accepted"), true);
		const terminal = events(running.messages, "turn.interrupted").filter((message) =>
			paramValue(message, "client_turn_id") === interruptedClient);
		assert.equal(terminal.length, 1);
		assert.ok(running.messages.indexOf(terminal[0]!) < running.messages.indexOf(interrupted));

		const followUpClient = `client-follow-up-${index}`;
		send(running.backend, `follow-up-${index}`, "turn.submit", {
			message: "Use the new instruction.", client_turn_id: followUpClient,
			client_user_message_id: `user-follow-up-${index}`,
		});
		const followUp = await waitFor(() => rpcResponse(running.messages, `follow-up-${index}`));
		assert.equal(followUp.error, undefined);
		const completed = await waitFor(() => events(running.messages, "turn.completed").find((message) =>
			paramValue(message, "client_turn_id") === followUpClient));
		await waitFor(() => running.messages.slice(running.messages.indexOf(completed) + 1).find((message) =>
			message.method === "status.changed" && paramValue(message, "turn_running") === false));
	}
	assert.equal(provider.requests.length, 4);
	assert.equal(events(running.messages, "turn.failed").length, 0);
	assert.equal(events(running.messages, "gateway.error").length, 0);
	const liveAttempts = events(running.messages, "provider.attempt.updated").map((message) =>
		parseProviderAttemptRecord(paramValue(message, "record")));
	assert.deepEqual(liveAttempts.map((attempt) => attempt.state), [
		"started", "cancelled", "started", "completed", "started", "cancelled", "started", "completed",
	]);
	await running.close();
	const reopened = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		for (const index of [1, 2]) {
			assert.equal(reopened.loadTurn(paths.sessionId, `client-interrupt-${index}`)?.status, "interrupted");
			assert.equal(reopened.loadTurn(paths.sessionId, `client-follow-up-${index}`)?.status, "completed");
		}
		assert.deepEqual(reopened.providerAttemptLedger.list({ sessionId: paths.sessionId }), liveAttempts);
	} finally {
		reopened.close();
	}
});

async function verifyProviderFailureResume(t: TestContext, shape: "response.failed" | "nested_error"): Promise<void> {
	const paths = await scenarioPaths(t, "provider-failure");
	const reason = shape === "nested_error" ? "stream_read_error" : "upstream request failed";
	const errorCode = shape === "nested_error" ? "stream_read_error" : "server_error";
	const error = { code: errorCode, type: "upstream_error", message: `${reason} token=private-key` };
	const failures: readonly JsonObject[] = shape === "nested_error" ? [
		{ type: "error", sequence_number: 0, error },
		{ type: "response.failed", response: { id: "resp-failed", status: "failed", output: [],
			error: { code: "upstream_error", message: "Upstream request failed" } } },
	] : [{ type: "response.failed", response: { status: "failed", error } }];
	const provider = await providerFixture(t, (_body, index) => index === 1
		? responsesToolEvents("call-plan-once", "update_plan", { plan: [{ step: "Say hello", status: "in_progress" }] })
		: [
		{ type: "response.created", response: { id: "resp-failed", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0,
			item: { type: "message", id: "msg-partial", role: "assistant", content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "incomplete draft" },
		...failures,
	]);
	const first = await startBackend(paths, provider.baseUrl, {
		MYCLI_MEMORY_ENABLED: "false", MYCLI_AGENT_EXECUTION_ADAPTER: "worker", MYCLI_STREAM_MAX_RETRIES: "1",
	});
	t.after(() => first.close());
	send(first.backend, "submit", "turn.submit", {
		message: "Say hello.", client_turn_id: "client-provider-failure", client_user_message_id: "user-provider-failure",
	});
	const failed = await waitFor(() => event(first.messages, "turn.failed"));
	parseGatewayEvent(failed);
	assert.equal(provider.requests.length, 3, `terminal failure: ${String(paramValue(failed, "code"))}`);
	assert.equal(events(first.messages, "plan.updated").length, 1, "provider retries must not re-execute a committed tool");
	assert.equal(paramValue(failed, "code"), "retry_exhausted");
	assert.ok(String(paramValue(failed, "additional_details")).startsWith(`${reason} token=[REDACTED]`));
	const retries = events(first.messages, "stream.retrying");
	assert.equal(retries.length, 1);
	assert.ok(String(paramValue(retries[0]!, "additional_details")).startsWith(reason));
	assert.equal(events(first.messages, "message.reset").length, 1);
	assert.equal(events(first.messages, "turn.failed").length, 1);
	assert.equal(events(first.messages, "gateway.error").length, 0);
	const liveAttempts = events(first.messages, "provider.attempt.updated").map((message) =>
		parseProviderAttemptRecord(paramValue(message, "record")));
	assert.deepEqual(liveAttempts.map((attempt) => attempt.state), [
		"started", "completed", "started", "failed", "scheduled", "started", "failed", "exhausted",
	]);
	assert(liveAttempts.every((attempt) => attempt.source === "worker"));
	assert.equal(liveAttempts.at(-1)?.streamRetriesUsed, 1);
	assert.equal(liveAttempts.at(-1)?.attempt, 2);
	assert.doesNotMatch(JSON.stringify(first.messages), /private-key/u);
	await first.close();
	const trace = (await readFile(join(paths.home, ".mycli", "traces", `${paths.sessionId}-trace.jsonl`), "utf8"))
		.trim().split("\n").map((line) => JSON.parse(line) as JsonObject);
	const failedAttempts = trace.filter((entry) => entry.kind === "model_stream_diagnostics"
		&& isObject(entry.payload) && entry.payload.success === false);
	assert.equal(failedAttempts.length, 2);
	for (const attempt of failedAttempts) {
		assert.ok(isObject(attempt.payload));
		assert.equal(attempt.payload.provider_error_code, errorCode);
		assert.equal(attempt.payload.provider_error_type, "upstream_error");
		assert.equal(attempt.payload.status, 200);
		assert.equal(attempt.payload.error_source, "response_stream");
		assert.equal(attempt.payload.retryable, true);
		assert.ok(String(attempt.payload.additional_details).startsWith(`${reason} token=[REDACTED]`));
	}
	assert.doesNotMatch(JSON.stringify(trace), /private-key/u);

	const persisted = openRuntimeSessionStore({ dbPath: paths.dbPath });
	let durableAttempts: readonly ProviderAttemptRecord[];
	try {
		durableAttempts = persisted.providerAttemptLedger.list({ sessionId: paths.sessionId });
		assert.deepEqual(durableAttempts, liveAttempts);
		const turn = persisted.loadTurn(paths.sessionId, "client-provider-failure");
		assert.equal(turn?.status, "failed");
		assert.ok(isObject(turn?.result));
		assert.equal(turn.result.additional_details, paramValue(failed, "additional_details"));
		assert.ok(isObject(turn.result.diagnostics));
		assert.equal(turn.result.diagnostics.provider_error_code, errorCode);
		assert.equal(turn.result.diagnostics.provider_error_type, "upstream_error");
		assert.doesNotMatch(JSON.stringify(persisted.loadConversationItems(paths.sessionId)), /stream_read_error|upstream request failed|private-key/u);
	} finally {
		persisted.close();
	}
	const restarted = await startBackend({ ...paths, sessionId: "m5-failure-restart" }, provider.baseUrl, {
		MYCLI_MEMORY_ENABLED: "false",
	});
	t.after(() => restarted.close());
	send(restarted.backend, "resume", "session.resume", { session_id: paths.sessionId });
	await waitFor(() => rpcResponse(restarted.messages, "resume"));
	send(restarted.backend, "transcript", "transcript.load", {});
	const transcript = resultValue(await waitFor(() => rpcResponse(restarted.messages, "transcript")), "items");
	assert.ok(Array.isArray(transcript));
	const notices = transcript.filter((item: unknown) => isObject(item)
		&& item.id === turnFailedNoticeId(String(paramValue(failed, "turn_id"))));
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.metadata.additional_details, paramValue(failed, "additional_details"));
	send(restarted.backend, "attempts", "provider.attempts.load", {});
	const resumedAttempts = resultValue(await waitFor(() => rpcResponse(restarted.messages, "attempts")), "records");
	assert.deepEqual(resumedAttempts, durableAttempts);
	assert.equal(provider.requests.length, 3);
	await restarted.close();
}

test("Worker-backed Responses root retries compaction, injects memory, resumes, and completes", async (t) => {
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
	let summaryAttempts = 0;
	const provider = await providerFixture(t, (body, index) => {
		const instructions = responsesAuthorityText(body);
		if (instructions.includes("select memory files")) {
			return responsesFinal(JSON.stringify({ selected_memories: ["tone.md"] }), `selector-${index}`);
		}
		if (JSON.stringify(body.input).includes("CONTEXT CHECKPOINT COMPACTION")) {
			summaryAttempts += 1;
			if (summaryAttempts === 1) return [{ type: "error", error: {
				code: "stream_read_error", message: "stream_read_error", type: "upstream_error",
			} }];
			return responsesFinal("Earlier turns established the compacted baseline.", `summary-${index}`);
		}
		return responsesFinal("M5 completed.", `turn-${index}`);
	});
	const first = await startBackend(paths, provider.baseUrl, {
		MYCLI_MEMORY_ENABLED: "true",
		// The shipped base prompt is ~10k tokens, so keep enough of the prompt
		// budget free for the summarizer to receive its full output room.
		MYCLI_MAX_PROMPT_TOKENS: "32000",
		MYCLI_COMPACTION_TOKEN_LIMIT: "128",
		MYCLI_COMPACTION_RESERVED_OUTPUT_TOKENS: "32",
		MYCLI_COMPACTION_TAIL_TURNS: "1",
		MYCLI_COMPACTION_TAIL_MAX_TOKENS: "128",
		MYCLI_COMPACTION_L4_BUFFER_TOKENS: "32",
		MYCLI_COMPACTION_L4_MIN_SAVINGS_RATIO: "0",
		MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
		MYCLI_REQUEST_MAX_RETRIES: "1",
		MYCLI_STREAM_MAX_RETRIES: "1",
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
	assert.equal(paramValue(events(first.messages, "compaction.completed")[0]!, "status"), "compressed",
		JSON.stringify(events(first.messages, "compaction.completed")));
	assert.equal(provider.requests.filter((request) => (
		responsesAuthorityText(request.body).includes("select memory files")
	)).length, 0);
	assert.equal(provider.requests.length, 3);
	assert.equal(summaryAttempts, 2);
	assert.ok(events(first.messages, "status.update").some((message) =>
		paramValue(message, "kind") === "compaction" && String(paramValue(message, "text")).includes("1/")));
	assert.ok(events(first.messages, "message.delta").every((message) =>
		!String(paramValue(message, "text")).includes("Earlier turns established")));
	const summaryRequest = provider.requests.find((request) => (
		JSON.stringify(request.body.input).includes("CONTEXT CHECKPOINT COMPACTION")
	));
	assert.ok(summaryRequest);
	assert.ok(Number(summaryRequest.body.max_output_tokens) > 4_096);
	assert.ok(responsesAuthorityText(summaryRequest.body).startsWith("# Identity\n"));
	const mainRequest = provider.requests.find((request) => (
		responsesAuthorityText(request.body).startsWith("# Identity\n")
			&& !JSON.stringify(request.body.input).includes("CONTEXT CHECKPOINT COMPACTION")
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
		const history = persisted.loadHistoryItems(paths.sessionId);
		const attempts = history.flatMap((item) => isObject(item.metadata)
			&& isObject(item.metadata.provider_attempt) ? [item.metadata.provider_attempt.state] : []);
		assert.deepEqual(attempts, ["started", "failed", "scheduled", "started", "recovered"]);
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

test("cold startup interrupts a stored Write approval and accepts a new turn without executing it", async (t) => {
	const paths = await scenarioPaths(t, "approval");
	const seed = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		seedWaitingApproval(seed, paths.workspace, paths.sessionId, "call-write");
	} finally {
		seed.close();
	}
	const provider = await providerFixture(t, (_body, index) => (
		responsesFinal("New turn completed.", `approval-${index}`)
	));
	const restarted = await startBackend(paths, provider.baseUrl, {
		MYCLI_MEMORY_ENABLED: "false",
	});
	t.after(() => restarted.close());
	send(restarted.backend, "bootstrap", "session.bootstrap", { protocol_version: 1 });
	await waitFor(() => rpcResponse(restarted.messages, "bootstrap"));
	assert.equal(events(restarted.messages, "approval.request").length, 0);
	assert.equal(provider.requests.length, 0);
	send(restarted.backend, "approve", "approval.respond", {
		decision_id: "call-write",
		choice: "approve_once",
	});
	const accepted = await waitFor(() => rpcResponse(restarted.messages, "approve"));
	assert.equal((accepted.error as JsonObject)?.code, "approval_not_pending");
	send(restarted.backend, "new-turn", "turn.submit", {
		message: "Continue with a new task.", client_turn_id: "new-client", client_user_message_id: "new-user",
	});
	await waitForFinal(restarted.messages, "new-client");
	assert.equal(existsSync(join(paths.workspace, "notes.txt")), false);
	assert.equal(provider.requests.length, 1);
	assert.equal(events(restarted.messages, "tool.start").length, 0);
	assert.equal(events(restarted.messages, "tool.complete").length, 0);
	await restarted.close();

	const persisted = openRuntimeSessionStore({ dbPath: paths.dbPath });
	try {
		assert.equal(persisted.loadState(paths.sessionId, "pending_decision"), undefined);
		assert.equal(
			persisted.loadTurn(paths.sessionId, `approval-client-${paths.sessionId}`)?.status,
			"interrupted",
		);
		assert.equal(persisted.loadReadableTranscript(paths.sessionId).filter((item) => item.text === TURN_INTERRUPTED_NOTICE).length, 1);
	} finally {
		persisted.close();
	}
	assert.equal(existsSync(paths.pythonMarker), false);
});

test("cold session resume discards stored Shell approvals without replaying commands", async (t) => {
	for (const adapter of ["worker", "in_process"]) await t.test(adapter, async (context) => {
		const paths = await scenarioPaths(context, "shell-approval");
		const justification = "Run the requested diagnostic using API_KEY=private-test-value";
		const command = "  node <<'SCRIPT'\n"
			+ Array.from({ length: 40 }, (_, index) => `  console.log('line ${index}');`).join("\n")
			+ "\nSCRIPT\n";
		const seed = openRuntimeSessionStore({ dbPath: paths.dbPath });
		try {
			seedWaitingApproval(seed, paths.workspace, paths.sessionId, "call-shell", command, justification);
		} finally {
			seed.close();
		}
		const provider = await providerFixture(context, () => responsesFinal("Command rejected.", "after-rejection"));
		const restarted = await startBackend({ ...paths, sessionId: `${paths.sessionId}-idle` }, provider.baseUrl, {
			MYCLI_MEMORY_ENABLED: "false", MYCLI_AGENT_EXECUTION_ADAPTER: adapter,
		});
		context.after(() => restarted.close());
		send(restarted.backend, "resume", "command.run", { command: `/resume ${paths.sessionId}`, surface: "tui" });
		const response = await waitFor(() => rpcResponse(restarted.messages, "resume"));
		assert.equal(response.error, undefined);
		assert.equal(resultValue(response, "session_id"), paths.sessionId);
		assert.deepEqual(resultValue(response, "background_shells"), []);
		assert.equal(events(restarted.messages, "approval.request").length, 0);
		send(restarted.backend, "approve", "approval.respond", { decision_id: "call-shell", choice: "approve_once" });
		const rejected = await waitFor(() => rpcResponse(restarted.messages, "approve"));
		assert.equal((rejected.error as JsonObject)?.code, "approval_not_pending");
		send(restarted.backend, "history", "transcript.load", {});
		const history = resultValue(await waitFor(() => rpcResponse(restarted.messages, "history")), "items") as JsonObject[];
		assert.equal(history.filter((item) => item.text === TURN_INTERRUPTED_NOTICE).length, 1);
		assert.equal(events(restarted.messages, "tool.start").length, 0);
		assert.equal(provider.requests.length, 0);
	});
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
		return JSON.stringify(body.input).includes("CONTEXT CHECKPOINT COMPACTION")
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
	removeFixtureDirectoryAfterTests(t, root);
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
	keepOpen: (index: number) => boolean = () => false,
): Promise<{ readonly baseUrl: string; readonly requests: ProviderRequest[] }> {
	const requests: ProviderRequest[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			const body = JSON.parse(raw) as JsonObject;
			requests.push({ path: request.url ?? "", body });
			writeSse(response, respond(body, requests.length), !keepOpen(requests.length));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => {
		server.closeAllConnections();
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
	send(backend, "error-context-bootstrap", "session.bootstrap", { protocol_version: 1, supported_error_context_versions: [1] });
	const bootstrap = await waitFor(() => rpcResponse(messages, "error-context-bootstrap"));
	assert.equal(resultValue(bootstrap, "error_context_version"), 1);
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
	command?: string,
	justification?: string,
): void {
	const toolName = command === undefined ? "Write" : "Shell";
	const argumentsValue = command === undefined ? { file_path: "notes.txt", content: "hello\n" }
		: { command, ...(justification ? { justification } : {}) };
	const preview = command === undefined ? "Write notes.txt" : "Shell command requires approval";
	const reason = command === undefined ? "A workspace file will change." : "Shell command requires approval.";
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
			name: toolName,
			argumentsJson: JSON.stringify(argumentsValue),
		}],
		responseId: "resp-tools",
	});
	const toolCall = {
		name: toolName,
		arguments: argumentsValue,
		reason,
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
				reason,
				preview,
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
					reason,
					preview,
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
			toolName,
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
	complete = true,
): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const item of items) response.write(`data: ${JSON.stringify(item)}\n\n`);
	if (complete) response.end("data: [DONE]\n\n");
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

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { parseJsonRpcMessage, type RuntimeStateRecord } from "@mycli/contracts";
import { fingerprintSubmission } from "@mycli/core";
import { SQLiteSessionStore } from "@mycli/storage";
import { startNodeBackend } from "../src/node-runtime/node-backend.ts";

function finalMessageCount(messages: readonly Record<string, unknown>[]): number {
	return messages.filter((message) => {
		if (message.method !== "message.complete") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.final === true;
	}).length;
}

test("Node backend composes config, provider streaming, gateway, and SQLite", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-backend-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	let requests = 0;
	const capture: { requestBody?: Record<string, unknown> } = {};
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requests += 1;
			capture.requestBody = JSON.parse(body) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello from node\"}\n\n");
			response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_node\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n");
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "integration-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_PYTHON: join(root, "python-must-not-start"),
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "shell-list", "shell.list", {});
	const shellList = await waitFor(() => response(messages, "shell-list"));
	assert.deepEqual(shellList.result, {
		session_id: "integration-session",
		generation: 1,
		shells: [],
	});
	writeRequest(backend, "shell-stop-all", "shell.stop_all", {});
	const shellStopAll = await waitFor(() => response(messages, "shell-stop-all"));
	assert.deepEqual(shellStopAll.result, {
		session_id: "integration-session",
		generation: 1,
		stopped: 0,
		shells: [],
	});
	writeRequest(backend, "1", "turn.submit", {
		message: "hello",
		client_turn_id: "integration-turn",
		client_user_message_id: "integration-message",
	});
	const final = await waitFor(() => messages.find((message) => {
		if (message.method !== "message.complete") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.final === true;
	}));
	const submitResponse = await waitFor(() => response(messages, "1"));
	const submittedTurnId = resultValue(submitResponse, "turn_id");
	assert.equal((final.params as Record<string, unknown>).text, "hello from node");
	assert.equal(requests, 1);
	assert.equal(capture.requestBody?.model, "gpt-test");
	assert.equal(capture.requestBody?.stream, true);
	assert.deepEqual(
		(capture.requestBody?.tools as Array<Record<string, unknown>> | undefined)
			?.map((tool) => tool.name),
		["Read", "Edit", "Patch", "Write"],
	);
	assert.equal(existsSync(join(home, ".mycli", "sessions.db")), true);
	await waitFor(() => event(messages, "status.changed"));
	writeRequest(backend, "duplicate", "turn.submit", {
		message: "hello",
		client_turn_id: "integration-turn",
		client_user_message_id: "integration-message",
	});
	await waitFor(() => messages.filter((message) => {
		if (message.method !== "message.complete") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.final === true;
	}).length === 2);
	assert.equal(requests, 1);

	writeRequest(backend, "2", "shutdown", {});
	assert.equal(await backend.completion, 0);
	assert.equal(existsSync(join(home, ".mycli", "projects")), true);
	const snapshot = JSON.parse(await readFile(
		join(home, ".mycli", "sessions", "integration-session", "session.json"),
		"utf8",
	)) as Record<string, unknown>;
	assert.equal(snapshot.schema_version, 2);
	assert.equal(snapshot.session_id, "integration-session");
	assert.equal(snapshot.state, "idle");
	assert.equal(JSON.stringify(snapshot.transcript).includes("hello from node"), true);
	const reopened = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const continuation = reopened.loadState(
			"integration-session",
			"responses_continuation_state",
		) as Record<string, unknown> | undefined;
		assert.equal(continuation?.response_id, "resp_node");
		assert.equal(continuation?.eligible, true);
		assert.equal(continuation?.session_id, "integration-session");
		assert.equal(continuation?.protocol, "responses");
		assert.equal(continuation?.model, "gpt-test");
		assert.equal(continuation?.history_boundary, submittedTurnId);
	} finally {
		reopened.close();
	}
});

test("Node backend exposes Shell only on turns accepted after workspace trust", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-shell-policy-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const requestTools: string[][] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body) as Record<string, unknown>;
			requestTools.push(
				(payload.tools as Array<Record<string, unknown>> | undefined)
					?.map((tool) => String(tool.name)) ?? [],
			);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"done\"}\n\n");
			response.write(`data: {"type":"response.completed","response":{"id":"resp_${requestTools.length}"}}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "shell-policy-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));

	writeRequest(backend, "turn-untrusted", "turn.submit", {
		message: "first",
		client_turn_id: "turn-untrusted",
		client_user_message_id: "message-untrusted",
	});
	await waitFor(() => finalMessageCount(messages) === 1);
	writeRequest(backend, "trust-shell", "workspace.trust.set", { state: "trusted" });
	await waitFor(() => response(messages, "trust-shell"));
	writeRequest(backend, "permission-shell", "permissions.update", { profile: "read-only" });
	await waitFor(() => response(messages, "permission-shell"));
	writeRequest(backend, "turn-trusted", "turn.submit", {
		message: "second",
		client_turn_id: "turn-trusted",
		client_user_message_id: "message-trusted",
	});
	await waitFor(() => finalMessageCount(messages) === 2);

	assert.deepEqual(requestTools[0], ["Read", "Edit", "Patch", "Write"]);
	assert.deepEqual(requestTools[1], ["Read", "Edit", "Patch", "Write", "Shell", "WriteStdin"]);
	writeRequest(backend, "shutdown-shell-policy", "shutdown", {});
	assert.equal(await backend.completion, 0);
});

test("Node backend persists workspace trust across process restarts", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-trust-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const options = {
		cwd: workspace,
		args: ["--session", "trust-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: "http://127.0.0.1:9/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	} as const;

	const first = await startNodeBackend(options);
	const firstMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: first.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		firstMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(firstMessages, "runtime.ready"));
	writeRequest(first, "trust-set", "workspace.trust.set", { state: "trusted" });
	const saved = await waitFor(() => response(firstMessages, "trust-set"));
	assert.deepEqual(saved.result, {
		state: "trusted",
		workspace,
		source: "user_store",
		enforced: true,
	});
	writeRequest(first, "shutdown-first", "shutdown", {});
	assert.equal(await first.completion, 0);

	const second = await startNodeBackend(options);
	const secondMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: second.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		secondMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(secondMessages, "runtime.ready"));
	writeRequest(second, "bootstrap", "session.bootstrap", { protocol_version: 1 });
	const bootstrap = await waitFor(() => response(secondMessages, "bootstrap"));
	const status = resultValue(bootstrap, "status") as Record<string, unknown>;
	assert.deepEqual(status.trust, {
		state: "trusted",
		workspace,
		source: "user_store",
		enforced: true,
	});
	writeRequest(second, "shutdown-second", "shutdown", {});
	assert.equal(await second.completion, 0);
});

test("Node backend atomically resumes complete persisted session state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-resume-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	const dbPath = join(home, ".mycli", "sessions.db");
	const seed = new SQLiteSessionStore({ dbPath });
	try {
			seedCompletedSession(seed, workspace, "source", "source question", "source answer");
			seedCompletedSession(seed, workspace, "approval", "approval question", "approval answer");
			seedWaitingApproval(seed, workspace, "approval", "call-approval");
			seedCompletedSession(seed, workspace, "target", "target question", "target answer");
		seedCompletedSession(seed, workspace, "invalid", "invalid question", "invalid answer");
		seedCompletedSession(
			seed,
			workspace,
			"invalid-suspended",
			"invalid suspended question",
			"invalid suspended answer",
		);
		seed.saveState({
			sessionId: "target",
			workspaceRoot: workspace,
			threadId: "target",
			key: "input_queue",
			payload: queuedFollowUp("target"),
		});
		seed.saveState({
			sessionId: "target",
			workspaceRoot: workspace,
			threadId: "target",
			key: "compact_checkpoint",
			payload: compactCheckpoint(),
		});
		seed.saveState({
			sessionId: "target",
			workspaceRoot: workspace,
			threadId: "target",
			key: "responses_continuation_state",
			payload: responsesContinuation("target"),
		});
		seed.saveState({
			sessionId: "invalid",
			workspaceRoot: workspace,
			threadId: "invalid",
			key: "responses_continuation_state",
			payload: responsesContinuation("another-session"),
		});
		seed.saveState({
			sessionId: "invalid-suspended",
			workspaceRoot: workspace,
			threadId: "invalid-suspended",
			key: "suspended_turn",
			payload: suspendedApproval("another-session", "call-invalid-suspended"),
		});
	} finally {
		seed.close();
	}
	const legacyDirectory = join(home, ".mycli", "sessions", "legacy");
	await mkdir(legacyDirectory, { recursive: true });
	await writeFile(join(legacyDirectory, "session.json"), JSON.stringify({
		schema_version: 1,
		session_id: "legacy",
		messages: [
			{ role: "user", content: "legacy question" },
			{ role: "assistant", content: "legacy answer" },
		],
	}), "utf8");

	const requests: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requests.push(JSON.parse(body) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"target resumed\"}\n\n");
			response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_target\"}}\n\n");
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "source", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));

	writeRequest(backend, "approval-resume", "session.resume", { session_id: "approval" });
	const approvalResume = await waitFor(() => response(messages, "approval-resume"));
	assert.equal(resultValue(approvalResume, "session_id"), "approval");
	const approvalEvent = await waitFor(() => sessionEvent(messages, "approval.request", "approval"));
	assert.equal(paramValue(approvalEvent, "decision_id"), "call-approval");
	writeRequest(backend, "approval-reject", "approval.respond", {
		decision_id: "call-approval",
		choice: "reject",
	});
	const approvalRejected = await waitFor(() => response(messages, "approval-reject"));
	assert.equal(resultValue(approvalRejected, "accepted"), true);
	await waitFor(() => messages.find((message) => {
		if (message.method !== "turn.completed") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.client_turn_id === "approval-client-approval";
	}));

	writeRequest(backend, "invalid-resume", "session.resume", { session_id: "invalid" });
	const invalidResume = await waitFor(() => response(messages, "invalid-resume"));
	assert.equal(errorValue(invalidResume, "code"), "session_state_invalid");
	writeRequest(backend, "status-after-failure", "status.get", {});
	const statusAfterFailure = await waitFor(() => response(messages, "status-after-failure"));
	assert.equal(resultValue(statusAfterFailure, "session_id"), "approval");
	writeRequest(backend, "invalid-suspended-resume", "session.resume", {
		session_id: "invalid-suspended",
	});
	const invalidSuspendedResume = await waitFor(() => response(messages, "invalid-suspended-resume"));
	assert.equal(errorValue(invalidSuspendedResume, "code"), "session_state_invalid");

	writeRequest(backend, "legacy-resume", "session.resume", { session_id: "legacy" });
	const legacyResume = await waitFor(() => response(messages, "legacy-resume"));
	assert.equal(resultValue(legacyResume, "session_id"), "legacy");
	assert.equal(resultValue(legacyResume, "read_only"), false);
	writeRequest(backend, "legacy-transcript", "transcript.load", { session_id: "legacy" });
	const legacyTranscript = await waitFor(() => response(messages, "legacy-transcript"));
	assert.match(JSON.stringify(resultValue(legacyTranscript, "items")), /legacy question/);

	writeRequest(backend, "target-resume", "session.resume", { session_id: "target" });
	const targetResume = await waitFor(() => response(messages, "target-resume"));
	assert.equal(resultValue(targetResume, "session_id"), "target");
	const targetStatus = await waitFor(() => sessionEvent(messages, "status.changed", "target"));
	assert.deepEqual(paramValue(targetStatus, "queued_follow_up"), ["queued target follow-up"]);
	writeRequest(backend, "target-transcript", "transcript.load", { session_id: "target" });
	const transcript = await waitFor(() => response(messages, "target-transcript"));
	assert.match(JSON.stringify(resultValue(transcript, "items")), /target question/);

	writeRequest(backend, "target-turn", "turn.submit", {
		message: "continue target",
		client_turn_id: "target-client-turn",
		client_user_message_id: "target-user-message",
	});
	await waitFor(() => messages.find((message) => {
		if (message.method !== "message.complete") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.final === true
			&& params.text === "target resumed"
			&& params.client_turn_id === "target-client-turn";
	}));
	assert.equal(requests.length, 2);
	assert.match(JSON.stringify(requests[1]?.input), /target question/);
	assert.doesNotMatch(JSON.stringify(requests[1]?.input), /source question/);

	writeRequest(backend, "shutdown", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const reopened = new SQLiteSessionStore({ dbPath });
	try {
		assert.ok(reopened.loadTurn("target", "target-client-turn"));
		assert.equal(reopened.loadTurn("source", "target-client-turn"), undefined);
	} finally {
		reopened.close();
	}
});

test("Node backend interrupts an orphaned claimed approval effect without replay", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-approval-recovery-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const dbPath = join(home, ".mycli", "sessions.db");
	const seed = new SQLiteSessionStore({ dbPath });
	try {
		seed.reserveTurn({
			sessionId: "approval-recovery",
			clientTurnId: "approval-client",
			turnId: "approval-turn",
			requestFingerprint: fingerprintSubmission({ message: "write notes", localImages: [] }),
			workspaceRoot: workspace,
			threadId: "approval-recovery",
			userText: "write notes",
			startedAt: "2026-08-04T00:00:00.000Z",
		});
		seed.appendAssistantToolCalls({
			sessionId: "approval-recovery",
			clientTurnId: "approval-client",
			assistantText: "",
			calls: [{
				callId: "call-write",
				name: "Write",
				argumentsJson: JSON.stringify({ file_path: "notes.txt", content: "hello" }),
			}],
			responseId: "resp-tools",
		});
		seed.saveApprovalSuspension({
			sessionId: "approval-recovery",
			workspaceRoot: workspace,
			threadId: "approval-recovery",
			pendingDecision: {
				kind: "pending_decision",
				version: 1,
				payload: pendingDecision("call-write") as Extract<RuntimeStateRecord, {
					kind: "pending_decision";
				}>["payload"],
			},
			suspendedTurn: {
				kind: "suspended_turn",
				version: 1,
				payload: {
					...suspendedApproval("approval-recovery", "call-write"),
					client_turn_id: "approval-client",
					turn_id: "approval-turn",
					conversation: [{ role: "user", content: "write notes" }],
				} as Extract<RuntimeStateRecord, { kind: "suspended_turn" }>["payload"],
			},
			turnRecord: {
				turn_id: "approval-turn",
				client_turn_id: "approval-client",
				user_message: "write notes",
				status: "waiting_approval",
				stop_reason: "approval_required",
				updated_at: "2026-08-04T00:00:00.000Z",
			},
			checkpoint: {
				sessionId: "approval-recovery",
				clientTurnId: "approval-client",
				turnId: "approval-turn",
				decisionId: "call-write",
				callId: "call-write",
				toolName: "Write",
				status: "waiting",
				updatedAt: "2026-08-04T00:00:00.000Z",
			},
		});
		seed.compareAndSetApproval({
			sessionId: "approval-recovery",
			expectedStatus: "waiting",
			transition: { type: "approve_once" },
		});
		seed.compareAndSetApproval({
			sessionId: "approval-recovery",
			expectedStatus: "approved",
			transition: { type: "claim_effect", fingerprint: "sha256:claimed" },
		});
	} finally {
		seed.close();
	}

	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "approval-recovery", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: "http://127.0.0.1:9/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	writeRequest(backend, "shutdown", "shutdown", {});
	assert.equal(await backend.completion, 0);

	const reopened = new SQLiteSessionStore({ dbPath });
	try {
		const turn = reopened.loadTurn("approval-recovery", "approval-client");
		assert.equal(turn?.status, "interrupted");
		assert.equal((turn?.result as Record<string, unknown> | null)?.error_kind, "effect_outcome_unknown");
		assert.equal(reopened.loadState("approval-recovery", "pending_decision"), undefined);
	} finally {
		reopened.close();
	}
});

test("Node backend restores a durably queued follow-up without provider IO", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-queue-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const options = {
		cwd: workspace,
		args: ["--session", "queue-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: "http://127.0.0.1:9/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	} as const;

	const first = await startNodeBackend(options);
	const firstMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: first.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		firstMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(firstMessages, "runtime.ready"));
	writeRequest(first, "queue", "turn.follow_up", {
		message: "persist across restart",
		client_turn_id: "queued-client",
	});
	const queued = await waitFor(() => response(firstMessages, "queue"));
	assert.equal(resultValue(queued, "queue_revision"), 1);
	writeRequest(first, "shutdown-first", "shutdown", {});
	assert.equal(await first.completion, 0);

	const second = await startNodeBackend(options);
	const secondMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: second.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		secondMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(secondMessages, "runtime.ready"));
	writeRequest(second, "bootstrap", "session.bootstrap", { protocol_version: 1 });
	const bootstrap = await waitFor(() => response(secondMessages, "bootstrap"));
	const status = resultValue(bootstrap, "status") as Record<string, unknown>;
	assert.equal(status.queue_revision, 1);
	assert.deepEqual(status.queued_follow_up, ["persist across restart"]);
	const migration = resultValue(bootstrap, "legacy_user_queue_migration") as Record<string, unknown>;
	assert.equal((migration.records as Array<Record<string, unknown>>)[0]?.text, "persist across restart");
	writeRequest(second, "shutdown-second", "shutdown", {});
	assert.equal(await second.completion, 0);
});

function writeRequest(
	backend: Awaited<ReturnType<typeof startNodeBackend>>,
	id: string,
	method: string,
	params: Record<string, unknown>,
): void {
	backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function event(messages: Array<Record<string, unknown>>, method: string): Record<string, unknown> | undefined {
	return messages.find((message) => message.method === method && !("id" in message));
}

function sessionEvent(
	messages: Array<Record<string, unknown>>,
	method: string,
	sessionId: string,
): Record<string, unknown> | undefined {
	return messages.find((message) => message.method === method
		&& !("id" in message)
		&& paramValue(message, "session_id") === sessionId);
}

function response(
	messages: Array<Record<string, unknown>>,
	id: string,
): Record<string, unknown> | undefined {
	return messages.find((message) => String(message.id) === id);
}

function resultValue(message: Record<string, unknown>, key: string): unknown {
	const result = message.result;
	return typeof result === "object" && result !== null && !Array.isArray(result)
		? (result as Record<string, unknown>)[key]
		: undefined;
}

function errorValue(message: Record<string, unknown>, key: string): unknown {
	const error = message.error;
	return typeof error === "object" && error !== null && !Array.isArray(error)
		? (error as Record<string, unknown>)[key]
		: undefined;
}

function paramValue(message: Record<string, unknown>, key: string): unknown {
	const params = message.params;
	return typeof params === "object" && params !== null && !Array.isArray(params)
		? (params as Record<string, unknown>)[key]
		: undefined;
}

function seedCompletedSession(
	store: SQLiteSessionStore,
	workspaceRoot: string,
	sessionId: string,
	userText: string,
	assistantText: string,
): void {
	store.reserveTurn({
		sessionId,
		clientTurnId: `seed-client-${sessionId}`,
		turnId: `seed-turn-${sessionId}`,
		requestFingerprint: fingerprintSubmission({ message: userText, localImages: [] }),
		workspaceRoot,
		threadId: sessionId,
		userText,
		startedAt: "2026-08-04T00:00:00.000Z",
	});
	store.completeTurn({
		sessionId,
		clientTurnId: `seed-client-${sessionId}`,
		assistantText,
		usage: {},
		completedAt: "2026-08-04T00:00:01.000Z",
	});
}

function seedWaitingApproval(
	store: SQLiteSessionStore,
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
			argumentsJson: JSON.stringify({ file_path: "notes.txt", content: "hello" }),
		}],
		responseId: "resp-tools",
	});
	store.saveApprovalSuspension({
		sessionId,
		workspaceRoot,
		threadId: sessionId,
		pendingDecision: {
			kind: "pending_decision",
			version: 1,
			payload: pendingDecision(callId) as Extract<RuntimeStateRecord, {
				kind: "pending_decision";
			}>["payload"],
		},
		suspendedTurn: {
			kind: "suspended_turn",
			version: 1,
			payload: {
				...suspendedApproval(sessionId, callId),
				user_message: userText,
				client_turn_id: clientTurnId,
				turn_id: turnId,
				conversation: [{ role: "user", content: userText }],
				continuation: {
					assistant_text: "",
					response_id: "resp-tools",
					usage: {},
				},
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

function pendingDecision(callId: string): Record<string, unknown> {
	return {
		tool_call: {
			name: "Write",
			arguments: { file_path: "notes.txt", content: "hello" },
			reason: "Update notes",
			call_id: callId,
		},
		kind: "needs_choice",
		reason: "A workspace file will change.",
		preview: "Write notes.txt",
		options: ["approve_once", "reject"],
		command_pattern: null,
		proposed_execpolicy_pattern: null,
		metadata: {},
	};
}

function suspendedApproval(sessionId: string, callId: string): Record<string, unknown> {
	return {
		user_message: "update the notes",
		conversation: [],
		suspend_reason: "approval_required",
		plan_items: [],
		pending_approval: {
			tool_call: pendingDecision(callId).tool_call,
			reason: "A workspace file will change.",
			preview: "Write notes.txt",
			command_pattern: null,
			proposed_execpolicy_pattern: null,
			metadata: {},
		},
		pending_clarification: null,
		session_id: sessionId,
		client_turn_id: `approval-client-${sessionId}`,
		turn_id: `approval-turn-${sessionId}`,
		provider_protocol: "responses",
		remaining_tool_calls: [],
		continuation: {},
	};
}

function queuedFollowUp(sessionId: string): Record<string, unknown> {
	return {
		session_id: sessionId,
		revision: 1,
		pending_steers: [],
		rejected_steers: [],
		follow_ups: [{
			queue_id: "queue-target",
			session_id: sessionId,
			client_turn_id: "queue-client-target",
			target_turn_id: null,
			kind: "follow_up",
			state: "queued",
			text: "queued target follow-up",
			image_paths: [],
			source: "user",
			created_at: "2026-08-04T00:00:02.000Z",
			updated_at: "2026-08-04T00:00:02.000Z",
		}],
	};
}

function compactCheckpoint(): Record<string, unknown> {
	return {
		version: 1,
		turn_id: "seed-turn-target",
		reason: "context_limit",
		phase: "before_provider",
		window_number: 1,
		window_id: "window-target",
		history_item_count: 2,
		input_history_hash: "sha256:input",
		replacement_history_hash: "sha256:replacement",
		replacement_messages: [],
	};
}

function responsesContinuation(sessionId: string): Record<string, unknown> {
	return {
		response_id: "resp-seed",
		request_signature: "sha256:request",
		request_input: [],
		response_output: [],
		eligible: true,
		failure_reason: null,
		session_id: sessionId,
		protocol: "responses",
		model: "gpt-test",
		history_boundary: "history-2",
	};
}

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("timed out waiting for Node backend");
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { WorkspaceTrustStore } from "@mycli/config";
import { parseSessionGoal } from "@mycli/contracts";
import { openRuntimeSessionStore } from "@mycli/storage";
import { startTestNodeBackend } from "./support/offline-update-fetch.ts";
import { responsesTextEvents, writeResponsesEvents, writeResponsesText, writeResponsesTool } from "./support/responses-sse.ts";

type Message = { id?: string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };
const usage = { input_tokens: 10, output_tokens: 2 };

async function fixture(
	t: { after(fn: () => unknown): void },
	respond: (response: ServerResponse, step: number, request: Record<string, unknown>) => void,
	maxPromptTokens = 100000,
	env: Record<string, string> = {},
) {
	const root = await mkdtemp(join(tmpdir(), "mycli-goal-backend-"));
	const homeDir = join(root, "home"); const workspace = join(root, "workspace");
	await Promise.all([mkdir(homeDir), mkdir(workspace)]);
	await new WorkspaceTrustStore({ homeDir }).save(workspace, "trusted");
	const requests: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let body = ""; request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requests.push(JSON.parse(body) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "text/event-stream" });
			respond(response, requests.length, requests.at(-1)!);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const options = { cwd: workspace, args: ["--session", "goal-session", "--model", "gpt-test"], env: {
		HOME: homeDir, MYCLI_API_KEY: "test-key", MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses", MYCLI_THINKING_ENABLED: "false", MYCLI_MAX_PROMPT_TOKENS: String(maxPromptTokens),
		...env,
	} };
	const backend = await startTestNodeBackend(options);
	const messages: Message[] = [];
	const lines = createInterface({ input: backend.transport.input, crlfDelay: Infinity });
	lines.on("line", (line) => { messages.push(JSON.parse(line) as Message); });
	t.after(async () => { await backend.close(); lines.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
	let id = 0;
	const rpc = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
		const requestId = String(++id);
		backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
		await waitFor(() => messages.some((message) => message.id === requestId));
		const response = messages.find((message) => message.id === requestId)!;
		assert.equal(response.error, undefined, JSON.stringify(response.error));
		return response.result!;
	};
	await waitFor(() => messages.some((message) => message.method === "runtime.ready"));
	await rpc("session.bootstrap", { protocol_version: 1 });
	return { backend, messages, requests, rpc, options, homeDir };
}

function text(response: ServerResponse, step: number, value: string): void {
	writeResponsesText(response, value, `resp-${step}`, usage); response.end("data: [DONE]\n\n");
}
function tool(response: ServerResponse, step: number, name: string, args: Record<string, unknown>): void {
	writeResponsesTool(response, `call-${step}`, name, args, `resp-${step}`, usage); response.end("data: [DONE]\n\n");
}

test("model-created goal continues through the ordinary Worker path and completes durably", async (t) => {
	const f = await fixture(t, (response, step) => {
		if (step === 1) tool(response, step, "create_goal", { objective: "Verify the fixture", token_budget: 100 });
		else if (step === 2) text(response, step, "Initial progress saved.");
		else if (step === 3) tool(response, step, "get_goal", {});
		else if (step === 4) tool(response, step, "update_goal", { status: "complete" });
		else text(response, step, "Verified fixture; goal complete.");
	});
	await f.rpc("turn.submit", { message: "Create a goal to verify the fixture and continue until complete.", client_turn_id: "human", client_user_message_id: "human" });
	await waitFor(() => f.messages.filter((message) => message.method === "turn.completed").length === 2);
	const goal = parseSessionGoal((await f.rpc("goal.get")).goal);
	assert.equal(goal.status, "complete"); assert.equal(goal.rounds_started, 1); assert.equal(goal.tokens_used, 48);
	assert.equal(f.requests.length, 5);
	assert.ok(f.messages.some((message) => message.method === "turn.started" && message.params?.source === "goal"));
	const transcript = (await f.rpc("transcript.load", { limit: 100 })).items as { type: string; text: string }[];
	assert.equal(transcript.filter((item) => item.type === "user").length, 1, JSON.stringify(transcript.map((item) => ({ type: item.type, text: item.text?.slice(0, 90) }))));
	assert.equal(transcript.filter((item) => item.type === "system_notice" && item.text === "Continuing goal").length, 1);
	assert.match(JSON.stringify(f.requests[2]), /Automatic goal continuation/);
	await f.backend.close();
	const store = openRuntimeSessionStore({ dbPath: join(f.homeDir, ".mycli", "sessions.db") });
	try { assert.equal(store.goals.get("goal-session")?.status, "complete"); assert.equal(store.goals.get("goal-session")?.tokens_used, 48); }
	finally { store.close(); }
});

test("direct goal budget stops continuation and pause cancels an active request", async (t) => {
	let held: ServerResponse | undefined;
	const f = await fixture(t, (response, step) => {
		if (step === 1) text(response, step, "Budget consumed.");
		else held = response;
	});
	await f.rpc("command.run", { command: "/goal --tokens 10 Verify the budget", surface: "tui" });
	await waitFor(() => f.messages.some((message) => message.method === "turn.completed"));
	let goal = parseSessionGoal((await f.rpc("goal.get")).goal);
	assert.equal(goal.status, "budget_limited"); assert.equal(goal.tokens_used, 12);
	await f.rpc("command.run", { command: "/goal budget off", surface: "tui" });
	await f.rpc("command.run", { command: "/goal resume", surface: "tui" });
	await waitFor(() => held !== undefined);
	await f.rpc("command.run", { command: "/goal pause", surface: "tui" });
	goal = parseSessionGoal((await f.rpc("goal.get")).goal);
	assert.equal(goal.status, "paused");
	assert.equal((await f.rpc("status.inspect")).turn_running, false);
	assert.equal(f.requests.length, 2);
	await f.backend.close();
	const store = openRuntimeSessionStore({ dbPath: join(f.homeDir, ".mycli", "sessions.db") });
	try {
		const preferences = store.loadState("goal-session", "session_preferences") as { model: string; collaboration_mode: string };
		assert.equal(preferences.model, "gpt-test");
		assert.equal(preferences.collaboration_mode, "default");
	} finally { store.close(); }
});

test("a provider response without usage stops a budgeted goal through the Worker", async (t) => {
	const f = await fixture(t, (response, step) => {
		writeResponsesEvents(response, responsesTextEvents("Progress without usage", `resp-${step}`).map((event) => {
			if (event.type !== "response.completed") return event;
			const completed = { ...(event.response as Record<string, unknown>) };
			delete completed.usage;
			return { ...event, response: completed };
		}));
		response.end("data: [DONE]\n\n");
	});
	await f.rpc("goal.update", { action: "create", objective: "Verify incomplete usage", token_budget: 100 });
	await waitFor(() => f.messages.some((message) => message.method === "turn.completed"));
	const goal = parseSessionGoal((await f.rpc("goal.get")).goal);
	assert.equal(goal.status, "budget_limited");
	assert.equal(goal.usage_incomplete, true);
	assert.equal(goal.tokens_used, 0);
	assert.equal(f.requests.length, 1);
});

test("child Worker usage follows each goal when an idle agent is reused", async (t) => {
	let rootRequests = 0;
	let childRequests = 0;
	const f = await fixture(t, (response, step, request) => {
		const isRoot = Array.isArray(request.tools) && request.tools.some((entry: { name?: string }) => entry.name === "create_goal");
		if (!isRoot) { childRequests += 1; text(response, step, "Child fixture verified."); return; }
		rootRequests += 1;
		const phase = (rootRequests - 1) % 4;
		if (phase === 0) {
			if (rootRequests === 1) tool(response, step, "spawn_agent", { task_name: "goal_fixture", message: "Verify the child fixture." });
			else tool(response, step, "followup_task", { target: "goal_fixture", message: "Verify the fixture again for the second goal." });
		} else if (phase === 1) tool(response, step, "wait_agent", { timeout_ms: 5000 });
		else if (phase === 2) tool(response, step, "update_goal", { status: "complete" });
		else text(response, step, "Child report verified; goal complete.");
	});
	for (const objective of ["First child goal", "Second child goal"]) {
		const completed = f.messages.filter((message) => message.method === "turn.completed").length;
		await f.rpc("goal.update", { action: "create", objective, token_budget: 1000 });
		await waitFor(() => f.messages.filter((message) => message.method === "turn.completed").length > completed);
		const goal = parseSessionGoal((await f.rpc("goal.get")).goal);
		assert.equal(goal.status, "complete");
		assert.equal(goal.tokens_used, 60, JSON.stringify({ objective, rootRequests, childRequests,
			transcript: (await f.rpc("transcript.load", { limit: 30 })).items }));
	}
	assert.equal(childRequests, 2);
	assert.equal(rootRequests, 8);
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 15000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Goal integration fixture timed out");
		await setTimeout(10);
	}
}


test("compaction after goal completion remains attributed and rehydrates the objective", async (t) => {
	let normalStep = 0;
	const f = await fixture(t, (response, step, request) => {
		if (!Array.isArray(request.tools) || request.tools.length === 0) { text(response, step, "Progress preserved by context compaction."); return; }
		normalStep += 1;
		if (normalStep === 1) tool(response, step, "create_goal", { objective: "Verify the fixture after compaction" });
		else if (normalStep === 2) text(response, step, "Initial progress saved.");
		else if (normalStep === 3) tool(response, step, "get_goal", {});
		else if (normalStep === 4) tool(response, step, "update_goal", { status: "complete" });
		else text(response, step, "Verified after compaction.");
	}, 12000, {
		// The fixture must compact without a long conversation, so it sets its own
		// ceiling instead of relying on the carried prefix to fill the budget.
		MYCLI_COMPACTION_TOKEN_LIMIT: "200",
		MYCLI_COMPACTION_RESERVED_OUTPUT_TOKENS: "100",
	});
	await f.rpc("turn.submit", { message: "Create a goal and verify the fixture.", client_turn_id: "compaction-human", client_user_message_id: "compaction-human" });
	await waitFor(() => f.messages.filter((message) => message.method === "turn.completed").length === 2);
	const goal = parseSessionGoal((await f.rpc("goal.get")).goal);
	assert.equal(goal.status, "complete");
	assert.ok(f.requests.length > normalStep, "fixture must actually compact");
	assert.equal(goal.tokens_used, (f.requests.length - 1) * 12);
	assert.match(JSON.stringify(f.requests.at(-1)), /Verify the fixture after compaction/);
	assert.match(JSON.stringify(f.requests.at(-1)), /compact-summary/);
});

test("a goal budget interrupt preserves its reason through the Worker and transcript replay", async (t) => {
	const f = await fixture(t, (response, step) => tool(response, step, "Read", { file_path: "README.md" }));
	await f.rpc("goal.update", { action: "create", objective: "Read the fixture", token_budget: 10 });
	await waitFor(() => f.messages.some((message) => message.method === "turn.interrupted" && message.params?.requested === false));
	const interrupted = f.messages.find((message) => message.method === "turn.interrupted" && message.params?.requested === false);
	assert.equal(interrupted?.params?.interruption_reason, "goal_budget");
	const transcript = await f.rpc("transcript.load", { session_id: "goal-session", limit: 100 });
	assert.match(JSON.stringify(transcript), /Goal token budget reached/);
	assert.doesNotMatch(JSON.stringify(transcript), /send a new message to continue/);
	assert.equal(f.requests.length, 1);
});

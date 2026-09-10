import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceTrustStore } from "@mycli/config";
import { GatewayClient, type GatewayEvent } from "@mycli/gateway";
import { startTestNodeBackend } from "./support/offline-update-fetch.ts";
import { writeResponsesText, writeResponsesTool } from "./support/responses-sse.ts";
import type { NodeBackend } from "../src/node-runtime/node-backend.ts";
import {
	initialRuntimeState,
} from "../../../../tui/mycli-shell/src/state/runtime-state-model.ts";
import {
	projectRuntimeState,
} from "../../../../tui/mycli-shell/src/state/runtime-projection.ts";
import {
	reduceRuntimeEvent,
} from "../../../../tui/mycli-shell/src/state/runtime-event-reducer.ts";
import {
	runtimeStateFromTranscript,
} from "../../../../tui/mycli-shell/src/state/transcript-history.ts";

test("Worker terminal interactions reach the TUI and survive backend restart", { timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-terminal-interaction-"));
	const homeDir = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(homeDir);
	await mkdir(workspace);
	await new WorkspaceTrustStore({ homeDir }).save(workspace, "trusted");
	await writeFile(join(workspace, "interactive.cjs"), [
		"process.stdin.setRawMode(true);",
		"process.stdout.write('ready\\n');",
		"setTimeout(() => process.stdout.write('tick\\n'), 750);",
		"require('node:readline').createInterface({ input: process.stdin }).on('line', value => {",
		"  if (value === 'done') process.exit(0);",
		"});",
	].join("\n"));
	let state = initialRuntimeState();
	const events: GatewayEvent[] = [];
	let requestCount = 0;
	let fixtureFailure: unknown;
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			void (async () => {
				requestCount += 1;
				const body = JSON.parse(raw) as { input?: unknown };
				const shellId = /Process running with session ID ([0-9a-f]{8})/u.exec(JSON.stringify(body.input))?.[1];
				if (requestCount === 5) await waitUntil(() => events.some((event) => event.method === "shell.completed"));
				response.writeHead(200, { "content-type": "text/event-stream" });
				if (requestCount === 1) writeResponsesTool(response, "shell-call", "Shell", {
					command: `"${process.execPath}" interactive.cjs`, tty: true, yield_time_ms: 250,
				}, "response-shell");
				else if (requestCount <= 5) {
					assert.ok(shellId);
					const callId = ["", "", "poll-live", "input-hello", "input-done", "poll-ended"][requestCount]!;
					writeResponsesTool(response, callId, "WriteStdin", { session_id: shellId,
						...(requestCount === 3 ? { chars: "hello\n", yield_time_ms: 250 }
							: requestCount === 4 ? { chars: "done\n", yield_time_ms: 250 } : {}) }, `response-${callId}`);
				} else writeResponsesText(response, "Terminal interactions completed.", "response-final");
				response.end("data: [DONE]\n\n");
			})().catch((error: unknown) => { fixtureFailure = error; response.destroy(); });
		});
	});
	let backend: NodeBackend | undefined;
	let client: GatewayClient | undefined;
	t.after(async () => {
		client?.expectClose();
		try { await backend?.close(); }
		finally {
			client?.stop();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const options = { cwd: workspace, args: ["--session", "terminal-interactions", "--model", "gpt-test"], env: {
		...process.env, HOME: homeDir, USERPROFILE: homeDir,
		MYCLI_API_KEY: "test-key", MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses", MYCLI_THINKING_ENABLED: "false",
		MYCLI_REQUEST_MAX_RETRIES: "0", MYCLI_STREAM_MAX_RETRIES: "0", MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
	} };
	backend = await startTestNodeBackend(options);
	let observedWait = false;
	client = new GatewayClient({ ...backend.transport, log: (event) => {
		events.push(event);
		state = reduceRuntimeEvent(state, event.method, event.params);
		observedWait ||= state.liveStatus?.kind === "waiting_background_terminal";
	} });
	client.start();
	await client.waitForEvent("runtime.ready");
	await client.request("permissions.update", { profile: "full-access" });
	await client.request("turn.submit", { message: "Interact with the terminal.", client_turn_id: "terminal-turn", client_user_message_id: "terminal-user" });
	try {
		await waitUntil(() => events.some((event) => event.method === "turn.completed" || event.method === "turn.failed"));
	} catch {
		assert.fail(JSON.stringify({ requestCount, fixtureFailure: String(fixtureFailure),
			events: events.slice(-18).map((event) => ({ method: event.method, ...event.params })) }));
	}
	assert.equal(events.some((event) => event.method === "turn.failed"), false,
		JSON.stringify(events.filter((event) => event.method === "turn.failed")));
	assert.equal(fixtureFailure, undefined);
	assert.equal(requestCount, 6);
	assert.equal(observedWait, true);
	const interactions = projectRuntimeState(state).tools.filter((tool) => tool.terminalInteraction);
	assert.deepEqual(interactions.map((tool) => tool.terminalInteraction?.kind), ["poll", "input", "input"]);
	assert.ok(interactions.every((tool) => tool.terminalInteraction?.interaction_succeeded === true),
		JSON.stringify(interactions));
	assert.ok(interactions.every((tool) => tool.terminalInteraction?.command_preview?.includes("interactive.cjs")));
	assert.equal(projectRuntimeState(state).bash.length, 1);
	const record = events.find((event) => event.method === "tool.complete" && event.params.call_id === "input-hello");
	assert.ok(record?.method === "tool.complete" && record.params.tool_record?.terminal_interaction);
	client.expectClose();
	await client.request("shutdown", {});
	assert.equal(await backend.completion, 0);
	client.stop();
	backend = await startTestNodeBackend(options);
	client = new GatewayClient(backend.transport);
	client.start();
	await client.waitForEvent("runtime.ready");
	const transcript = await client.request("transcript.load", {});
	const restored = projectRuntimeState(runtimeStateFromTranscript(initialRuntimeState(), transcript));
	assert.deepEqual(restored.tools.filter((tool) => tool.terminalInteraction).map((tool) => tool.terminalInteraction),
		interactions.map((tool) => tool.terminalInteraction));
	assert.equal(restored.bash.length, 1);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for terminal completion");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GatewayClient, type GatewayEvent } from "@mycli/gateway";
import {
	startBackendService, type BackendService, type BackendClientAttachment, type BackendClientRole,
} from "../../src/backend.ts";
import { responsesTextEvents, responsesToolEvents, writeResponsesEvents } from "../support/responses-sse.ts";
import { shellCommand } from "../support/shell-command.ts";

test("supervised service shares its active session and survives all clients disconnecting", { timeout: 20_000 }, async (t) => {
	const fixture = await serviceFixture(t);
	const service = await fixture.start();
	const controller = await fixture.connect("controller");
	const observer = await fixture.connect("observer");
	const initial = await Promise.all([controller, observer].map(({ client }) => (
		client.request("session.bootstrap", { protocol_version: 1 })
	)));
	assert.deepEqual(initial.map((result) => result.session_id), ["shared-session", "shared-session"]);
	assert.ok(initial.every((result) => result.workspace === fixture.workspace));
	await assert.rejects(observer.client.request("session.new", {}), { code: "read_only_client" });
	const created = await controller.client.request("session.new", {});
	assert.notEqual(created.session_id, "shared-session");
	assert.equal((await observer.client.request("session.bootstrap", { protocol_version: 1 })).session_id, created.session_id);
	await Promise.all([controller.attachment.close(), observer.attachment.close()]);
	assert.deepEqual(service.snapshot(), { state: "running", clients: [] });

	const replacement = await fixture.connect("controller");
	assert.equal((await replacement.client.request("session.bootstrap", { protocol_version: 1 })).session_id, created.session_id);
	const next = await replacement.client.request("session.new", {});
	assert.notEqual(next.session_id, created.session_id);
	assert.ok(next.generation > created.generation);
	replacement.client.expectClose();
	assert.deepEqual(await replacement.client.request("shutdown", {}), { ok: true });
	assert.equal(await service.completion, 0);
	assert.equal(service.snapshot().state, "closed");
});

test("replacement controller resumes a pending approval and a running command without replay", { timeout: 30_000 }, async (t) => {
	const fixture = await serviceFixture(t);
	await writeFile(join(fixture.workspace, "wait.cjs"), [
		"const fs = require('node:fs');",
		"fs.appendFileSync('executions', 'once\\n');",
		"process.stdout.write('command-ready\\n');",
		"const timer = setInterval(() => {",
		"  if (!fs.existsSync('finish-command')) return;",
		"  clearInterval(timer);",
		"  process.stdout.write('command-finished\\n');",
		"}, 10);",
	].join("\n"));
	const requests: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => { raw += chunk; });
		request.on("end", () => {
			requests.push(JSON.parse(raw) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "text/event-stream" });
			writeResponsesEvents(response, requests.length === 1
				? responsesToolEvents("call-shared-shell", "Shell", {
					command: shellCommand(process.execPath, ["wait.cjs"], fixture.shellEnvironment),
					yield_time_ms: 30_000, sandbox_permissions: "require_escalated",
					justification: "Run the shared command with the access required by the approval test.",
				})
				: responsesTextEvents("Command completed once.", "resp-final"));
			response.end();
		});
	});
	t.after(async () => {
		server.closeAllConnections();
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const service = await fixture.start({
		MYCLI_API_KEY: "test-key", MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses", MYCLI_THINKING_ENABLED: "false",
		MYCLI_REQUEST_MAX_RETRIES: "0", MYCLI_STREAM_MAX_RETRIES: "0", MYCLI_CACHE_RETENTION: "none",
	});
	const controller = await fixture.connect("controller");
	const observer = await fixture.connect("observer");
	await controller.client.request("workspace.trust.set", { state: "trusted" });
	await controller.client.request("permissions.update", { profile: "workspace" });
	await controller.client.request("turn.submit", {
		message: "Run the command once.", client_turn_id: "shared-turn", client_user_message_id: "shared-user",
	});
	const approval = await observer.client.waitForEvent("approval.request");
	assert.ok(approval.method === "approval.request");
	assert.equal(approval.params.call_id, "call-shared-shell");
	const decision = { decision_id: "call-shared-shell", choice: "approve_once" } as const;
	await assert.rejects(observer.client.request("approval.respond", decision), { code: "read_only_client" });
	await controller.attachment.close();
	assert.equal(service.snapshot().state, "running");
	assert.equal(requests.length, 1);

	const approving = await fixture.connect("controller");
	await approving.client.request("status.get", {});
	assert.equal(approving.events.filter((event) => event.method === "approval.request").length, 0);
	assert.equal((await approving.client.request("session.bootstrap", { protocol_version: 1 })).session_id, "shared-session");
	const restored = await approving.client.waitForEvent("approval.request");
	assert.ok(restored.method === "approval.request");
	assert.equal(restored.params.decision_id, approval.params.decision_id);
	assert.equal(restored.params.command_preview, approval.params.command_preview);
	assert.equal(restored.params.justification, approval.params.justification);
	await approving.client.request("approval.respond", decision);
	await observer.client.waitForEvent("shell.output", (event) => (
		event.method === "shell.output" && String(event.params.output_delta).includes("command-ready")
	));
	await approving.attachment.close();
	assert.equal(requests.length, 1);
	assert.equal(observer.events.filter((event) => event.method === "turn.completed").length, 0);

	const finishing = await fixture.connect("controller");
	const running = await finishing.client.request("session.bootstrap", { protocol_version: 1 });
	assert.equal(running.status?.turn_id, approval.params.turn_id);
	await writeFile(join(fixture.workspace, "finish-command"), "go");
	await Promise.all([observer, finishing].map(({ client }) => client.waitForEvent("turn.completed")));
	const final = await finishing.client.waitForEvent("message.complete", (event) => (
		event.method === "message.complete" && event.params.final === true
	));
	assert.ok(final.method === "message.complete");
	assert.equal(final.params.text, "Command completed once.");
	assert.equal(requests.length, 2);
	assert.equal(await readFile(join(fixture.workspace, "executions"), "utf8"), "once\n");
	assert.equal(observer.events.filter((event) => event.method === "shell.started").length, 1);
	assert.equal(observer.events.filter((event) => event.method === "shell.completed").length, 1);
	assert.equal(observer.events.filter((event) => event.method === "tool.failed").length, 0);
	const history = await observer.client.request("transcript.load", {});
	const tools = history.items.filter((item) => item.tool_record?.call_id === "call-shared-shell");
	assert.equal(tools.length, 1);
	assert.equal(tools[0]?.tool_record?.shell?.terminal_state, "completed");
});

test("replacement controller can answer the existing live clarification", { timeout: 20_000 }, async (t) => {
	const fixture = await serviceFixture(t);
	let requests = 0;
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			writeResponsesEvents(response, ++requests === 1
				? responsesToolEvents("call-live-question", "AskUserQuestion", {
					question: "Which runtime?", options: [{ label: "Node" }, { label: "Python" }],
					header: "Runtime", multi_select: false,
				})
				: responsesTextEvents("Node selected.", "resp-answer"));
			response.end();
		});
	});
	t.after(async () => {
		server.closeAllConnections();
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await fixture.start({
		MYCLI_API_KEY: "test-key", MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses", MYCLI_THINKING_ENABLED: "false",
		MYCLI_REQUEST_MAX_RETRIES: "0", MYCLI_STREAM_MAX_RETRIES: "0", MYCLI_CACHE_RETENTION: "none",
	});
	const first = await fixture.connect("controller");
	await first.client.request("workspace.trust.set", { state: "trusted" });
	await first.client.request("turn.submit", {
		message: "Ask before choosing.", client_turn_id: "question-turn", client_user_message_id: "question-user",
		collaboration_mode: "plan",
	});
	const pending = await first.client.waitForEvent("clarify.request");
	assert.ok(pending.method === "clarify.request");
	await first.client.waitForEvent("status.changed", (event) => (
		event.method === "status.changed" && event.params.pending_clarification === true
		&& event.params.turn_running === false
	));
	await first.attachment.close();
	const second = await fixture.connect("controller");
	await second.client.request("session.bootstrap", { protocol_version: 1 });
	const restored = await second.client.waitForEvent("clarify.request");
	assert.ok(restored.method === "clarify.request");
	assert.equal(restored.params.request_id, pending.params.request_id);
	assert.equal(requests, 1);
	await second.client.request("clarify.respond", { request_id: restored.params.request_id, response: "Node" });
	await second.client.waitForEvent("turn.completed");
	assert.equal(requests, 2);
	const history = await second.client.request("transcript.load", {});
	assert.equal(history.items.some((item) => item.type === "clarification" && item.text === "Node"), true);
});

interface ConnectedClient {
	readonly attachment: BackendClientAttachment;
	readonly client: GatewayClient;
	readonly events: GatewayEvent[];
}

async function serviceFixture(t: TestContext): Promise<{
	readonly workspace: string;
	readonly shellEnvironment: Readonly<NodeJS.ProcessEnv>;
	readonly start: (env?: NodeJS.ProcessEnv) => Promise<BackendService>;
	readonly connect: (role: BackendClientRole) => Promise<ConnectedClient>;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-backend-service-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const clients: GatewayClient[] = [];
	let service: BackendService | undefined;
	t.after(async () => {
		try { await service?.close(); }
		finally {
			for (const client of clients) client.stop();
			await rm(root, { recursive: true, force: true });
		}
	});
	await mkdir(join(home, ".mycli"), { recursive: true });
	await mkdir(workspace);
	await writeFile(join(home, ".mycli", "config.toml"), "[updates]\ncheck_on_startup = false\n");
	const shellEnvironment = Object.freeze({
		HOME: home,
		USERPROFILE: home,
		PATH: process.env.PATH,
	});
	return {
		workspace,
		shellEnvironment,
		start: async (env = {}) => {
			service = await startBackendService({
				cwd: workspace, args: ["--session", "shared-session", "--model", "gpt-test"],
				env: { ...shellEnvironment, ...env },
			});
			return service;
		},
		connect: async (role) => {
			assert.ok(service);
			const attachment = service.attach({ role });
			const events: GatewayEvent[] = [];
			const client = new GatewayClient({ ...attachment.transport, log: (event) => events.push(event) });
			clients.push(client);
			client.start();
			await client.waitForEvent("runtime.ready");
			return { attachment, client, events };
		},
	};
}

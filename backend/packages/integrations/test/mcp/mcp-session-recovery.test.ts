import assert from "node:assert/strict";
import test from "node:test";
import { McpClient, type McpServerConfig } from "../../src/index.ts";
import { McpRequestError } from "../../src/mcp/diagnostics.ts";

test("expired Streamable HTTP sessions initialize again and replay the rejected call once", async (t) => {
	const fixture = httpFixture((request) => request.method === "tools/call" && request.session === "session-1" ? expired() : undefined);
	const client = fixture.client;
	t.after(() => client.close());
	const result = await client.callTool("change", {}, signal());
	assert.equal(result.isError, false);
	assert.equal(fixture.count("initialize"), 2);
	assert.equal(fixture.count("tools/call"), 2);
	assert.equal(fixture.effects(), 1);
	assert.equal(fixture.count("GET") > 0, true);
	await client.listResources(signal());
	assert.equal(fixture.count("initialize"), 2);
});

test("concurrent expirations share recovery and let other requests on the old connection finish", async (t) => {
	const slowStarted = deferred<void>();
	const finishSlow = deferred<void>();
	const allExpired = deferred<void>();
	let rejected = 0;
	const fixture = httpFixture(async (request) => {
		if (request.method !== "tools/call" || request.session !== "session-1") return;
		if (request.params?.name === "slow") {
			slowStarted.resolve();
			await finishSlow.promise;
			return;
		}
		if (++rejected === 3) allExpired.resolve();
		await allExpired.promise;
		return expired();
	});
	t.after(() => fixture.client.close());
	const slow = fixture.client.callTool("slow", {}, signal());
	await slowStarted.promise;
	const results = await Promise.all(["a", "b", "c"].map((name) => fixture.client.callTool(name, {}, signal())));
	assert.ok(results.every((result) => !result.isError));
	assert.equal(fixture.count("initialize"), 2);
	finishSlow.resolve();
	assert.equal((await slow).isError, false);
	assert.equal(fixture.effects(), 4);
});

test("cancelling one recovery waiter does not cancel the shared handshake or replay that call", async (t) => {
	const recovering = deferred<void>();
	const resume = deferred<void>();
	const allExpired = deferred<void>();
	let initializations = 0;
	let expiredCalls = 0;
	const fixture = httpFixture(async (request) => {
		if (request.method === "initialize" && ++initializations === 2) {
			recovering.resolve();
			await resume.promise;
		}
		if (request.method === "tools/call" && request.session === "session-1") {
			if (++expiredCalls === 2) allExpired.resolve();
			await allExpired.promise;
			return expired();
		}
		return;
	});
	t.after(() => fixture.client.close());
	await fixture.client.listTools(signal());
	const controller = new AbortController();
	const cancelled = assert.rejects(fixture.client.callTool("cancelled", {}, controller.signal), { name: "AbortError" });
	const active = fixture.client.callTool("active", {}, signal());
	await recovering.promise;
	controller.abort();
	await cancelled;
	resume.resolve();
	assert.equal((await active).isError, false);
	assert.equal(fixture.count("initialize"), 2);
	assert.equal(fixture.requests.filter((request) => request.params?.name === "cancelled").length, 1);
	assert.equal(fixture.effects(), 1);
});

for (const action of ["cancel", "close"] as const) {
	test(`${action} during recovery stops the handshake and starts no later call`, { timeout: 2_000 }, async (t) => {
		const recovering = deferred<void>();
		let initializations = 0;
		const fixture = httpFixture(async (request, requestSignal) => {
			if (request.method === "initialize" && ++initializations === 2) {
				recovering.resolve();
				await untilAborted(requestSignal);
			}
			return request.method === "tools/call" ? expired() : undefined;
		});
		t.after(() => fixture.client.close());
		const controller = new AbortController();
		const result = assert.rejects(fixture.client.callTool("change", {}, controller.signal), { name: "AbortError" });
		await recovering.promise;
		if (action === "cancel") controller.abort();
		else await fixture.client.close();
		await result;
		assert.equal(fixture.count("initialize"), 2);
		assert.equal(fixture.count("tools/call"), 1);
		assert.equal(fixture.effects(), 0);
		if (action === "close") await assert.rejects(fixture.client.callTool("later", {}, signal()), /mcp_client_closed/u);
	});
}

test("recovery is bounded even when the new session also returns 404", async (t) => {
	const fixture = httpFixture((request) => request.method === "tools/call" ? expired() : undefined);
	t.after(() => fixture.client.close());
	await assert.rejects(fixture.client.callTool("change", {}, signal()), (error: unknown) => {
		assert.ok(error instanceof McpRequestError);
		assert.deepEqual(error.failure.details, { operation: "tools/call", phase: "request", http_status: 404,
			transport_code: "mcp_session_expired", recovery_attempts: 1 });
		assert.deepEqual(error.failure.outcome, { state: "not_started", effects: "none" });
		return true;
	});
	assert.equal(fixture.count("initialize"), 2);
	assert.equal(fixture.count("tools/call"), 2);
});

test("a failed recovery handshake retains its stage and permits a later explicit request", async (t) => {
	let initializations = 0;
	const fixture = httpFixture((request) => {
		if (request.method === "initialize" && ++initializations === 2) return new Response("private initialization failure", { status: 503 });
		return request.method === "tools/call" && request.session === "session-1" ? expired() : undefined;
	});
	t.after(() => fixture.client.close());
	await assert.rejects(fixture.client.callTool("change", {}, signal()), (error: unknown) => {
		assert.ok(error instanceof McpRequestError);
		assert.deepEqual(error.failure.details, { operation: "initialize", phase: "reconnect", http_status: 503, recovery_attempts: 1 });
		assert.deepEqual(error.failure.outcome, { state: "not_started", effects: "none" });
		return true;
	});
	assert.equal(fixture.count("tools/call"), 1);
	assert.equal((await fixture.client.callTool("later", {}, signal())).isError, false);
	assert.equal(fixture.effects(), 1);
});

for (const status of [401, 403, 408, 429, 500, 502, 503]) {
	test(`HTTP ${status} does not replay a tool invocation`, async (t) => {
		const fixture = httpFixture((request) => request.method === "tools/call" ? new Response("private error body", { status }) : undefined);
		t.after(() => fixture.client.close());
		await assert.rejects(fixture.client.callTool("change", {}, signal()), (error: unknown) => {
			assert.ok(error instanceof McpRequestError);
			assert.equal(error.failure.details.http_status, status);
			assert.equal(error.failure.details.recovery_attempts, undefined);
			assert.equal(JSON.stringify(error).includes("private"), false);
			return true;
		});
		assert.equal(fixture.count("initialize"), 1);
		assert.equal(fixture.count("tools/call"), 1);
	});
}

test("404 without a session and 404 during initialization do not trigger recovery", async (t) => {
	for (const method of ["initialize", "tools/call"]) {
		const fixture = httpFixture((request) => request.method === method ? expired() : undefined, { issueSession: false });
		t.after(() => fixture.client.close());
		await assert.rejects(fixture.client.callTool("change", {}, signal()), (error: unknown) => {
			assert.ok(error instanceof McpRequestError);
			assert.equal(error.failure.details.http_status, 404);
			assert.equal(error.failure.details.transport_code, undefined);
			return true;
		});
		assert.equal(fixture.count("initialize"), 1);
	}
});

test("ordinary connection failures and JSON-RPC errors retain evidence without replay", async (t) => {
	for (const kind of ["network", "rpc"] as const) {
		const fixture = httpFixture((request) => {
			if (request.method !== "tools/call") return;
			if (kind === "network") throw new TypeError("fetch failed at https://private/path", { cause: Object.assign(new Error("secret"), { code: "ECONNRESET" }) });
			return jsonResponse({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "secret invalid arguments", data: { authorization: "private" } } });
		});
		t.after(() => fixture.client.close());
		await assert.rejects(fixture.client.callTool("change", {}, signal()), (error: unknown) => {
			assert.ok(error instanceof McpRequestError);
			assert.equal(kind === "rpc" ? error.failure.details.rpc_code : error.failure.details.transport_code, kind === "rpc" ? -32602 : "ECONNRESET");
			assert.equal(error.failure.outcome.state, kind === "rpc" ? "not_started" : "unknown");
			assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /secret|private/u);
			return true;
		});
		assert.equal(fixture.count("initialize"), 1);
		assert.equal(fixture.count("tools/call"), 1);
	}
});

test("SDK timeouts do not replay a request with an unknown outcome", { timeout: 2_000 }, async (t) => {
	const finish = deferred<void>();
	const fixture = httpFixture(async (request) => {
		if (request.method === "notifications/cancelled") finish.resolve();
		if (request.method === "tools/call") await finish.promise;
		return undefined;
	}, { timeoutMs: 30 });
	t.after(() => fixture.client.close());
	await assert.rejects(fixture.client.callTool("change", {}, signal()), (error: unknown) => {
		assert.ok(error instanceof McpRequestError);
		assert.equal(error.failure.category, "timeout");
		assert.equal(error.failure.details.rpc_code, -32001);
		assert.equal(error.failure.details.timeout_ms, 30);
		assert.deepEqual(error.failure.outcome, { state: "unknown", effects: "possible" });
		return true;
	});
	assert.equal(fixture.count("tools/call"), 1);
});

interface Request {
	readonly method: string;
	readonly id?: number;
	readonly session?: string;
	readonly params?: { readonly name?: string };
}

function httpFixture(
	onRequest: (request: Request, signal: AbortSignal) => Response | undefined | Promise<Response | undefined>,
	options: { readonly issueSession?: boolean; readonly timeoutMs?: number } = {},
): { readonly client: McpClient; readonly requests: Request[]; readonly count: (method: string) => number; readonly effects: () => number } {
	const requests: Request[] = [];
	let sessions = 0;
	let effects = 0;
	const config: McpServerConfig = { id: "remote", transport: "streamable_http", url: "https://mcp.invalid/private-path-credential",
		args: [], env: {}, headers: { Authorization: "Bearer fixture-secret" }, enabled: true, supportsParallelToolCalls: false, timeoutMs: options.timeoutMs ?? 1_000 };
	const client = new McpClient({ config, fetch: async (_input, init) => {
		const activeSignal = init?.signal ?? signal();
		activeSignal.throwIfAborted();
		const payload = init?.method === "POST" ? JSON.parse(String(init.body)) as Request : { method: init?.method ?? "GET" };
		const request = { ...payload, session: new Headers(init?.headers).get("mcp-session-id") ?? undefined };
		requests.push(request);
		const intercepted = await onRequest(request, activeSignal);
		activeSignal.throwIfAborted();
		if (intercepted) return intercepted;
		if (request.method === "GET") return new Response(null, { status: 405 });
		if (request.method === "initialize") {
			sessions += 1;
			return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26",
				capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } } },
				options.issueSession === false ? {} : { "mcp-session-id": `session-${sessions}` });
		}
		if (request.id === undefined) return new Response(null, { status: 202 });
		if (request.method === "tools/call") effects += 1;
		const result = request.method === "tools/list" ? { tools: [] }
			: request.method === "resources/list" ? { resources: [] } : { content: [{ type: "text", text: "done" }] };
		return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
	} });
	return { client, requests, count: (method) => requests.filter((request) => request.method === method).length, effects: () => effects };
}

function jsonResponse(value: unknown, headers: Readonly<Record<string, string>> = {}): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
}

function expired(): Response { return new Response("private expired-session body", { status: 404 }); }
function signal(): AbortSignal { return new AbortController().signal; }
function deferred<Value>(): ReturnType<typeof Promise.withResolvers<Value>> { return Promise.withResolvers<Value>(); }
function untilAborted(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

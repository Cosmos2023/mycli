import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loginMcpOAuth } from "../../src/mcp/oauth-login.ts";
import { McpOAuthStore } from "../../src/mcp/oauth-store.ts";
import { authenticatedMcpFetch } from "../../src/mcp/oauth-fetch.ts";
import { diagnosticMcpFetch, policyMcpFetch } from "../../src/mcp/http-fetch.ts";
import { parseMcpServerConfig } from "../../src/mcp/config.ts";
import { createMcpToolRegistration, discoverConfiguredMcpServers, IntegrationToolApprovalStore,
	McpManagementService, PluginPackageManager, PluginRuntime, type McpServerConfig } from "../../src/index.ts";

test("plugin MCP login and logout share runtime identity across immutable package updates", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t);
	const signal = new AbortController().signal;
	const workspaceRoot = join(f.homeDir, "workspace");
	const source = join(f.homeDir, "bundle");
	await mkdir(workspaceRoot);
	await mkdir(join(source, ".codex-plugin"), { recursive: true });
	const manifest = (version: string): string => JSON.stringify({ name: "docs", version,
		mcpServers: { mcpServers: { search: { type: "http", url: f.config.url, headers: f.config.headers, oauth: { clientId: "fixture-client" } } } },
		hooks: { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "must-not-execute" }] }] } },
	});
	await writeFile(join(source, ".codex-plugin/plugin.json"), manifest("1.0.0"));
	const options = { homeDir: f.homeDir, workspaceRoot, env: {} };
	const packages = new PluginPackageManager(options);
	assert.equal((await packages.execute({ action: "add", source }, signal)).ok, true);
	t.mock.method(PluginRuntime, "load", () => assert.fail("authentication must not start plugin code or hooks"));
	const service = new McpManagementService({ ...options,
		createClient: () => assert.fail("authentication must not start unrelated MCP clients"),
		oauthFetch: () => policyMcpFetch(undefined), onAuthorization: async (value) => {
			const url = new URL(value);
			f.authorization(url);
			const callback = new URL(url.searchParams.get("redirect_uri")!);
			callback.searchParams.set("state", url.searchParams.get("state")!);
			callback.searchParams.set("code", "fixture-code");
			assert.equal((await fetch(callback)).status, 200);
		},
	});
	const login = await service.login("docs/search", signal);
	assert.equal(login.ok, true, JSON.stringify(login));
	assert.match(login.message, /docs\/search/u);
	const original = (await discoverConfiguredMcpServers(options)).get("docs/search")!;
	assert.equal((await new McpOAuthStore(f.homeDir, original).load())?.tokens.access_token, "token-1");
	const registration = (config: McpServerConfig) => createMcpToolRegistration({ callTool: async () => ({ content: [], isError: false }) }, {
		serverId: config.id, name: "read", description: "Read docs", inputSchema: { type: "object" }, supportsParallelToolCalls: true,
	}, config);
	const before = registration(original);
	const grants = new IntegrationToolApprovalStore(f.homeDir);
	await grants.allow(before.approvalScope!);
	assert.equal(before.originMetadata.plugin, "docs");
	assert.equal(before.originMetadata.plugin_server, "search");

	await writeFile(join(source, ".codex-plugin/plugin.json"), manifest("2.0.0"));
	assert.equal((await packages.execute({ action: "update", pluginId: "docs" }, signal)).ok, true);
	const updated = (await discoverConfiguredMcpServers(options)).get("docs/search")!;
	assert.equal(updated.id, original.id);
	assert.notEqual(updated.cwd, original.cwd);
	assert.equal((await new McpOAuthStore(f.homeDir, updated).load())?.tokens.access_token, "token-1");
	assert.notEqual(registration(updated).approvalScope?.fingerprint, before.approvalScope?.fingerprint);
	assert.equal((await grants.load()).some((grant) => grant.fingerprint === registration(updated).approvalScope?.fingerprint), false);
	for (const changed of [
		{ ...updated, plugin: { ...updated.plugin!, id: "other" } },
		{ ...updated, plugin: { ...updated.plugin!, source: "repo" as const } },
		{ ...updated, url: `${updated.url}/other` },
		{ ...updated, oauth: { clientId: "another-client" } },
	]) assert.equal(await new McpOAuthStore(f.homeDir, changed).load(), undefined);
	assert.equal((await service.revoke("docs/search")).ok, true);
	assert.deepEqual(await grants.load(), []);
	assert.equal((await service.logout(updated.id, signal)).ok, true);
	assert.equal(await new McpOAuthStore(f.homeDir, original).load(), undefined);
	assert.equal(f.counters.exchange, 1);
	assert.equal(f.counters.leakedHeaders, 0);
	assert.doesNotMatch(JSON.stringify(login), /token-1|fixture-secret/u);
	await packages.execute({ action: "disable", pluginId: "docs" }, signal);
	assert.equal((await service.login("docs/search", signal)).ok, false);
	assert.equal(f.counters.exchange, 1);
});

test("MCP OAuth validates state/PKCE, stores private credentials, and serializes rotated refresh tokens", { timeout: 10_000 }, async (t) => {
	const f = await fixture(t);
	const signal = new AbortController().signal;
	await loginMcpOAuth({ ...f, signal, fetch: policyMcpFetch(undefined), onAuthorization: async (value) => {
		const url = new URL(value);
		f.authorization(url);
		const callback = new URL(url.searchParams.get("redirect_uri")!);
		assert.equal(await new Promise<number | undefined>((resolve, reject) => {
			const request = httpRequest(callback, { path: "http://[invalid/" }, (response) => {
				response.resume();
				resolve(response.statusCode);
			});
			request.on("error", reject);
			request.end();
		}), 400);
		callback.searchParams.set("state", "0".repeat(64));
		callback.searchParams.set("code", "fixture-code");
		assert.equal((await fetch(callback)).status, 400);
		callback.searchParams.set("state", "中".repeat(64));
		assert.equal((await fetch(callback)).status, 400);
		callback.searchParams.set("state", url.searchParams.get("state")!);
		assert.equal((await fetch(callback)).status, 200);
	} });
	const store = new McpOAuthStore(f.homeDir, f.config);
	const first = await store.load();
	assert.equal(first?.tokens.access_token, "token-1");
	assert.equal(first?.client.client_id, "fixture-client");
	assert.equal(f.counters.exchange, 1);
	assert.equal(f.counters.leakedHeaders, 0);
	const directory = join(f.homeDir, ".mycli", "mcp-auth");
	const files = await readdir(directory);
	assert.equal(files.length, 1);
	if (process.platform !== "win32") assert.equal((await stat(join(directory, files[0]!))).mode & 0o777, 0o600);
	assert.equal(await new McpOAuthStore(f.homeDir, { ...f.config, url: `${f.config.url}/other` }).load(), undefined);
	assert.equal(await new McpOAuthStore(f.homeDir, { ...f.config, source: "plugin" }).load(), undefined);
	await store.update(async (current) => ({ ...current!, expiresAt: 0 }), signal);
	const request = authenticatedMcpFetch({ config: f.config, homeDir: f.homeDir,
		request: diagnosticMcpFetch(policyMcpFetch(undefined)), authFetch: policyMcpFetch(undefined) });
	await Promise.all(Array.from({ length: 4 }, async () => {
		const response = await request(f.config.url!, { method: "POST", body: "effect", signal });
		assert.equal(response.status, 200);
		await response.body?.cancel();
	}));
	assert.equal(f.counters.refresh, 1);
	assert.equal(f.counters.effects, 4);
	assert.equal((await store.load())?.tokens.refresh_token, "refresh-2");
	// A real 401 retries only after a serialized refresh; confirmed effects remain once per call.
	f.rejectCurrentToken();
	await request(f.config.url!, { method: "POST", body: "effect", signal });
	assert.equal(f.counters.refresh, 2);
	assert.equal(f.counters.effects, 5);
	await store.update(async () => undefined, signal);
	await assert.rejects(request(f.config.url!, { method: "POST", body: "effect", signal }));
	assert.equal(f.counters.effects, 5);
	assert.equal(await store.load(), undefined);
});

test("cancelled OAuth login closes its callback and does not overwrite a previous login", { timeout: 5_000 }, async (t) => {
	const f = await fixture(t);
	const store = new McpOAuthStore(f.homeDir, f.config);
	await store.update(async () => ({ version: 1, redirectUri: "http://127.0.0.1:1234/callback",
		client: { client_id: "old" }, tokens: { access_token: "old", token_type: "Bearer" } }), new AbortController().signal);
	const controller = new AbortController();
	let callback = "";
	await assert.rejects(loginMcpOAuth({ ...f, signal: controller.signal, fetch: policyMcpFetch(undefined), onAuthorization: (value) => {
		callback = new URL(value).searchParams.get("redirect_uri")!;
		controller.abort();
	} }));
	await assert.rejects(fetch(callback));
	assert.equal((await store.load())?.tokens.access_token, "old");
	assert.equal(f.counters.exchange, 0);
});

test("OAuth honors managed network policy and never follows credential-bearing redirects", async (t) => {
	const f = await fixture(t);
	for (const policy of [{ network: "disabled" as const }, { network: "enabled" as const, networkDomains: ["example.org"] }]) {
		await assert.rejects(loginMcpOAuth({ ...f, signal: new AbortController().signal,
			fetch: policyMcpFetch(policy), onAuthorization: () => assert.fail("must not open an authorization URL") }));
	}
	assert.equal(f.counters.exchange, 0);
	assert.equal(await new McpOAuthStore(f.homeDir, f.config).load(), undefined);
	let fetches = 0;
	await assert.rejects(loginMcpOAuth({ ...f, signal: new AbortController().signal,
		fetch: policyMcpFetch(undefined, async () => { fetches += 1; return new Response(null, { status: 302, headers: { location: "https://example.org/redirect" } }); }),
		onAuthorization: () => assert.fail("redirect must not be opened") }));
	assert.equal(fetches, 1);
});

test("cancellation while binding the callback cannot leave login waiting", { timeout: 1000 }, async (t) => {
	const f = await fixture(t);
	const controller = new AbortController();
	const login = loginMcpOAuth({ ...f, signal: controller.signal, fetch: policyMcpFetch(undefined), onAuthorization: () => assert.fail() });
	queueMicrotask(() => controller.abort());
	await assert.rejects(login);
});

async function fixture(t: TestContext) {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-mcp-oauth-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));
	const counters = { exchange: 0, refresh: 0, effects: 0, leakedHeaders: 0 };
	let base = "";
	let challenge = "";
	let redirectUri = "";
	let tokenGeneration = 0;
	let rejected = false;
	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url!, base);
			const json = (body: unknown): void => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
			if (url.pathname !== "/mcp" && req.headers["x-private"]) counters.leakedHeaders += 1;
			if (url.pathname === "/meta" || url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
				json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read"] });
			} else if (url.pathname === "/.well-known/oauth-authorization-server") {
				json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
					response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] });
			} else if (url.pathname === "/register") {
				const body = JSON.parse(await bodyText(req)) as object;
				res.statusCode = 201;
				json({ ...body, client_id: "fixture-client" });
			} else if (url.pathname === "/token") {
				const form = new URLSearchParams(await bodyText(req));
				assert.equal(form.get("client_id"), "fixture-client");
				if (form.get("grant_type") === "authorization_code") {
					assert.equal(form.get("code"), "fixture-code");
					assert.equal(form.get("redirect_uri"), redirectUri);
					assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), challenge);
					counters.exchange += 1;
				} else {
					assert.equal(form.get("grant_type"), "refresh_token");
					assert.equal(form.get("refresh_token"), `refresh-${tokenGeneration}`);
					counters.refresh += 1;
				}
				rejected = false; tokenGeneration += 1;
				json({ access_token: `token-${tokenGeneration}`, token_type: "Bearer", refresh_token: `refresh-${tokenGeneration}`, expires_in: 3600 });
			} else if (url.pathname === "/mcp") {
				if (req.method === "GET" || rejected || req.headers.authorization !== `Bearer token-${tokenGeneration}`) {
					res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/meta"` }).end();
				} else { counters.effects += 1; json({ ok: true }); }
			} else res.writeHead(404).end();
		} catch { res.writeHead(500).end(); }
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	base = `http://127.0.0.1:${address.port}`;
	const config = parseMcpServerConfig("fixture", { url: `${base}/mcp`, headers: { "x-private": "fixture-secret" } }, {});
	return { config, homeDir, counters, authorization: (url: URL): void => {
		challenge = url.searchParams.get("code_challenge")!;
		redirectUri = url.searchParams.get("redirect_uri")!;
		assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	}, rejectCurrentToken: (): void => { rejected = true; } };
}

async function bodyText(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
	return Buffer.concat(chunks).toString("utf8");
}

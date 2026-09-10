import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	McpCatalogCache,
	McpManager,
	type McpManagedClient,
	type McpServerConfig,
} from "../../src/index.ts";

test("resource listing queries clients after a cached startup and isolates failed servers", async (t) => {
	let lists = 0;
	const manager = new McpManager({
		configs: [config("alpha"), config("offline")],
		catalogCache: {
			load: async () => ["alpha", "offline"].map((serverId) => ({ serverId, tools: [], resourceCount: 1 })),
			save: async () => undefined,
		},
		createClient: (server) => ({ ...client(server.id, []), listResources: async () => {
			lists += 1;
			if (server.id === "offline") throw new Error("private offline detail");
			return [{ serverId: server.id, uri: "data:///readme", name: "readme", description: "" }];
		} }),
	});
	t.after(() => manager.close());
	assert.deepEqual((await manager.discover(new AbortController().signal)).resources, []);
	assert.equal(lists, 0);
	const listing = await manager.listResources(new AbortController().signal);
	assert.equal(listing.resources[0]?.uri, "data:///readme");
	assert.equal(listing.failures[0]?.server, "offline");
	assert.equal(JSON.stringify(listing).includes("private"), false);
	await assert.rejects(manager.listResources(new AbortController().signal, "missing"), /unknown_mcp_server/u);
});

test("template discovery aggregates pages, isolates failures, and stops after close", async (t) => {
	const seen: (string | undefined)[] = [];
	const manager = new McpManager({ configs: [config("alpha"), config("offline")], createClient: (server) => ({
		...client(server.id, []), listResourceTemplates: async (_signal, cursor) => {
			if (server.id === "offline") throw new Error("private failure");
			seen.push(cursor);
			return { resourceTemplates: [{ serverId: server.id, uriTemplate: `data:///${cursor ?? "first"}/{id}`, name: "item", description: "" }],
				...(cursor === undefined ? { nextCursor: "second" } : {}) };
		},
	}) });
	t.after(() => manager.close());
	const signal = new AbortController().signal;
	const all = await manager.listResourceTemplates(signal);
	assert.equal(all.resourceTemplates.length, 2);
	assert.equal(all.failures[0]?.server, "offline");
	assert.equal(JSON.stringify(all).includes("private"), false);
	assert.deepEqual(seen, [undefined, "second"]);
	const single = await manager.listResourceTemplates(signal, "alpha");
	assert.equal(single.resourceTemplates.length, 1);
	assert.equal(single.nextCursor, "second");
	await manager.close();
	await assert.rejects(manager.listResourceTemplates(signal), /mcp_manager_closed/u);
});

test("closing MCP resources aborts active reads and rejects further work", async () => {
	const started = deferred<void>();
	const manager = new McpManager({ configs: [config("alpha")], createClient: () => ({
		...client("alpha", []), readResource: async (_uri, signal) => {
			started.resolve();
			await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
			return [];
		},
	}) });
	const read = manager.readResource("alpha", "data:///wait", new AbortController().signal);
	const rejected = assert.rejects(read, { name: "AbortError" });
	await started.promise;
	await manager.close();
	await rejected;
	await assert.rejects(manager.listResources(new AbortController().signal), /mcp_manager_closed/u);
});

test("closing MCP during template pagination aborts the current page and starts no later page", async () => {
	const started = deferred<void>();
	let pages = 0;
	const manager = new McpManager({ configs: [config("alpha")], createClient: () => ({
		...client("alpha", []), listResourceTemplates: async (signal) => {
			pages += 1;
			started.resolve();
			await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
			return { resourceTemplates: [], nextCursor: "later" };
		},
	}) });
	const rejected = assert.rejects(manager.listResourceTemplates(new AbortController().signal), { name: "AbortError" });
	await started.promise;
	await manager.close();
	await rejected;
	assert.equal(pages, 1);
});

test("resource cancellation during discovery completes cleanup without waiting on itself", { timeout: 2_000 }, async () => {
	const started = deferred<void>();
	const controller = new AbortController();
	const manager = new McpManager({ configs: [config("alpha")], createClient: () => ({
		...client("alpha", []), listTools: async (signal) => {
			started.resolve();
			await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
			return [];
		},
	}) });
	const rejected = assert.rejects(manager.listResources(controller.signal), { name: "AbortError" });
	await started.promise;
	controller.abort();
	await rejected;
	await manager.close();
});

test("discovers enabled MCP servers lazily, isolates failures, and closes clients once", async () => {
	const created: string[] = [];
	const closed: string[] = [];
	const clients = new Map<string, McpManagedClient>([
		["alpha", client("alpha", closed)],
		["broken", client("broken", closed, new Error("transport failed Bearer private-server-output"))],
	]);
	const manager = new McpManager({
		configs: [config("disabled", false), config("broken"), config("alpha")],
		createClient: (server) => {
			created.push(server.id);
			return clients.get(server.id)!;
		},
	});
	const signal = new AbortController().signal;

	const first = await manager.discover(signal);
	const second = await manager.discover(signal);

	assert.equal(first, second);
	assert.deepEqual(created, ["alpha", "broken"]);
	assert.deepEqual(first.registrations.map((item) => item.id), ["mcp:alpha:read_file"]);
	assert.deepEqual(first.resources.map((item) => item.serverId), ["alpha"]);
	assert.deepEqual(first.servers.map((item) => [item.serverId, item.status]), [
		["alpha", "ok"],
		["broken", "failed"],
		["disabled", "disabled"],
	]);
	assert.equal(first.servers[0]?.toolCount, 1);
	assert.equal(first.servers[1]?.failureCategory, "transport_error");
	assert.equal(JSON.stringify(first).includes("private-server-output"), false);
	assert.deepEqual(closed, ["broken"]);

	await Promise.all([manager.close(), manager.close()]);
	assert.deepEqual(closed, ["broken", "alpha"]);
});

test("discovers servers and each server catalog concurrently while preserving stable order", async () => {
	const started: string[] = [];
	const release = deferred<void>();
	const allStarted = deferred<void>();
	const manager = new McpManager({
		configs: [config("beta"), config("alpha")],
		createClient: (server) => ({
			...client(server.id, []),
			listTools: async () => {
				started.push(`${server.id}:tools`);
				if (started.length === 4) allStarted.resolve();
				await release.promise;
				return [{
					serverId: server.id,
					name: "read_file",
					description: "Read a file",
					inputSchema: { type: "object", properties: {} },
					supportsParallelToolCalls: false,
				}];
			},
			listResources: async () => {
				started.push(`${server.id}:resources`);
				if (started.length === 4) allStarted.resolve();
				await release.promise;
				return [{
					serverId: server.id,
					uri: `file:///${server.id}.txt`,
					name: server.id,
					description: "",
				}];
			},
		}),
	});

	const discovery = manager.discover(new AbortController().signal);
	await allStarted.promise;
	assert.deepEqual(new Set(started), new Set([
		"alpha:tools",
		"alpha:resources",
		"beta:tools",
		"beta:resources",
	]));
	release.resolve();
	const result = await discovery;

	assert.deepEqual(result.servers.map((server) => server.serverId), ["alpha", "beta"]);
	assert.deepEqual(result.registrations.map((registration) => registration.id), [
		"mcp:alpha:read_file",
		"mcp:beta:read_file",
	]);
	assert.deepEqual(result.resources.map((resource) => resource.serverId), ["alpha", "beta"]);
	await manager.close();
});

test("reuses a private MCP catalog without reconnecting and invalidates config changes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-cache-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cache = new McpCatalogCache({ directory: root });
	const server = {
		...config("alpha"),
		url: "https://private.example/mcp",
		transport: "streamable_http" as const,
		headers: { Authorization: "Bearer private-cache-token" },
	};
	let discoveryCalls = 0;
	const first = new McpManager({
		configs: [server],
		catalogCache: cache,
		createClient: () => ({
			...client("alpha", []),
			listTools: async () => {
				discoveryCalls += 1;
				return client("alpha", []).listTools(new AbortController().signal);
			},
			listResources: async () => {
				discoveryCalls += 1;
				return client("alpha", []).listResources(new AbortController().signal);
			},
		}),
	});
	await first.discover(new AbortController().signal);
	await first.close();
	assert.equal(discoveryCalls, 2);

	let cachedDiscoveryCalls = 0;
	const second = new McpManager({
		configs: [server],
		catalogCache: cache,
		createClient: () => ({
			...client("alpha", []),
			listTools: async () => { cachedDiscoveryCalls += 1; return []; },
			listResources: async () => { cachedDiscoveryCalls += 1; return []; },
		}),
	});
	const cached = await second.discover(new AbortController().signal);
	assert.equal(cachedDiscoveryCalls, 0);
	assert.equal(cached.registrations.length, 1);
	assert.equal(cached.resources.length, 0);
	assert.equal(cached.servers[0]?.resourceCount, 1);
	await second.close();

	const cachePath = join(root, "mcp-catalog-v2.json");
	const raw = await readFile(cachePath, "utf8");
	assert.equal(raw.includes("private.example"), false);
	assert.equal(raw.includes("private-cache-token"), false);
	assert.equal(raw.includes("file:///alpha.txt"), false);
	if (process.platform !== "win32") {
		assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
	}

	let changedDiscoveryCalls = 0;
	const changed = new McpManager({
		configs: [{ ...server, timeoutMs: server.timeoutMs + 1 }],
		catalogCache: cache,
		createClient: () => ({
			...client("alpha", []),
			listTools: async () => {
				changedDiscoveryCalls += 1;
				return client("alpha", []).listTools(new AbortController().signal);
			},
			listResources: async () => {
				changedDiscoveryCalls += 1;
				return client("alpha", []).listResources(new AbortController().signal);
			},
		}),
	});
	await changed.discover(new AbortController().signal);
	assert.equal(changedDiscoveryCalls, 2);
	await changed.close();
});

test("ignores expired and malformed MCP catalogs", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-stale-cache-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let now = 1_000;
	const cache = new McpCatalogCache({ directory: root, ttlMs: 10, clock: () => now });
	const server = config("alpha");
	await cache.save([server], [{
		serverId: "alpha",
		tools: [],
		resourceCount: 0,
	}]);
	assert.notEqual(await cache.load([server]), undefined);
	const shorterTtl = new McpCatalogCache({ directory: root, ttlMs: 5, clock: () => now });
	assert.equal(await shorterTtl.load([server]), undefined);
	now = 1_011;
	assert.equal(await cache.load([server]), undefined);

	await writeFile(join(root, "mcp-catalog-v2.json"), "{broken", { mode: 0o600 });
	assert.equal(await cache.load([server]), undefined);
});

test("loads a cached catalog immediately and refreshes it through live discovery", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-refresh-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cache = new McpCatalogCache({ directory: root });
	const server = config("alpha");
	await cache.save([server], [{
		serverId: "alpha",
		tools: [{
			serverId: "alpha",
			name: "cached_tool",
			description: "Cached tool",
			inputSchema: { type: "object", properties: {} },
			supportsParallelToolCalls: false,
		}],
		resourceCount: 1,
	}]);
	let liveCalls = 0;
	const manager = new McpManager({
		configs: [server],
		catalogCache: cache,
		createClient: () => ({
			...client("alpha", []),
			listTools: async () => {
				liveCalls += 1;
				return [{
					serverId: "alpha",
					name: "live_tool",
					description: "Live tool",
					inputSchema: { type: "object", properties: {} },
					supportsParallelToolCalls: true,
				}];
			},
			listResources: async () => { liveCalls += 1; return []; },
		}),
	});
	const signal = new AbortController().signal;
	const cached = await manager.loadCached(signal);
	assert.deepEqual(cached?.registrations.map((item) => item.definition.name), ["mcp_alpha_cached_tool"]);
	assert.equal(liveCalls, 0);
	const refreshed = await manager.refresh(signal);
	assert.deepEqual(refreshed.registrations.map((item) => item.definition.name), ["mcp_alpha_live_tool"]);
	assert.equal(liveCalls, 2);
	assert.equal(await manager.discover(signal), refreshed);
	assert.equal(liveCalls, 2);
	await manager.close();
});

test("close waits for an in-flight catalog save before returning", async () => {
	const saveStarted = deferred<void>();
	const releaseSave = deferred<void>();
	let saveCompleted = false;
	const manager = new McpManager({
		configs: [],
		catalogCache: {
			load: async () => undefined,
			save: async () => {
				saveStarted.resolve();
				await releaseSave.promise;
				saveCompleted = true;
			},
		},
		createClient: () => client("unused", []),
	});
	const refresh = manager.refresh(new AbortController().signal);
	await saveStarted.promise;
	let closeSettled = false;
	const closing = manager.close().then(() => { closeSettled = true; });
	await new Promise<void>((resolve) => { setImmediate(resolve); });

	assert.equal(closeSettled, false);
	assert.equal(saveCompleted, false);
	releaseSave.resolve();
	await Promise.all([refresh, closing]);
	assert.equal(saveCompleted, true);
});

function deferred<Value>(): {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value | PromiseLike<Value>) => void;
} {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	const promise = new Promise<Value>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
}

function client(id: string, closed: string[], failure?: Error): McpManagedClient {
	return {
		listTools: async () => {
			if (failure) throw failure;
			return [{
				serverId: id,
				name: "read_file",
				description: "Read a file",
				inputSchema: { type: "object", properties: {} },
				supportsParallelToolCalls: false,
			}];
		},
		callTool: async () => ({ content: [], isError: false }),
		listResources: async () => [{
			serverId: id,
			uri: `file:///${id}.txt`,
			name: id,
			description: "",
		}],
		readResource: async (uri) => [{ serverId: id, uri, text: id }],
		close: async () => { closed.push(id); },
	};
}

function config(id: string, enabled = true): McpServerConfig {
	return {
		id,
		transport: "stdio",
		command: process.execPath,
		args: [],
		env: {},
		headers: {},
		enabled,
		supportsParallelToolCalls: false,
		timeoutMs: 1_000,
	};
}

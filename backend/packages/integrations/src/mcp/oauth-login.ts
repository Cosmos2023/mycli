import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { auth, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpOAuthProvider, boundedOAuthFetch, type McpOAuthFetch } from "./oauth-provider.ts";
import { McpOAuthError, McpOAuthStore } from "./oauth-store.ts";
import type { McpServerConfig } from "./types.ts";

export async function loginMcpOAuth(options: {
	readonly config: McpServerConfig;
	readonly homeDir: string;
	readonly signal: AbortSignal;
	readonly fetch: McpOAuthFetch;
	readonly onAuthorization: (url: string) => void | Promise<void>;
}): Promise<void> {
	const { config } = options;
	if (config.transport !== "streamable_http" || !config.url || new Headers(config.headers).has("authorization")) {
		throw new McpOAuthError("mcp_oauth_unsupported");
	}
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]);
	signal.throwIfAborted();
	const state = randomBytes(32).toString("hex");
	const callback = await oauthCallback(state, config.oauth?.callbackPort ?? 0, signal);
	try {
		const fetch = boundedOAuthFetch(options.fetch, signal);
		const provider = new McpOAuthProvider({ config, redirectUri: callback.url, state,
			onAuthorization: async (url) => {
				if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
					|| url.username || url.password || url.toString().length > 16_384) throw new McpOAuthError("mcp_oauth_failed");
				signal.throwIfAborted();
				await options.onAuthorization(url.toString());
			} });
		const challenge = await fetch(config.url, { method: "GET", headers: { ...config.headers } });
		const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(challenge);
		await challenge.body?.cancel();
		const authOptions = { serverUrl: config.url, fetchFn: fetch, resourceMetadataUrl,
			scope: config.oauth?.scopes?.join(" ") || scope };
		if (await auth(provider, authOptions) === "REDIRECT") {
			await auth(provider, { ...authOptions, authorizationCode: await callback.code });
		}
		signal.throwIfAborted();
		await new McpOAuthStore(options.homeDir, config).update(async () => provider.record(), signal);
	} catch (error) {
		if (options.signal.aborted) throw error;
		throw new McpOAuthError("mcp_oauth_failed");
	} finally { await callback.close(); }
}

async function oauthCallback(state: string, port: number, signal: AbortSignal): Promise<{
	readonly url: string; readonly code: Promise<string>; close(): Promise<void>;
}> {
	const result = Promise.withResolvers<string>();
	void result.promise.catch(() => undefined);
	let settled = false;
	let expectedHost = "";
	const server = createServer((request, response) => {
		response.setHeader("Content-Type", "text/plain; charset=utf-8");
		response.setHeader("Cache-Control", "no-store");
		let url: URL;
		try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
		catch {
			response.writeHead(400).end("Invalid authorization callback.");
			return;
		}
		const provided = url.searchParams.get("state") ?? "";
		if (settled || signal.aborted || request.method !== "GET" || request.headers.host !== expectedHost
			|| url.pathname !== "/callback" || !/^[a-f0-9]{64}$/u.test(provided) || url.searchParams.getAll("state").length !== 1
			|| !timingSafeEqual(Buffer.from(provided), Buffer.from(state))) {
			response.writeHead(400).end("Invalid authorization callback.");
			return;
		}
		const code = url.searchParams.get("code");
		if (url.searchParams.has("error")) {
			settled = true;
			result.reject(new McpOAuthError("mcp_oauth_failed"));
			response.end("Authorization declined. Return to mycli.");
		} else if (!code || code.length > 8_192 || url.searchParams.getAll("code").length !== 1) {
			response.writeHead(400).end("Invalid authorization code.");
		} else {
			settled = true;
			result.resolve(code);
			response.end("Authorization received. Return to mycli to check the result.");
		}
	});
	server.requestTimeout = 5_000;
	server.headersTimeout = 5_000;
	const abort = (): void => { result.reject(signal.reason); server.closeAllConnections(); server.close(); };
	signal.addEventListener("abort", abort, { once: true });
	try {
		await new Promise<void>((resolve, reject) => {
			const cleanup = (): void => { server.off("error", failed); signal.removeEventListener("abort", aborted); };
			const failed = (error: unknown): void => { cleanup(); reject(error); };
			const aborted = (): void => failed(signal.reason);
			if (signal.aborted) { aborted(); return; }
			signal.addEventListener("abort", aborted, { once: true });
			server.once("error", failed);
			server.listen({ host: "127.0.0.1", port, signal }, () => { cleanup(); resolve(); });
		});
		signal.throwIfAborted();
		const address = server.address();
		if (!address || typeof address === "string") throw new McpOAuthError("mcp_oauth_failed");
		expectedHost = `127.0.0.1:${address.port}`;
		return { url: `http://${expectedHost}/callback`, code: result.promise,
			close: async () => {
				signal.removeEventListener("abort", abort);
				result.reject(new McpOAuthError("mcp_oauth_failed"));
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			} };
	} catch (error) {
		signal.removeEventListener("abort", abort);
		server.close();
		throw error;
	}
}

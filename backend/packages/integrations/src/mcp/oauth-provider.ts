import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { McpOAuthError, McpOAuthStore, type McpOAuthRecord } from "./oauth-store.ts";
import type { McpServerConfig } from "./types.ts";

export type McpOAuthFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** PKCE/state live only for one explicit login. Refresh never redirects or registers a client. */
export class McpOAuthProvider implements OAuthClientProvider {
	#client?: OAuthClientInformationMixed;
	#tokens?: OAuthTokens;
	#verifier?: string;
	#record?: McpOAuthRecord;
	constructor(readonly options: {
		readonly redirectUri: string;
		readonly config: McpServerConfig;
		readonly existing?: McpOAuthRecord;
		readonly state?: string;
		readonly onAuthorization?: (url: URL) => void | Promise<void>;
	}) {
		this.#client = options.existing?.client ?? (options.config.oauth?.clientId ? { client_id: options.config.oauth.clientId } : undefined);
		this.#tokens = options.existing?.tokens;
		this.#record = options.existing;
	}
	get redirectUrl(): string { return this.options.redirectUri; }
	get clientMetadata(): OAuthClientMetadata {
		return { client_name: "mycli", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"], token_endpoint_auth_method: "none",
			...(this.options.config.oauth?.scopes?.length ? { scope: this.options.config.oauth.scopes.join(" ") } : {}) };
	}
	state(): string { return this.options.state ?? ""; }
	clientInformation(): OAuthClientInformationMixed | undefined { return this.#client; }
	saveClientInformation(client: OAuthClientInformationMixed): void {
		if (!this.options.onAuthorization) throw new McpOAuthError("mcp_oauth_required");
		this.#client = client;
	}
	tokens(): OAuthTokens | undefined { return this.#tokens; }
	saveTokens(tokens: OAuthTokens): void {
		if (!this.#client) throw new McpOAuthError("mcp_oauth_failed");
		this.#tokens = { ...tokens, ...(tokens.refresh_token ? {} : this.#tokens?.refresh_token ? { refresh_token: this.#tokens.refresh_token } : {}) };
		this.#record = { version: 1, redirectUri: this.redirectUrl, client: this.#client, tokens: this.#tokens,
			...(tokens.expires_in === undefined ? {} : { expiresAt: Date.now() + tokens.expires_in * 1_000 }) };
	}
	async redirectToAuthorization(url: URL): Promise<void> {
		if (!this.options.onAuthorization) throw new McpOAuthError("mcp_oauth_required");
		await this.options.onAuthorization(url);
	}
	saveCodeVerifier(verifier: string): void { this.#verifier = verifier; }
	codeVerifier(): string {
		if (!this.#verifier) throw new McpOAuthError("mcp_oauth_failed");
		return this.#verifier;
	}
	record(): McpOAuthRecord {
		if (!this.#record) throw new McpOAuthError("mcp_oauth_failed");
		return this.#record;
	}
}

/** A private-file lock serializes refresh and logout, including across CLI processes. */
export async function mcpOAuthToken(options: {
	readonly homeDir: string; readonly config: McpServerConfig; readonly fetch: McpOAuthFetch;
	readonly signal: AbortSignal; readonly rejectedToken?: string;
}): Promise<string | undefined> {
	const store = new McpOAuthStore(options.homeDir, options.config);
	const current = await store.load();
	if (!current) return undefined;
	const needsRefresh = (record: McpOAuthRecord): boolean => options.rejectedToken === undefined
		? record.expiresAt !== undefined && record.expiresAt <= Date.now() + 30_000
		: record.tokens.access_token === options.rejectedToken;
	if (!needsRefresh(current)) return current.tokens.access_token;
	try {
		const updated = await store.update(async (record) => {
			if (!record || !needsRefresh(record)) return record;
			if (!record.tokens.refresh_token) throw new McpOAuthError("mcp_oauth_required");
			const provider = new McpOAuthProvider({ config: options.config, redirectUri: record.redirectUri, existing: record });
			await auth(provider, { serverUrl: options.config.url!, fetchFn: boundedOAuthFetch(options.fetch, options.signal) });
			return provider.record();
		}, options.signal);
		return updated?.tokens.access_token;
	} catch (error) {
		if (options.signal.aborted) throw error;
		if (error instanceof McpOAuthError && error.code === "mcp_oauth_store_failed") throw error;
		throw new McpOAuthError("mcp_oauth_required");
	}
}

export function boundedOAuthFetch(fetch: McpOAuthFetch, signal: AbortSignal): McpOAuthFetch {
	return async (input, init) => {
		const url = new URL(input);
		if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
			|| url.username || url.password) throw new McpOAuthError("mcp_oauth_failed");
		const active = AbortSignal.any([signal, AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : [])]);
		const response = await fetch(input, { ...init, signal: active });
		if (!response.body) return response;
		let bytes = 0;
		const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller): void {
				bytes += chunk.byteLength;
				if (bytes > 131_072) throw new McpOAuthError("mcp_oauth_failed");
				controller.enqueue(chunk);
			},
		}));
		return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
	};
}

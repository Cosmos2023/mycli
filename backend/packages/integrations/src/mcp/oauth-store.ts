import { open } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateFileUpdate } from "@mycli/config";
import { modelInputSha256 } from "@mycli/core";
import { OAuthClientInformationSchema, OAuthTokensSchema,
	type OAuthClientInformationMixed, type OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServerConfig } from "./types.ts";

const MAX_BYTES = 65_536;

export class McpOAuthError extends Error {
	constructor(readonly code: "mcp_oauth_required" | "mcp_oauth_failed" | "mcp_oauth_store_failed" | "mcp_oauth_unsupported") {
		super(code);
	}
}

export interface McpOAuthRecord {
	readonly version: 1;
	readonly redirectUri: string;
	readonly client: OAuthClientInformationMixed;
	readonly tokens: OAuthTokens;
	readonly expiresAt?: number;
}

/** Credentials are isolated by server, source, endpoint, explicit headers and OAuth settings. */
export class McpOAuthStore {
	readonly #directory: string;
	readonly #fileName: string;
	constructor(homeDir: string, config: McpServerConfig) {
		this.#directory = join(homeDir, ".mycli", "mcp-auth");
		this.#fileName = `${modelInputSha256({ id: config.id, source: config.source, transport: config.transport,
			url: config.url, headers: config.headers, oauth: config.oauth })}.json`;
	}

	async load(): Promise<McpOAuthRecord | undefined> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(join(this.#directory, this.#fileName), "r");
			const info = await handle.stat();
			if (!info.isFile() || info.size > MAX_BYTES) throw new McpOAuthError("mcp_oauth_store_failed");
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			let size = 0;
			while (size < buffer.length) {
				const read = await handle.read(buffer, size, buffer.length - size, size);
				if (!read.bytesRead) break;
				size += read.bytesRead;
			}
			if (size > MAX_BYTES) throw new McpOAuthError("mcp_oauth_store_failed");
			return parseRecord(buffer.subarray(0, size).toString("utf8"));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw new McpOAuthError("mcp_oauth_store_failed");
		} finally { await handle?.close().catch(() => undefined); }
	}

	async update(
		edit: (current: McpOAuthRecord | undefined) => Promise<McpOAuthRecord | undefined>,
		signal: AbortSignal,
	): Promise<McpOAuthRecord | undefined> {
		let result: McpOAuthRecord | undefined;
		try { await atomicPrivateFileUpdate({ directory: this.#directory, fileName: this.#fileName,
			maxCurrentBytes: MAX_BYTES, lockTimeoutMs: 60_000, signal,
			buildContent: async (current) => {
				result = await edit(parseRecord(current));
				if (!result) return null;
				const content = JSON.stringify(result);
				if (Buffer.byteLength(content) > MAX_BYTES) throw new McpOAuthError("mcp_oauth_store_failed");
				parseRecord(content);
				return content;
			} });
		} catch (error) {
			if (signal.aborted || error instanceof McpOAuthError) throw error;
			throw new McpOAuthError("mcp_oauth_store_failed");
		}
		return result;
	}
}

function parseRecord(content: string | undefined): McpOAuthRecord | undefined {
	if (content === undefined) return undefined;
	try {
		const value = JSON.parse(content) as McpOAuthRecord;
		if (value.version !== 1 || typeof value.redirectUri !== "string"
			|| value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt < 0)) throw new Error();
		const redirect = new URL(value.redirectUri);
		if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || redirect.pathname !== "/callback") throw new Error();
		const client = OAuthClientInformationSchema.parse(value.client);
		const tokens = OAuthTokensSchema.parse(value.tokens);
		if (!tokens.access_token || tokens.token_type.toLowerCase() !== "bearer") throw new Error();
		return { version: 1, redirectUri: value.redirectUri, client, tokens,
			...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }) };
	} catch { throw new McpOAuthError("mcp_oauth_store_failed"); }
}

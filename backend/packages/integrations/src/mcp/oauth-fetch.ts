import { McpHttpError } from "./diagnostics.ts";
import { mcpOAuthToken, type McpOAuthFetch } from "./oauth-provider.ts";
import type { McpServerConfig } from "./types.ts";

/** Retry only an explicit authentication rejection, never an uncertain tool outcome. */
export function authenticatedMcpFetch(options: {
	readonly config: McpServerConfig;
	readonly homeDir: string;
	readonly request: McpOAuthFetch;
	readonly authFetch: McpOAuthFetch;
}): McpOAuthFetch {
	return async (input, init) => {
		const signal = init?.signal ?? new AbortController().signal;
		const authOptions = { homeDir: options.homeDir, config: options.config, fetch: options.authFetch, signal };
		const token = await mcpOAuthToken(authOptions);
		const send = (accessToken: string | undefined): Promise<Response> => {
			const headers = new Headers(init?.headers);
			if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
			return options.request(input, { ...init, headers, signal });
		};
		try { return await send(token); }
		catch (error) {
			if (!(error instanceof McpHttpError) || error.status !== 401 || error.sessionExpired || !token) throw error;
			const refreshed = await mcpOAuthToken({ ...authOptions, rejectedToken: token });
			if (!refreshed) throw error;
			return send(refreshed);
		}
	};
}

import { McpHttpError } from "./diagnostics.ts";

type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function diagnosticMcpFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
	return async (input, init) => {
		const response = await fetch(input, init);
		if (init?.method === "POST" && !response.ok) {
			const sessionExpired = response.status === 404 && Boolean(new Headers(init.headers).get("mcp-session-id"));
			// Discard upstream bodies, which can contain endpoint credentials or private data.
			await response.body?.cancel().catch(() => undefined);
			throw new McpHttpError(response.status, sessionExpired);
		}
		return response;
	};
}

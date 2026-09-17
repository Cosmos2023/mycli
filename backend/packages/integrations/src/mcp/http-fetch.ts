import { McpHttpError } from "./diagnostics.ts";
import { networkDomainAllowed, type ExecutionPolicy } from "@mycli/tools";

type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const MAX_ERROR_BODY_BYTES = 8_192;
const ERROR_BODY_TIMEOUT_MS = 1_000;

export function policyMcpFetch(policy: Pick<ExecutionPolicy, "network" | "networkDomains"> | undefined, fetch: McpFetch = globalThis.fetch): McpFetch {
	return async (input, init) => {
		const url = new URL(input);
		if (policy?.network === "disabled" || policy?.networkDomains !== undefined
			&& !networkDomainAllowed(url.hostname, policy.networkDomains)) throw new Error("network_access_denied");
		// Do not forward credentials, session IDs, or tool arguments to redirect destinations.
		const response = await fetch(input, { ...init, redirect: "manual" });
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error("mcp_http_redirect_denied");
		}
		return response;
	};
}

export function diagnosticMcpFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
	return async (input, init) => {
		const response = await fetch(input, init);
		if (init?.method === "POST" && !response.ok) {
			const hasSession = Boolean(new Headers(init.headers).get("mcp-session-id"));
			const sessionExpired = hasSession && (response.status === 404
				|| (response.status === 401 && await hasSessionExpiredCode(response, init.signal)));
			// Discard upstream bodies, which can contain endpoint credentials or private data.
			await response.body?.cancel().catch(() => undefined);
			throw new McpHttpError(response.status, sessionExpired);
		}
		return response;
	};
}

async function hasSessionExpiredCode(response: Response, signal?: AbortSignal | null): Promise<boolean> {
	// ModelScope uses HTTP 401 with this exact machine code for an expired MCP session.
	// Ordinary authentication errors and human-readable messages are not replay evidence.
	if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")
		|| !response.body || Number(response.headers.get("content-length")) > MAX_ERROR_BODY_BYTES) return false;
	const reader = response.body.getReader();
	const deadline = AbortSignal.any([AbortSignal.timeout(ERROR_BODY_TIMEOUT_MS), ...(signal ? [signal] : [])]);
	const cancel = (): void => { void reader.cancel().catch(() => undefined); };
	deadline.addEventListener("abort", cancel, { once: true });
	try {
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (!deadline.aborted) {
			const { done, value } = await reader.read();
			if (deadline.aborted) return false;
			if (done) {
				const payload: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
				return typeof payload === "object" && payload !== null && !Array.isArray(payload)
					&& "Code" in payload && payload.Code === "SessionExpired";
			}
			size += value.byteLength;
			if (size > MAX_ERROR_BODY_BYTES) return false;
			chunks.push(value);
		}
		return false;
	} catch {
		return false;
	} finally {
		deadline.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

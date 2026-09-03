export interface ProviderAttemptEvidence {
	response?: {
		readonly status: number;
		readonly headers: Readonly<Record<string, string>>;
	};
	transportError?: unknown;
}

const SAFE_RESPONSE_HEADERS = Object.freeze([
	"retry-after",
	"retry-after-ms",
	"request-id",
	"x-oai-request-id",
	"x-request-id",
]);

export function instrumentedFetch(
	evidence: ProviderAttemptEvidence,
	baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
	return async (input, init) => {
		try {
			const response = await baseFetch(input, init);
			recordProviderResponse(evidence, response.status, response.headers);
			return response;
		} catch (error) {
			evidence.transportError = error;
			throw error;
		}
	};
}

export function recordProviderResponse(
	evidence: ProviderAttemptEvidence,
	status: number,
	headers: Headers | Readonly<Record<string, string>>,
): void {
	const safeHeaders: Record<string, string> = {};
	for (const name of SAFE_RESPONSE_HEADERS) {
		const value = headers instanceof Headers
			? headers.get(name)
			: Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
		if (typeof value === "string" && value) safeHeaders[name] = value.slice(0, 256);
	}
	evidence.response = Object.freeze({
		status,
		headers: Object.freeze(safeHeaders),
	});
}

import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { networkDomainAllowed } from "../policy/execution-policy.ts";
import { normalizePublicUrl } from "./public-target.ts";

const HOP_HEADERS = new Set([
	"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
	"proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

export class NetworkProxyError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
		this.name = "NetworkProxyError";
	}
}

export function proxyRequestTarget(
	request: IncomingMessage,
	domains: readonly string[],
	tunnel: boolean,
): URL {
	const raw = request.url ?? "";
	if (!raw || raw.length > 4_096 || /[\s\\#]/u.test(raw)) throw invalidRequest();
	if (request.headers.upgrade !== undefined || request.headers.expect !== undefined) {
		throw invalidRequest();
	}
	if (tunnel && (!raw.endsWith(":443") || /[/?@]/u.test(raw))) throw invalidRequest();
	const url = normalizePublicUrl(tunnel ? `https://${raw}` : raw);
	if (url.protocol !== (tunnel ? "https:" : "http:") || url.port) {
		throw new NetworkProxyError(403, "Only HTTP port 80 and CONNECT port 443 are supported.");
	}
	const hostHeaders = request.rawHeaders.filter((_, index) => (
		index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === "host"
	));
	if (hostHeaders.length !== 1 || typeof request.headers.host !== "string") throw invalidRequest();
	let host: URL;
	try {
		host = new URL(`${url.protocol}//${request.headers.host}`);
	} catch {
		throw invalidRequest();
	}
	if (host.host !== url.host || host.username || host.password
		|| host.pathname !== "/" || host.search || host.hash) throw invalidRequest();
	if (!networkDomainAllowed(url.hostname, domains)) {
		throw new NetworkProxyError(403, "The target domain is not allowed by the execution policy.");
	}
	return url;
}

export function proxyHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
	const excluded = new Set(HOP_HEADERS);
	for (const token of (headers.connection ?? "").split(",")) excluded.add(token.trim().toLowerCase());
	return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}

function invalidRequest(): NetworkProxyError {
	return new NetworkProxyError(400, "Invalid proxy request.");
}

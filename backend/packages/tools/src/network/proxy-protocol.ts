import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import type { NetworkAccessDetails } from "@mycli/contracts";
import { normalizePublicUrl } from "./public-target.ts";

const HOP_HEADERS = new Set([
	"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
	"proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

export class NetworkProxyError extends Error {
	constructor(readonly status: number, message: string, readonly reason: NetworkAccessDetails["reason"] = status >= 500 ? "connection_failed" : "invalid_request") {
		super(message);
		this.name = "NetworkProxyError";
	}
}

export function proxyRequestTarget(
	request: IncomingMessage,
	tunnel: boolean,
	origin?: URL,
): URL {
	const raw = request.url ?? "";
	if (!raw || raw.length > 4_096 || /[\s\\#]/u.test(raw)) throw invalidRequest();
	if (request.headers.upgrade !== undefined || request.headers.expect !== undefined) {
		throw invalidRequest();
	}
	if (tunnel && (!raw.endsWith(":443") || /[/?@]/u.test(raw))) throw invalidRequest();
	if (origin && (!raw.startsWith("/") || raw.startsWith("//"))) throw invalidRequest();
	const url = normalizePublicUrl(origin ? new URL(raw, origin).href : tunnel ? `https://${raw}` : raw);
	if (url.protocol !== (tunnel || origin ? "https:" : "http:") || url.port) {
		throw new NetworkProxyError(403, "Only HTTP port 80 and CONNECT port 443 are supported.", "port_denied");
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
	if (origin && url.origin !== origin.origin) throw invalidRequest();
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

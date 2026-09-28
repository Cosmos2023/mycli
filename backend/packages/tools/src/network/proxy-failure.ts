import * as http from "node:http";
import type { Duplex } from "node:stream";
import { NetworkProxyError } from "./proxy-protocol.ts";
import { PublicTargetError } from "./public-target.ts";

export function proxyFailure(error: unknown): NetworkProxyError {
	if (error instanceof NetworkProxyError) return error;
	if (error instanceof PublicTargetError) return new NetworkProxyError(error.kind === "dns_failed" ? 502 : 403, "The proxy target is unavailable or not public.",
		error.kind === "dns_failed" ? "dns_failed" : error.kind === "unsafe_address" ? "private_address" : "invalid_request");
	return new NetworkProxyError(502, "Network proxy request failed.", "connection_failed");
}

export function failProxyResponse(response: http.ServerResponse, error: unknown): void {
	if (response.destroyed) return;
	if (response.headersSent) { response.destroy(); return; }
	const rejected = proxyFailure(error);
	response.writeHead(rejected.status, { connection: "close", "content-type": "text/plain" });
	response.end(`${rejected.message}\n`);
}

export function failProxySocket(socket: Duplex, error: unknown): void {
	if (socket.destroyed || socket.writableEnded) return;
	const rejected = proxyFailure(error), body = `${rejected.message}\n`;
	socket.end(`HTTP/1.1 ${rejected.status} ${http.STATUS_CODES[rejected.status]}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

import * as http from "node:http";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { normalizeNetworkDomains } from "../policy/execution-policy.ts";
import { proxyHeaders, proxyRequestTarget, NetworkProxyError } from "./proxy-protocol.ts";
import { resolvePublicTarget, PublicTargetError, type PublicTargetLookup } from "./public-target.ts";

const MAX_CONNECTIONS = 64;
const IDLE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

export interface NetworkProxyTarget {
	readonly address: string;
	readonly family: number;
	readonly port: 80 | 443;
}

export interface NetworkProxyOptions {
	readonly domains: readonly string[];
	readonly lookup?: PublicTargetLookup;
	readonly connect?: (target: NetworkProxyTarget) => Socket;
}

export interface NetworkProxyLease {
	readonly port: number;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	close(): Promise<void>;
}

export async function startNetworkProxy(options: NetworkProxyOptions): Promise<NetworkProxyLease> {
	const proxy = new NetworkProxy(options);
	return proxy.listen();
}

class NetworkProxy {
	readonly #domains: readonly string[];
	readonly #lookup: PublicTargetLookup | undefined;
	readonly #connect: (target: NetworkProxyTarget) => Socket;
	readonly #server: http.Server;
	readonly #sockets = new Set<Duplex>();
	readonly #shutdown = new AbortController();
	#closePromise?: Promise<void>;
	#activeRequests = 0;

	constructor(options: NetworkProxyOptions) {
		this.#domains = normalizeNetworkDomains(options.domains);
		this.#lookup = options.lookup;
		this.#connect = options.connect ?? ((target) => createConnection({
			host: target.address,
			port: target.port,
			family: target.family,
		}));
		this.#server = http.createServer({
			maxHeaderSize: 16_384,
			headersTimeout: 10_000,
			requestTimeout: IDLE_TIMEOUT_MS,
			keepAliveTimeout: 1_000,
		}, (request, response) => {
			void this.#forward(request, response).catch((error: unknown) => failResponse(response, error));
		});
		this.#server.maxConnections = MAX_CONNECTIONS;
		this.#server.maxRequestsPerSocket = 32;
		this.#server.on("connection", (socket) => this.#track(socket));
		this.#server.on("connect", (request, socket, head) => {
			void this.#tunnel(request, socket, head).catch((error: unknown) => failSocket(socket, error));
		});
		this.#server.on("upgrade", (_request, socket) => failSocket(socket, new NetworkProxyError(400, "Upgrades are not supported.")));
		this.#server.on("clientError", (_error, socket) => failSocket(socket, new NetworkProxyError(400, "Invalid proxy request.")));
		this.#server.on("checkContinue", (_request, response) => failResponse(response, new NetworkProxyError(417, "Expect is not supported.")));
		this.#server.on("checkExpectation", (_request, response) => failResponse(response, new NetworkProxyError(417, "Expect is not supported.")));
	}

	async listen(): Promise<NetworkProxyLease> {
		await new Promise<void>((resolve, reject) => {
			this.#server.once("error", reject);
			this.#server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
				this.#server.removeListener("error", reject);
				resolve();
			});
		});
		this.#server.on("error", () => { void this.close(); });
		const address = this.#server.address();
		if (!address || typeof address === "string") {
			await this.close();
			throw new Error("Network proxy could not bind a loopback port.");
		}
		const url = `http://127.0.0.1:${address.port}`;
		return Object.freeze({
			port: address.port,
			env: Object.freeze({
				HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url,
				http_proxy: url, https_proxy: url, all_proxy: url,
				NO_PROXY: "", no_proxy: "",
			}),
			close: () => this.close(),
		});
	}

	close(): Promise<void> {
		this.#closePromise ??= new Promise<void>((resolve) => {
			this.#shutdown.abort();
			this.#server.close(() => resolve());
			for (const socket of this.#sockets) socket.destroy();
		});
		return this.#closePromise;
	}

	#track(socket: Socket): void {
		this.#sockets.add(socket);
		socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
		socket.on("error", () => socket.destroy());
		socket.once("close", () => this.#sockets.delete(socket));
		if (this.#shutdown.signal.aborted) socket.destroy();
	}

	async #target(request: http.IncomingMessage, socket: Duplex, tunnel: boolean): Promise<{ url: URL; target: NetworkProxyTarget }> {
		if (this.#activeRequests >= MAX_CONNECTIONS) {
			throw new NetworkProxyError(503, "Network proxy capacity exceeded.");
		}
		this.#activeRequests += 1;
		const disconnected = new AbortController();
		const onClose = (): void => disconnected.abort();
		socket.once("close", onClose);
		if (socket.destroyed) disconnected.abort();
		const signal = AbortSignal.any([
			this.#shutdown.signal, disconnected.signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS),
		]);
		try {
			signal.throwIfAborted();
			const url = proxyRequestTarget(request, this.#domains, tunnel);
			const address = await resolvePublicTarget(url, this.#lookup, signal);
			signal.throwIfAborted();
			return { url, target: Object.freeze({ ...address, port: tunnel ? 443 : 80 }) };
		} finally {
			socket.removeListener("close", onClose);
			this.#activeRequests -= 1;
		}
	}

	#dial(target: NetworkProxyTarget): Socket {
		this.#shutdown.signal.throwIfAborted();
		const socket = this.#connect(target);
		this.#track(socket);
		const timer = setTimeout(() => socket.destroy(), CONNECT_TIMEOUT_MS);
		timer.unref();
		socket.once("connect", () => clearTimeout(timer));
		socket.once("close", () => clearTimeout(timer));
		return socket;
	}

	async #forward(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		const { url, target } = await this.#target(request, request.socket, false);
		if (response.destroyed || request.socket.destroyed) return;
		const upstream = http.request({
			hostname: target.address,
			port: target.port,
			method: request.method,
			path: `${url.pathname}${url.search}`,
			headers: { ...proxyHeaders(request.headers), host: url.host, connection: "close" },
			createConnection: () => this.#dial(target),
			maxHeaderSize: 16_384,
		}, (remote) => {
			response.writeHead(remote.statusCode ?? 502, { ...proxyHeaders(remote.headers), connection: "close" });
			remote.on("error", () => response.destroy());
			remote.pipe(response);
		});
		response.once("close", () => upstream.destroy());
		request.once("error", () => upstream.destroy());
		upstream.once("error", () => failResponse(response, new NetworkProxyError(502, "Upstream connection failed.")));
		upstream.once("upgrade", (_remote, socket) => {
			socket.destroy();
			failResponse(response, new NetworkProxyError(502, "Upstream upgrades are not supported."));
		});
		request.pipe(upstream);
	}

	async #tunnel(request: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
		const { target } = await this.#target(request, client, true);
		if (client.destroyed) return;
		const upstream = this.#dial(target);
		client.once("close", () => upstream.destroy());
		let connected = false;
		upstream.once("error", () => {
			if (connected) client.destroy();
			else failSocket(client, new NetworkProxyError(502, "Upstream connection failed."));
		});
		upstream.once("close", () => client.destroy());
		upstream.once("connect", () => {
			if (client.destroyed || this.#shutdown.signal.aborted) { upstream.destroy(); return; }
			connected = true;
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstream.write(head);
			client.pipe(upstream);
			upstream.pipe(client);
		});
	}
}

function failure(error: unknown): NetworkProxyError {
	if (error instanceof NetworkProxyError) return error;
	if (error instanceof PublicTargetError) {
		return new NetworkProxyError(error.kind === "dns_failed" ? 502 : 403, "The proxy target is unavailable or not public.");
	}
	return new NetworkProxyError(502, "Network proxy request failed.");
}

function failResponse(response: http.ServerResponse, error: unknown): void {
	if (response.destroyed) return;
	if (response.headersSent) { response.destroy(); return; }
	const rejected = failure(error);
	response.writeHead(rejected.status, { connection: "close", "content-type": "text/plain" });
	response.end(`${rejected.message}\n`);
}

function failSocket(socket: Duplex, error: unknown): void {
	if (socket.destroyed || socket.writableEnded) return;
	const rejected = failure(error);
	const body = `${rejected.message}\n`;
	socket.end(`HTTP/1.1 ${rejected.status} ${http.STATUS_CODES[rejected.status]}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

import * as http from "node:http";
import { once } from "node:events";
import { createServer, isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect, TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import { freezeNetworkProxyPolicy, type NetworkProxyPolicy } from "@mycli/core";
import { normalizeNetworkDomains, networkDomainAllowed } from "../policy/execution-policy.ts";
import { proxyHeaders, proxyRequestTarget, NetworkProxyError } from "./proxy-protocol.ts";
import { normalizePublicUrl, resolvePublicTarget } from "./public-target.ts";
import { connectProxyTarget, upstreamProxyFromEnvironment, type NetworkProxyTarget, type UpstreamProxy } from "./proxy-transport.ts";
import { readSocksTarget, socksReply } from "./proxy-socks.ts";
import { failProxyResponse, failProxySocket, proxyFailure } from "./proxy-failure.ts";
import type { ProxyCertificates } from "./proxy-certificates.ts";
import type { NetworkProxyOptions, NetworkProxyLease } from "./network-proxy.ts";
import { ProxyRequestSetup } from "./proxy-approval.ts";

const MAX_CONNECTIONS = 64;
const IDLE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

export class ManagedNetworkProxy {
	readonly #domains: readonly string[];
	readonly #policy: NetworkProxyPolicy;
	readonly #options: NetworkProxyOptions;
	readonly #httpUpstream: UpstreamProxy | undefined;
	readonly #httpsUpstream: UpstreamProxy | undefined;
	readonly #server = createServer((socket) => this.#accept(socket));
	readonly #http = this.#httpServer(false);
	readonly #innerHttp = this.#httpServer(true);
	readonly #origins = new WeakMap<Socket, URL>();
	readonly #transports = new WeakMap<Socket, Socket>();
	readonly #headerDeadlines = new WeakMap<Socket, () => void>();
	readonly #sockets = new Set<Duplex>();
	readonly #pending = new Set<Promise<void>>();
	readonly #shutdown = new AbortController();
	#certificates?: ProxyCertificates;
	#closePromise?: Promise<void>;
	#activeRequests = 0;

	constructor(options: NetworkProxyOptions) {
		this.#domains = normalizeNetworkDomains(options.domains);
		this.#policy = options.policy ? freezeNetworkProxyPolicy(options.policy)
			: Object.freeze({ mode: "full", enableSocks5: false, allowUpstreamProxy: false });
		this.#options = Object.freeze({ ...options });
		const env = this.#policy.allowUpstreamProxy ? options.sourceEnv ?? process.env : {};
		this.#httpUpstream = upstreamProxyFromEnvironment(env, false);
		this.#httpsUpstream = upstreamProxyFromEnvironment(env, true);
		this.#server.maxConnections = MAX_CONNECTIONS;
	}

	#httpServer(inner: boolean): http.Server {
		const server = http.createServer({ maxHeaderSize: 16_384, headersTimeout: CONNECT_TIMEOUT_MS,
			requestTimeout: IDLE_TIMEOUT_MS, keepAliveTimeout: 1000 }, (request, response) => {
			this.#headersReceived(request.socket);
			this.#run(this.#forward(request, response, inner), (error) => failProxyResponse(response, error));
		});
		server.maxRequestsPerSocket = 32;
		server.on("connect", (request, client, head) => {
			this.#headersReceived(request.socket);
			if (inner) { failProxySocket(client, new NetworkProxyError(403, "Nested tunnels are not allowed.")); return; }
			this.#run(this.#tunnel(request, client as Socket, head), (error) => failProxySocket(client, error));
		});
		server.on("upgrade", (_request, client) => failProxySocket(client, new NetworkProxyError(400, "Upgrades are not supported.")));
		server.on("clientError", (_error, client) => failProxySocket(client, new NetworkProxyError(400, "Invalid proxy request.")));
		server.on("checkContinue", (_request, response) => failProxyResponse(response, new NetworkProxyError(417, "Expect is not supported.")));
		server.on("checkExpectation", (_request, response) => failProxyResponse(response, new NetworkProxyError(417, "Expect is not supported.")));
		return server;
	}

	async listen(): Promise<NetworkProxyLease> {
		if (this.#policy.mode === "limited") {
			const { createProxyCertificates } = await import("./proxy-certificates.ts");
			this.#certificates = await createProxyCertificates();
		}
		await new Promise<void>((resolve, reject) => {
			this.#server.once("error", reject);
			this.#server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
				this.#server.removeListener("error", reject); resolve();
			});
		});
		this.#server.on("error", () => { void this.close(); });
		const address = this.#server.address();
		if (!address || typeof address === "string") throw new Error("Network proxy could not bind a loopback port.");
		const url = `http://127.0.0.1:${address.port}`;
		const socksUrl = this.#policy.enableSocks5 ? `socks5h://127.0.0.1:${address.port}` : url;
		const bundle = this.#certificates?.bundlePath;
		return Object.freeze({ port: address.port, policy: this.#policy,
			...(bundle ? { readableRoots: Object.freeze([bundle]) } : {}),
			env: Object.freeze({ HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: socksUrl,
				http_proxy: url, https_proxy: url, all_proxy: socksUrl, WS_PROXY: url, WSS_PROXY: url,
				ws_proxy: url, wss_proxy: url, NO_PROXY: "", no_proxy: "",
				...(bundle ? { NODE_EXTRA_CA_CERTS: bundle, SSL_CERT_FILE: bundle, REQUESTS_CA_BUNDLE: bundle,
					CURL_CA_BUNDLE: bundle, GIT_SSL_CAINFO: bundle } : {}) }),
			close: () => this.close() });
	}

	close(): Promise<void> {
		return this.#closePromise ??= (async () => {
			this.#shutdown.abort();
			const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
			for (const socket of this.#sockets) socket.destroy();
			await closed;
			await Promise.allSettled(this.#pending);
			this.#http.close(); this.#innerHttp.close();
			await this.#certificates?.close();
		})();
	}

	#run(work: Promise<void>, reject: (error: unknown) => void): void {
		const pending = work.catch(reject).finally(() => this.#pending.delete(pending));
		this.#pending.add(pending);
	}

	#track(socket: Socket): void {
		this.#sockets.add(socket);
		socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
		socket.on("error", () => socket.destroy());
		socket.once("close", () => this.#sockets.delete(socket));
		if (this.#shutdown.signal.aborted || this.#sockets.size > MAX_CONNECTIONS) socket.destroy();
	}

	#accept(socket: Socket): void {
		this.#track(socket);
		// HTTP parsers receive injected sockets and never listen themselves, so Node's
		// listening-triggered header/request deadline checker does not run here.
		this.#headerDeadlines.set(socket, socketDeadline(socket, CONNECT_TIMEOUT_MS));
		socket.once("data", (chunk: Buffer) => {
			socket.pause(); socket.unshift(chunk);
			if (chunk[0] === 5) {
				if (!this.#policy.enableSocks5) { socket.end(Buffer.from([5, 255])); return; }
				this.#run(this.#socks(socket), (error) => {
					if (!socket.destroyed && !socket.writableEnded) socket.end(socksReply(proxyFailure(error).status === 403 ? 2 : 1));
				});
			} else { this.#http.emit("connection", socket); socket.resume(); }
		});
	}

	#headersReceived(socket: Socket): void {
		this.#headerDeadlines.get(socket)?.();
		this.#headerDeadlines.delete(socket);
	}

	async #setup(client: Socket, action: (setup: ProxyRequestSetup) => Promise<void>): Promise<void> {
		if (this.#activeRequests >= MAX_CONNECTIONS) throw new NetworkProxyError(503, "Network proxy capacity exceeded.", "capacity_exceeded");
		this.#activeRequests += 1;
		const setup = new ProxyRequestSetup(client, this.#shutdown.signal, this.#transports.get(client));
		try { setup.signal.throwIfAborted(); await action(setup); }
		catch (error) {
			try { this.#options.onBlocked?.(Object.freeze({ ...setup.details, reason: proxyFailure(error).reason })); }
			catch { /* Diagnostics cannot change network authorization. */ }
			throw error;
		} finally { this.#activeRequests -= 1; setup.close(); }
	}

	async #target(url: URL, setup: ProxyRequestSetup, port: number, authorize = true): Promise<NetworkProxyTarget> {
		const { signal } = setup;
		setup.details = { ...setup.details, host: url.hostname, port, protocol: port === 443 ? "https" : port === 80 ? "http" : "tcp" };
		if (!networkDomainAllowed(url.hostname, this.#domains)) throw new NetworkProxyError(403, "The target domain is not allowed by the execution policy.", "domain_denied");
		const address = await resolvePublicTarget(url, this.#options.lookup, signal);
		if (authorize && networkDomainAllowed(url.hostname, this.#policy.approvalDomains ?? [])) await setup.approve(this.#options);
		signal.throwIfAborted();
		return Object.freeze({ ...address, port });
	}

	#dial(target: NetworkProxyTarget, secure: boolean, signal: AbortSignal): Promise<Socket> {
		return connectProxyTarget({ target, upstream: secure ? this.#httpsUpstream : this.#httpUpstream, signal,
			connect: this.#options.connect, track: (socket) => this.#track(socket), upstreamCa: this.#options.upstreamCa });
	}

	async #forward(request: http.IncomingMessage, response: http.ServerResponse, inner: boolean): Promise<void> {
		await this.#setup(request.socket, async (setup) => {
			const { signal } = setup;
			const method = request.method ?? "";
			if (/^[A-Z]{1,24}$/u.test(method)) setup.details = { method };
			const origin = inner ? this.#origins.get(request.socket) : undefined;
			if (inner && !origin) throw new NetworkProxyError(400, "Missing tunnel destination.");
			const url = proxyRequestTarget(request, false, origin);
			setup.details = { ...setup.details, host: url.hostname, port: url.protocol === "https:" ? 443 : 80, protocol: url.protocol === "https:" ? "https" : "http" };
			if (this.#policy.mode === "limited" && !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "")) {
				throw new NetworkProxyError(403, "The HTTP method is not allowed in limited mode.", "method_denied");
			}
			const secure = url.protocol === "https:";
			const target = await this.#target(url, setup, secure ? 443 : 80);
			const clearBodyDeadline = socketDeadline(request.socket, IDLE_TIMEOUT_MS);
			request.once("end", clearBodyDeadline);
			response.once("close", clearBodyDeadline);
			let socket = await this.#dial(target, secure, signal);
			if (secure) {
				const hostname = url.hostname.replace(/^\[|\]$/gu, "");
				const tls = tlsConnect({ socket, rejectUnauthorized: true, ca: this.#options.originCa,
					...(isIP(hostname) ? {} : { servername: hostname }), ALPNProtocols: ["http/1.1"],
					checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate) });
				this.#track(tls);
				try { await once(tls, "secureConnect", { signal }); }
				catch { tls.destroy(); throw new NetworkProxyError(502, "Origin TLS verification failed."); }
				socket = tls;
			}
			if (response.destroyed || signal.aborted) { socket.destroy(); return; }
			const upstream = http.request({ hostname: target.address, port: target.port, method: request.method,
				path: `${url.pathname}${url.search}`, headers: { ...proxyHeaders(request.headers), host: url.host, connection: "close" },
				createConnection: () => socket, maxHeaderSize: 16_384 }, (remote) => {
				response.writeHead(remote.statusCode ?? 502, { ...proxyHeaders(remote.headers), connection: "close" });
				remote.on("error", () => response.destroy()); remote.pipe(response);
			});
			response.once("close", () => { upstream.destroy(); socket.destroy(); });
			request.once("error", () => upstream.destroy());
			upstream.once("error", () => failProxyResponse(response, new NetworkProxyError(502, "Upstream connection failed.")));
			upstream.once("upgrade", (_remote, upgraded) => { upgraded.destroy(); failProxyResponse(response, new NetworkProxyError(502, "Upstream upgrade is not supported.")); });
			request.pipe(upstream);
			socket.resume();
		});
	}

	async #tunnel(request: http.IncomingMessage, client: Socket, head: Buffer): Promise<void> {
		client.pause();
		await this.#setup(client, async (setup) => {
			const { signal } = setup;
			setup.details = { method: "CONNECT" };
			const url = proxyRequestTarget(request, true);
			const target = await this.#target(url, setup, 443, this.#policy.mode !== "limited");
			const acknowledge = (): void => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); };
			if (this.#policy.mode === "limited") await this.#intercept(client, head, url, signal, acknowledge);
			else this.#relay(client, await this.#dial(target, true, signal), head, acknowledge);
		});
	}

	async #socks(client: Socket): Promise<void> {
		await this.#setup(client, async (setup) => {
			const { signal } = setup;
			const request = await readSocksTarget(client, signal);
			this.#headersReceived(client);
			const host = isIP(request.hostname) === 6 ? `[${request.hostname}]` : request.hostname;
			const secure = request.port === 443;
			const url = normalizePublicUrl(`${secure ? "https" : "http"}://${host}:${request.port}/`);
			setup.details = { host: url.hostname, port: request.port, protocol: secure ? "https" : "tcp", method: "CONNECT" };
			if (this.#policy.mode === "limited" && !secure) throw new NetworkProxyError(403, "Limited SOCKS5 requires HTTPS on port 443.", "port_denied");
			const target = await this.#target(url, setup, request.port, this.#policy.mode !== "limited");
			const acknowledge = (): void => { client.write(socksReply(0)); };
			if (this.#policy.mode === "limited") await this.#intercept(client, request.head, url, signal, acknowledge);
			else this.#relay(client, await this.#dial(target, secure, signal), request.head, acknowledge);
		});
	}

	#relay(client: Socket, upstream: Socket, head: Buffer, acknowledge: () => void): void {
		if (client.destroyed || this.#shutdown.signal.aborted) { upstream.destroy(); return; }
		client.once("close", () => upstream.destroy()); upstream.once("close", () => client.destroy());
		acknowledge();
		if (head.length) upstream.write(head);
		client.pipe(upstream); upstream.pipe(client);
		client.resume(); upstream.resume();
	}

	async #intercept(client: Socket, head: Buffer, url: URL, signal: AbortSignal, acknowledge: () => void): Promise<void> {
		const hostname = url.hostname.replace(/^\[|\]$/gu, "");
		const context = await this.#certificates!.context(hostname);
		signal.throwIfAborted();
		acknowledge();
		if (head.length) client.unshift(head);
		const secure = new TLSSocket(client, { isServer: true, secureContext: context,
			ALPNProtocols: ["http/1.1"], SNICallback: (name, callback) => {
				if (name.toLowerCase() !== hostname.toLowerCase()) callback(new Error("TLS destination mismatch"));
				else callback(null, context);
			} });
		this.#track(secure);
		this.#origins.set(secure, url);
		this.#transports.set(secure, client);
		const timer = setTimeout(() => secure.destroy(), CONNECT_TIMEOUT_MS);
		timer.unref();
		secure.once("close", () => { clearTimeout(timer); client.destroy(); });
		secure.once("secure", () => {
			clearTimeout(timer);
			this.#headerDeadlines.set(secure, socketDeadline(secure, CONNECT_TIMEOUT_MS));
			this.#innerHttp.emit("connection", secure); secure.resume();
		});
		secure.resume();
	}
}

function socketDeadline(socket: Socket, milliseconds: number): () => void {
	const timer = setTimeout(() => socket.destroy(), milliseconds);
	timer.unref();
	const clear = (): void => { clearTimeout(timer); socket.removeListener("close", clear); };
	socket.once("close", clear);
	return clear;
}

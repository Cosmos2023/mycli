import { once } from "node:events";
import { createConnection, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import { NetworkProxyError } from "./proxy-protocol.ts";
import { ProxySocketReader } from "./proxy-socket.ts";

export interface NetworkProxyTarget {
	readonly address: string;
	readonly family: number;
	readonly port: number;
}

export interface UpstreamProxy {
	readonly hostname: string;
	readonly port: number;
	readonly tls: boolean;
	readonly authorization?: string;
}

export function upstreamProxyFromEnvironment(env: Readonly<NodeJS.ProcessEnv>, secure: boolean): UpstreamProxy | undefined {
	const raw = secure ? env.https_proxy ?? env.HTTPS_PROXY ?? env.all_proxy ?? env.ALL_PROXY ?? env.http_proxy ?? env.HTTP_PROXY
		: env.http_proxy ?? env.HTTP_PROXY ?? env.all_proxy ?? env.ALL_PROXY;
	if (!raw) return undefined;
	try {
		if (raw.length > 4096 || /[\r\n\0]/u.test(raw)) throw new Error();
		const url = new URL(raw);
		if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.pathname !== "/" || url.search || url.hash) throw new Error();
		if (url.port === "0") throw new Error();
		const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
		if (/[\r\n\0]/u.test(credentials)) throw new Error();
		return Object.freeze({ hostname: url.hostname.replace(/^\[|\]$/gu, ""), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
			tls: url.protocol === "https:", ...(url.username || url.password ? { authorization: `Basic ${Buffer.from(credentials).toString("base64")}` } : {}) });
	} catch { throw new NetworkProxyError(502, "Invalid upstream proxy configuration."); }
}

export async function connectProxyTarget(options: {
	readonly target: NetworkProxyTarget;
	readonly upstream?: UpstreamProxy;
	readonly signal: AbortSignal;
	readonly connect?: (target: NetworkProxyTarget) => Socket;
	readonly track: (socket: Socket) => void;
	readonly upstreamCa?: ConnectionOptions["ca"];
}): Promise<Socket> {
	const { target, upstream, signal } = options;
	signal.throwIfAborted();
	const socket = upstream
		? upstream.tls ? tlsConnect({ host: upstream.hostname, port: upstream.port, rejectUnauthorized: true,
			...(isIP(upstream.hostname) ? {} : { servername: upstream.hostname }), ca: options.upstreamCa })
			: createConnection({ host: upstream.hostname, port: upstream.port })
		: options.connect?.(target) ?? createConnection({ host: target.address, family: target.family, port: target.port });
	options.track(socket);
	const aborted = (): void => { socket.destroy(); };
	signal.addEventListener("abort", aborted, { once: true });
	try {
		await once(socket, upstream?.tls ? "secureConnect" : "connect", { signal });
		if (upstream) {
			const reader = new ProxySocketReader(socket, signal);
			try {
				const authority = `${target.family === 6 ? `[${target.address}]` : target.address}:${target.port}`;
				socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${upstream.authorization ? `Proxy-Authorization: ${upstream.authorization}\r\n` : ""}\r\n`);
				const headers = (await reader.headers()).toString("latin1");
				if (!/^HTTP\/1\.[01] 200(?: |\r\n)/u.test(headers)) throw new NetworkProxyError(502, "Upstream proxy refused the connection.");
				const head = reader.finish();
				if (head.length) socket.unshift(head);
			} finally { reader.finish(); }
		}
		signal.throwIfAborted();
		return socket;
	} catch {
		socket.destroy();
		throw new NetworkProxyError(502, "Proxy connection failed.");
	} finally { signal.removeEventListener("abort", aborted); }
}

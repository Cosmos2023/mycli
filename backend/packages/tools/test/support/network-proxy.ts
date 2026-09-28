import assert from "node:assert/strict";
import { once } from "node:events";
import * as http from "node:http";
import { createConnection, type Server, type Socket } from "node:net";
import type { TestContext } from "node:test";
import { startNetworkProxy, type NetworkProxyLease, type NetworkProxyOptions } from "../../src/network/network-proxy.ts";

export const PUBLIC_ADDRESS = "93.184.216.34";
export const FULL_PROXY = Object.freeze({ mode: "full" as const, enableSocks5: true, allowUpstreamProxy: false });
export const LIMITED_PROXY = Object.freeze({ ...FULL_PROXY, mode: "limited" as const });

export async function lease(t: TestContext, options: Partial<NetworkProxyOptions> = {}): Promise<NetworkProxyLease> {
	const proxy = await startNetworkProxy({ domains: ["api.example.com"], policy: FULL_PROXY,
		lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }], ...options });
	t.after(() => proxy.close());
	return proxy;
}

export async function listen(t: TestContext, server: Server): Promise<number> {
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
	server.listen(0);
	await once(server, "listening");
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return address.port;
}

export async function client(t: TestContext, proxy: NetworkProxyLease): Promise<Socket> {
	const socket = createConnection({ host: "127.0.0.1", port: proxy.port });
	socket.on("error", () => undefined);
	t.after(() => socket.destroy());
	await once(socket, "connect");
	return socket;
}

export function readUntil(socket: Socket, length: (bytes: Buffer) => number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let data: Buffer = Buffer.alloc(0);
		const cleanup = (): void => {
			clearTimeout(timer); socket.pause();
			socket.removeListener("data", onData); socket.removeListener("error", onError); socket.removeListener("end", onEnd);
		};
		const onError = (error: Error): void => { cleanup(); reject(error); };
		const onEnd = (): void => onError(new Error("Unexpected end of proxy response"));
		const onData = (chunk: Buffer): void => {
			data = Buffer.concat([data, chunk]);
			const size = length(data);
			if (size <= 0 || data.length < size) return;
			cleanup();
			if (data.length > size) socket.unshift(data.subarray(size));
			resolve(data.subarray(0, size));
		};
		const timer = setTimeout(() => onError(new Error("Proxy response timed out")), 5000);
		socket.on("data", onData); socket.once("error", onError); socket.once("end", onEnd); socket.resume();
	});
}

export function socksDomain(hostname: string, port = 443, command = 1): Buffer {
	const bytes = Buffer.from(hostname);
	const ending = Buffer.alloc(2); ending.writeUInt16BE(port);
	return Buffer.concat([Buffer.from([5, command, 0, 3, bytes.length]), bytes, ending]);
}

export async function connectTunnel(socket: Socket): Promise<void> {
	socket.write("CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n");
	const response = await readUntil(socket, (bytes) => bytes.indexOf("\r\n\r\n") < 0 ? 0 : bytes.indexOf("\r\n\r\n") + 4);
	assert.match(response.toString(), /^HTTP\/1.1 200/u);
}

export async function request(proxy: NetworkProxyLease, method = "GET", socket?: Socket, host = "api.example.com"): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ hostname: "127.0.0.1", port: proxy.port, method,
			path: socket ? "/resource?q=1" : `http://${host}/resource?q=1`,
			headers: { host, connection: "close" }, ...(socket ? { createConnection: () => socket } : { agent: false }),
			signal: AbortSignal.timeout(5000) }, (res) => {
			let body = ""; res.setEncoding("utf8");
			res.on("data", (chunk: string) => { body += chunk; });
			res.once("error", reject); res.once("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.once("error", reject); req.end(); socket?.resume();
	});
}

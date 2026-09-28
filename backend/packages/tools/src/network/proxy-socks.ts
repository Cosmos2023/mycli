import type { Socket } from "node:net";
import { ProxySocketReader } from "./proxy-socket.ts";
import { NetworkProxyError } from "./proxy-protocol.ts";

export interface SocksTarget {
	readonly hostname: string;
	readonly port: number;
	readonly head: Buffer;
}

export async function readSocksTarget(socket: Socket, signal: AbortSignal): Promise<SocksTarget> {
	const reader = new ProxySocketReader(socket, signal);
	try {
		const greeting = await reader.read(2);
		if (greeting[0] !== 5 || greeting[1] === 0) throw new NetworkProxyError(400, "Invalid SOCKS5 greeting.");
		const methods = await reader.read(greeting[1]!);
		if (!methods.includes(0)) {
			socket.end(Buffer.from([5, 255]));
			throw new NetworkProxyError(400, "SOCKS5 authentication method is unsupported.");
		}
		socket.write(Buffer.from([5, 0]));
		const request = await reader.read(4);
		if (request[0] !== 5 || request[2] !== 0) throw new NetworkProxyError(400, "Invalid SOCKS5 request.");
		if (request[1] !== 1) {
			socket.end(socksReply(7));
			throw new NetworkProxyError(400, "Only SOCKS5 CONNECT is supported.");
		}
		let hostname: string;
		switch (request[3]) {
			case 1: hostname = [...await reader.read(4)].join("."); break;
			case 3: {
				const length = (await reader.read(1))[0]!;
				const bytes = await reader.read(length);
				if (length === 0 || bytes.some((byte) => byte < 33 || byte > 126)) throw new NetworkProxyError(400, "Invalid SOCKS5 hostname.");
				hostname = bytes.toString("ascii"); break;
			}
			case 4: {
				const bytes = await reader.read(16);
				hostname = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(":"); break;
			}
			default: throw new NetworkProxyError(400, "Unsupported SOCKS5 address type.");
		}
		const port = (await reader.read(2)).readUInt16BE(0);
		if (port === 0 || /[\\/@?#\s]/u.test(hostname)) throw new NetworkProxyError(400, "Invalid SOCKS5 destination.");
		return { hostname, port, head: reader.finish() };
	} finally { reader.finish(); }
}

export function socksReply(code: number): Buffer {
	return Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
}

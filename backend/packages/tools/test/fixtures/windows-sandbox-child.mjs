import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createSocket } from "node:dgram";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { request } from "node:http";
import { connect as connectTls } from "node:tls";

const [operation, target, argument] = process.argv.slice(2);

function readUntil(socket, size) {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const cleanup = () => { socket.off("data", onData); socket.off("error", onError); };
		const onError = (error) => { cleanup(); reject(error); };
		const onData = (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			const length = size(buffer);
			if (length <= 0 || buffer.length < length) return;
			cleanup(); socket.pause();
			if (buffer.length > length) socket.unshift(buffer.subarray(length));
			resolve(buffer.subarray(0, length));
		};
		socket.on("data", onData); socket.on("error", onError); socket.resume();
	});
}

async function connectTunnel(socket, hostname, port) {
	socket.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`);
	const response = await readUntil(socket, (bytes) =>
		bytes.includes("\r\n\r\n") ? bytes.indexOf("\r\n\r\n") + 4 : 0);
	if (!response.toString().startsWith("HTTP/1.1 200")) {
		console.log(`proxy:${response.toString().split(" ")[1] ?? "denied"}`);
		process.exit(44);
	}
	socket.resume();
}

async function connectSocks(socket, hostname, port) {
	socket.write(Buffer.from([5, 1, 0]));
	const greeting = await readUntil(socket, (bytes) => bytes.length >= 2 ? 2 : 0);
	if (greeting[1] !== 0) throw new Error("socks greeting rejected");
	const host = Buffer.from(hostname);
	const ending = Buffer.alloc(2);
	ending.writeUInt16BE(port);
	socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, ending]));
	const head = await readUntil(socket, (bytes) => bytes.length >= 4 ? 4 : 0);
	if (head[1] !== 0) { console.log("network:denied"); process.exit(37); }
	const rest = head[3] === 1 ? 6 : head[3] === 4 ? 18 : 0;
	if (rest > 0) await readUntil(socket, (bytes) => bytes.length >= rest ? rest : 0);
	socket.resume();
}

function requestOver(socket, url, method) {
	return new Promise((resolve, reject) => {
		const destination = new URL(url);
		const call = request({ method, path: `${destination.pathname}${destination.search}`,
			headers: { host: destination.host }, createConnection: () => socket }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => { body += chunk; });
			response.on("end", () => resolve({ status: response.statusCode, body }));
		});
		call.on("error", reject);
		call.end();
	});
}

try {
	switch (operation) {
		case "list":
			console.log(`list:${readdirSync(target).length}`);
			break;
		case "read":
			console.log(`read:${readFileSync(target, "utf8")}`);
			break;
		case "replace":
			unlinkSync(target);
			writeFileSync(target, "replacement");
			break;
		case "hold":
			console.log("hold:ready");
			setInterval(() => {}, 1_000);
			break;
		case "write":
			writeFileSync(target, "sandbox-write");
			console.log("write:ok");
			break;
		case "connect": {
			const socket = createConnection({ host: target, port: Number(argument) });
			socket.setTimeout(3_000, () => { socket.destroy(); process.exit(38); });
			socket.on("error", () => { console.log("network:denied"); process.exit(37); });
			socket.on("connect", () => { console.log("network:ok"); socket.end(); });
			break;
		}
		case "udp": {
			const socket = createSocket(target.includes(":") ? "udp6" : "udp4");
			const timer = setTimeout(() => finish(37), 1_500);
			let finished = false;
			function finish(code) {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				console.log(code === 0 ? "network:ok" : "network:denied");
				socket.close();
				process.exitCode = code;
			}
			socket.on("error", () => finish(37));
			socket.on("message", (message, remote) => {
				if (remote.address === target && remote.port === Number(argument)
					&& message.toString() === "sandbox-ack") finish(0);
			});
			socket.send("sandbox", Number(argument), target, (error) => {
				if (error) finish(37);
			});
			break;
		}
		case "stdio":
			console.log(`env:${process.env.LANG}`);
			console.error("stderr:ok");
			break;
		case "proxy":
		case "proxy-hold": {
			const destination = new URL(target);
			const proxy = new URL(process.env.HTTP_PROXY);
			const call = request({ hostname: proxy.hostname, port: proxy.port,
				path: target, headers: { Host: destination.host } }, (response) => {
				response.setEncoding("utf8");
				let body = "";
				response.on("data", (chunk) => { body += chunk; });
				response.on("end", () => {
					console.log(`proxy:${response.statusCode}:${body}`);
					if (response.statusCode !== 200) process.exitCode = 44;
					else if (operation === "proxy-hold") setInterval(() => {}, 1_000);
				});
			});
			call.on("error", () => { console.log("network:denied"); process.exit(37); });
			call.setTimeout(3_000, () => { call.destroy(); process.exit(38); });
			call.end();
			break;
		}
		case "proxy-env": {
			for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
				"http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
				console.log(`${name}=${process.env[name] ?? ""}`);
			}
			break;
		}
		case "proxy-socks":
		case "proxy-https":
		case "proxy-post": {
			const destination = new URL(target);
			const secure = destination.protocol === "https:";
			const proxy = new URL(operation === "proxy-socks" ? process.env.ALL_PROXY : process.env.HTTP_PROXY);
			const socket = createConnection({ host: proxy.hostname, port: Number(proxy.port) });
			await new Promise((resolve, reject) => {
				socket.once("connect", resolve); socket.once("error", reject);
			});
			const port = Number(destination.port || (secure ? 443 : 80));
			if (operation === "proxy-socks") await connectSocks(socket, destination.hostname, port);
			else await connectTunnel(socket, destination.hostname, port);
			let tunnel = socket;
			if (secure) {
				tunnel = connectTls({ socket, servername: destination.hostname, ALPNProtocols: ["http/1.1"],
					ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS) });
				await new Promise((resolve, reject) => {
					tunnel.once("secureConnect", resolve); tunnel.once("error", reject);
				});
			}
			const response = await requestOver(tunnel, target, operation === "proxy-post" ? "POST" : "GET");
			console.log(`proxy:${response.status}:${response.body}`);
			if (response.status !== 200) process.exitCode = operation === "proxy-post" ? 45 : 44;
			break;
		}
		case "echo":
			console.log("input:ready");
			createInterface({ input: process.stdin }).once("line", (line) => {
				console.log(`input:${line}`);
				process.exit(0);
			});
			break;
		case "tree":
		case "tree-exit": {
			const child = spawn(process.execPath, [process.argv[1], "delayed-write", target], {
				stdio: "ignore", detached: true,
			});
			child.unref();
			console.log(`descendant:${child.pid}`);
			if (operation === "tree") setInterval(() => {}, 1_000);
			break;
		}
		case "delayed-write":
			setTimeout(() => writeFileSync(target, "leaked-child"), 2_500);
			break;
		default:
			throw new Error("unknown fixture operation");
	}
} catch (error) {
	if (error.code === "EACCES" || error.code === "EPERM") {
		console.log("filesystem:denied");
		process.exitCode = 23;
	} else {
		throw error;
	}
}

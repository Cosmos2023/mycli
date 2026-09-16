import { readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createSocket } from "node:dgram";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { request } from "node:http";

const [operation, target, argument] = process.argv.slice(2);
try {
	switch (operation) {
		case "read":
			console.log(`read:${readFileSync(target, "utf8")}`);
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
			socket.send("sandbox", Number(argument), target, (error) => {
				console.log(error ? "network:denied" : "network:ok");
				socket.close();
				process.exitCode = error ? 37 : 0;
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

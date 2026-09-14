import { registerHooks } from "node:module";
import { createInterface } from "node:readline";

const loaded = [];
registerHooks({ load(url, context, nextLoad) {
	if (url.includes("/@earendil-works/pi-ai/")) loaded.push(url);
	return nextLoad(url, context);
} });
const { startNodeBackend } = await import("../../dist/node-runtime/node-backend.js");
const backend = await startNodeBackend({ cwd: process.cwd(), args: [], env: process.env });
const responses = new Map();
const lines = createInterface({ input: backend.transport.input, crlfDelay: Infinity });
const ready = new Promise((resolve) => lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method === "runtime.ready") resolve();
	if (message.id) responses.get(message.id)?.(message);
}));
let sequence = 0;
const request = (method, params) => new Promise((resolve, reject) => {
	const id = String(++sequence);
	responses.set(id, (message) => {
		responses.delete(id);
		if (message.error) reject(new Error(JSON.stringify(message.error)));
		else resolve(message.result);
	});
	backend.transport.output.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
try {
	await ready;
	const bootstrap = await request("session.bootstrap", { protocol_version: 1 });
	const startupModules = [...loaded];
	const catalog = await request("provider.list", {});
	await request("shutdown", {});
	await backend.completion;
	process.stdout.write(JSON.stringify({ startupModules, catalogModules: loaded, auth: bootstrap.auth_status, providers: catalog }) + "\n");
} finally {
	lines.close();
	await backend.close();
}

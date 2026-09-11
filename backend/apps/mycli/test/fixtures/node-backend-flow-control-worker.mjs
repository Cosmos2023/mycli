import { parentPort, workerData } from "node:worker_threads";

const { generation, options } = workerData;
const mode = options.args[0];
let sequence = 0;
function send(message) {
	parentPort.postMessage({ type: "output", generation, sequence: ++sequence, chunk: `${JSON.stringify(message)}\n` });
}

send({ jsonrpc: "2.0", method: "runtime.ready", params: { session_id: "flow-session" } });
parentPort.postMessage({ type: "started", generation });
parentPort.on("message", (message) => {
	if (message.type === "close") {
		parentPort.postMessage({ type: "completion", generation, code: 0 });
		parentPort.close();
		return;
	}
	if (message.type !== "input") return;
	if (mode !== "no-ack") parentPort.postMessage({ type: "input_ack", generation, sequence: message.sequence });
	const request = JSON.parse(message.chunk);
	if (request.method === "fail") {
		parentPort.postMessage({ type: "completion", generation, code: 1, diagnostic: "gateway_overloaded" });
		parentPort.close();
		return;
	}
	if (request.method === "flood") {
		for (let index = 0; index < 4; index++) {
			send({ jsonrpc: "2.0", method: "message.delta", params: { client_turn_id: "turn", text: "x".repeat(128 * 1024) } });
		}
		return;
	}
	if (request.method === "hold") return;
	send({ jsonrpc: "2.0", id: request.id, result: { ...request.params, generation } });
});

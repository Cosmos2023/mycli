import { parentPort, workerData } from "node:worker_threads";

const INTERRUPT_DELAY_MS = 350;
const { generation, options } = workerData;
const sessionId = flagValue(options.args, "--session") ?? "supervisor-session";
const recovery = options.recoverInterruptedTurns?.[0];
let input = "";

function send(message) {
	parentPort.postMessage({
		type: "output",
		generation,
		chunk: `${JSON.stringify(message)}\n`,
	});
}

send({
	jsonrpc: "2.0",
	method: "runtime.ready",
	params: { session_id: sessionId, coordinator_generation: generation },
});
if (recovery) {
	sendInterrupted(recovery.turnId, false);
}
parentPort.postMessage({ type: "started", generation });

parentPort.on("message", (message) => {
	if (message.type === "close") {
		parentPort.postMessage({ type: "completion", generation, code: 0 });
		parentPort.close();
		return;
	}
	if (message.type !== "input") return;
	input += message.chunk;
	let newline = input.indexOf("\n");
	while (newline >= 0) {
		const line = input.slice(0, newline);
		input = input.slice(newline + 1);
		handleLine(line);
		newline = input.indexOf("\n");
	}
});

function handleLine(line) {
	const request = JSON.parse(line);
	if (request.method === "turn.submit") {
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				accepted: true,
				client_turn_id: "client-responsive",
				client_user_message_id: "message-responsive",
				turn_id: "turn-responsive",
			},
		});
		send({
			jsonrpc: "2.0",
			method: "turn.started",
			params: { client_turn_id: "client-responsive", turn_id: "turn-responsive" },
		});
		return;
	}
	if (request.method !== "turn.interrupt") return;
	setTimeout(() => {
		sendInterrupted("turn-responsive", true);
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				accepted: true,
				requested: true,
				client_turn_id: "client-responsive",
				turn_id: "turn-responsive",
				input_rolled_back: false,
				coordinator_generation: generation,
			},
		});
	}, INTERRUPT_DELAY_MS);
}

function sendInterrupted(turnId, requested) {
	send({
		jsonrpc: "2.0",
		method: "turn.interrupted",
		params: {
			client_turn_id: "client-responsive",
			turn_id: turnId,
			code: "interrupted",
			requested,
			message: "Turn interrupted",
			input_rolled_back: false,
			coordinator_generation: generation,
		},
	});
}

function flagValue(args, flag) {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

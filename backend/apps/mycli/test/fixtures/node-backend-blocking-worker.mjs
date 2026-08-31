import { parentPort, workerData } from "node:worker_threads";

const { generation, options } = workerData;
const sessionId = flagValue(options.args, "--session") ?? "supervisor-session";
const configProfile = flagValue(options.args, "--profile");
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
	params: { session_id: sessionId, config_profile: configProfile },
});
if (recovery) {
	send({
		jsonrpc: "2.0",
		method: "turn.interrupted",
		params: {
			client_turn_id: "client-blocking",
			turn_id: recovery.turnId,
			code: "interrupted",
			requested: false,
			message: "Turn interrupted",
			input_rolled_back: false,
		},
	});
	send({
		jsonrpc: "2.0",
		method: "turn.status",
		params: {
			state: "interrupted",
			kind: "interrupted",
			text: "Interrupted",
			terminal: true,
			client_turn_id: "client-blocking",
			turn_id: recovery.turnId,
		},
	});
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
	if (request.method !== "turn.submit") return;
	send({
		jsonrpc: "2.0",
		id: request.id,
		result: {
			accepted: true,
			client_turn_id: "client-blocking",
			client_user_message_id: "message-blocking",
			turn_id: "turn-blocking",
		},
	});
	send({
		jsonrpc: "2.0",
		method: "turn.started",
		params: { client_turn_id: "client-blocking", turn_id: "turn-blocking" },
	});
	setImmediate(() => {
		for (;;) {
			// This intentionally blocks the Worker event loop for the watchdog test.
		}
	});
}

function flagValue(args, flag) {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

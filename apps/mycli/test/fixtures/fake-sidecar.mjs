import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });

process.stdout.write(`${JSON.stringify({
	jsonrpc: "2.0",
	method: "runtime.ready",
	params: { session_id: "fake-session" },
})}\n`);

lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method === "shutdown") {
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
		lines.close();
	}
});

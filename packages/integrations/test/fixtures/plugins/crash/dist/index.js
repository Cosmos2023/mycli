import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

export async function register(context) {
	const mode = process.env.PLUGIN_TEST_MODE;
	if (mode === "startup_timeout") await new Promise(() => undefined);
	if (mode === "missing") return;
	if (mode === "undeclared") {
		context.registerTool({
			name: "undeclared",
			description: "Must be rejected.",
			inputSchema: { type: "object", properties: {} },
		}, async () => ({}));
		return;
	}
	context.registerCommand({
		name: "act",
		description: "Exercise one terminal worker behavior.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	}, async () => {
		switch (mode) {
			case "crash":
				process.exit(91);
				break;
			case "malformed":
				process.stdout.write("not-json\n");
				return await new Promise(() => undefined);
			case "unknown_response":
				process.stdout.write(`${JSON.stringify({
					version: 2,
					type: "result",
					request_id: "unknown-request",
					value: null,
				})}\n`);
				return await new Promise(() => undefined);
			case "stdout_flood":
				process.stdout.write(`${"x".repeat(300_000)}\n`);
				return await new Promise(() => undefined);
			case "stderr_flood":
				process.stderr.write("x".repeat(100_000));
				return await new Promise(() => undefined);
		case "call_timeout":
				return await new Promise(() => undefined);
			case "handler_throw":
				throw new Error("private handler failure");
			case "grandchild": {
				const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
					stdio: "ignore",
				});
				await writeFile(process.env.PLUGIN_TEST_VALUE, String(child.pid), "utf8");
				return await new Promise(() => undefined);
			}
			default:
				return { ok: true, summary: "ok", metadata: {} };
		}
		return { ok: false, summary: "unreachable", metadata: {} };
	});
}

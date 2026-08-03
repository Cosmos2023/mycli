import { spawn } from "node:child_process";
import { runCli } from "../../src/cli.ts";
import { startPythonSidecar } from "../../src/sidecar/python-sidecar.ts";

const fixture = process.env.MYCLI_FIXTURE_PATH;
const pidFile = process.env.MYCLI_FIXTURE_PID_FILE;
if (!fixture || !pidFile) {
	process.exit(2);
}

void runCli({
	argv: [],
	env: { ...process.env, MYCLI_FIXTURE_PID_FILE: pidFile },
	cwd: process.cwd(),
	stdin: { isTTY: true },
	stdout: { isTTY: true, write: () => undefined },
	stderr: { write: () => undefined },
	startSidecar: (options) => startPythonSidecar({
		...options,
		spawn: (_command, _args, spawnOptions) => spawn(process.execPath, [fixture], spawnOptions),
	}),
	configureTransport: () => undefined,
	importTui: async () => ({ gatewayStartup: new Promise(() => undefined) }),
});

setTimeout(() => process.exit(17), 200);

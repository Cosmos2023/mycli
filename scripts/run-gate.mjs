#!/usr/bin/env node

// Runs one CI gate, mirrors its output, and republishes the diagnostic tail as
// annotations. A failed step's log needs authentication to download, so the
// annotations are the only failure evidence an anonymous reader can fetch.
import { spawn } from "node:child_process";
import process from "node:process";

const [label, command] = process.argv.slice(2);
if (!label || !command) {
	process.stderr.write("usage: run-gate.mjs <label> <command>\n");
	process.exitCode = 64;
} else {
	const captured = [];
	const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
	const mirror = (chunk) => { captured.push(chunk); process.stdout.write(chunk); };
	child.stdout.on("data", mirror);
	child.stderr.on("data", mirror);
	child.once("error", (error) => {
		process.stderr.write(`gate_spawn_failed:${error.message}\n`);
		process.exitCode = 1;
	});
	child.once("exit", (code, signal) => {
		const status = signal === null ? code ?? 1 : 1;
		if (status !== 0 && process.env.GITHUB_ACTIONS === "true") {
			reportFailure(label, Buffer.concat(captured).toString("utf8"));
		}
		process.exitCode = status;
	});
}

function reportFailure(label, output) {
	const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
	const diagnostics = lines.filter((line) => /error TS\d+|✖ |error:|Error:|ERR_|not ok|Cannot find/i.test(line));
	const selected = (diagnostics.length > 0 ? diagnostics : lines).slice(-6);
	process.stdout.write(`::error title=${label}::gate failed\n`);
	for (const line of selected) {
		process.stdout.write(`::error::${line.replaceAll("%", "%25")}\n`);
	}
}

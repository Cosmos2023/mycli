import { writeFileSync } from "node:fs";

if (process.env.MYCLI_FIXTURE_PID_FILE) {
	writeFileSync(process.env.MYCLI_FIXTURE_PID_FILE, String(process.pid));
}

process.stderr.write(`Authorization: Bearer crashing-secret-value ${"y".repeat(12_000)}\n`);

if (process.env.MYCLI_FIXTURE_CRASH_PHASE === "after-ready") {
	process.stdout.write(`${JSON.stringify({
		jsonrpc: "2.0",
		method: "runtime.ready",
		params: { session_id: "crash-fixture" },
	})}\n`);
	setTimeout(() => process.exit(9), 50);
} else {
	setTimeout(() => process.exit(7), 10);
}

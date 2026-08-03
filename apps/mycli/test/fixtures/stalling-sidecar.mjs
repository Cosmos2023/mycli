import { writeFileSync } from "node:fs";

if (process.env.MYCLI_FIXTURE_PID_FILE) {
	writeFileSync(process.env.MYCLI_FIXTURE_PID_FILE, String(process.pid));
}

process.stderr.write(`api_key=sk-stalling-secret ${"x".repeat(12_000)}\n`);
process.stdin.resume();

process.on("SIGTERM", () => {
	if (process.env.MYCLI_FIXTURE_IGNORE_SIGTERM !== "1") {
		process.exit(0);
	}
});

const failsafeMs = Number(process.env.MYCLI_FIXTURE_FAILSAFE_MS ?? 0);
if (Number.isFinite(failsafeMs) && failsafeMs > 0) {
	setTimeout(() => process.exit(3), failsafeMs);
}

setInterval(() => undefined, 1_000);

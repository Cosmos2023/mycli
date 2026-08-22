import process from "node:process";
import { applyV10ContentBlobMigrationCutover } from "../../src/index.ts";

const [dbPath] = process.argv.slice(2);
if (!dbPath) throw new Error("db path is required");
try {
	const result = applyV10ContentBlobMigrationCutover({
		dbPath,
		busyTimeoutMs: 5_000,
		clock: () => "2026-08-14T00:00:00.000Z",
	});
	process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
	process.stdout.write(JSON.stringify({
		ok: false,
		message: error instanceof Error ? error.message : "unknown error",
		diagnostics: typeof error === "object" && error !== null && "diagnostics" in error
			? error.diagnostics
			: {},
	}));
}

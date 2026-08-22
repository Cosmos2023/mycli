import process from "node:process";
import { stageV10ContentBlobMigrationBatch } from "../../src/index.ts";

const [dbPath, rawBatchSize] = process.argv.slice(2);
if (!dbPath) throw new Error("db path is required");
const result = stageV10ContentBlobMigrationBatch({
	dbPath,
	batchSize: Number(rawBatchSize),
	busyTimeoutMs: 5_000,
	clock: () => "2026-08-14T00:00:00.000Z",
});
process.stdout.write(JSON.stringify(result));

import process from "node:process";
import { stageV9TranscriptNormalizationBatch } from "../../src/index.ts";

const [dbPath, rawBatchSize] = process.argv.slice(2);
if (!dbPath) throw new Error("db path is required");
const batchSize = Number(rawBatchSize);
const result = stageV9TranscriptNormalizationBatch({
	dbPath,
	batchSize,
	busyTimeoutMs: 5_000,
	clock: () => "2026-08-14T00:00:00.000Z",
});
process.stdout.write(JSON.stringify(result));

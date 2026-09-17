import { randomUUID } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { exportSessionTrainingData, isTrainingSecretKey } from "@mycli/runtime";
import type { SessionTrainingExportReport, TrainingExportStore } from "@mycli/runtime";
import type { SessionSummary } from "./session-service.ts";
import type { SessionTrainingExportSettings } from "./session-training-export-options.ts";

export interface TrainingExportResult {
	readonly output_path: string;
	readonly report: SessionTrainingExportReport;
}

export type TrainingExportHandler = (
	session: SessionSummary, settings: SessionTrainingExportSettings, signal: AbortSignal,
) => Promise<TrainingExportResult>;

export class TrainingExportError extends Error {
	constructor(readonly code: "training_export_exists" | "training_export_cancelled" | "training_export_failed") {
		super(code === "training_export_exists" ? "Output already exists; choose a new JSONL file."
			: code === "training_export_cancelled" ? "Training export cancelled."
				: "Training export failed; check the session database and output directory.");
		this.name = "TrainingExportError";
	}
}

export function createTrainingExportHandler(store: TrainingExportStore, environment: {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly apiKey?: string;
}): TrainingExportHandler {
	return async (session, settings, signal) => {
		const outputName = settings.outputPath
			?? `session-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}.jsonl`;
		const outputPath = resolve(environment.workspaceRoot, outputName);
		const secrets = Object.entries(environment.env).flatMap(([key, value]) => isTrainingSecretKey(key) && value ? [value] : []);
		if (environment.apiKey) secrets.push(environment.apiKey);
		const report = await writeTrainingExportFile(outputPath, (writeChunk) => exportSessionTrainingData(store, {
			sessionId: session.id,
			signal, secrets, paths: [
				{ path: session.cwd, replacement: "[WORKSPACE]" },
				{ path: environment.workspaceRoot, replacement: "[WORKSPACE]" },
				{ path: environment.homeDir, replacement: "[HOME]" },
			],
		}, writeChunk), signal);
		return { output_path: outputPath, report };
	};
}

/** Publish with link(), so even a destination created during export cannot be overwritten. */
export async function writeTrainingExportFile<Report>(
	outputPath: string,
	produce: (writeChunk: (line: string) => Promise<void>) => Promise<Report>,
	signal: AbortSignal,
): Promise<Report> {
	const temporaryPath = join(dirname(outputPath), `.mycli-training-${randomUUID()}.tmp`);
	let file: FileHandle | undefined;
	try {
		signal.throwIfAborted();
		try {
			await lstat(outputPath);
			throw new TrainingExportError("training_export_exists");
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		file = await open(temporaryPath, "wx", 0o600);
		const writer = file;
		const report = await produce(async (line) => {
			signal.throwIfAborted();
			await writer.writeFile(line, "utf8");
		});
		await file.sync();
		await file.close();
		file = undefined;
		signal.throwIfAborted();
		await link(temporaryPath, outputPath);
		return report;
	} catch (error) {
		if (signal.aborted) throw new TrainingExportError("training_export_cancelled");
		if (error instanceof TrainingExportError) throw error;
		throw new TrainingExportError(errorCode(error) === "EEXIST" ? "training_export_exists" : "training_export_failed");
	} finally {
		await file?.close().catch(() => undefined);
		await unlink(temporaryPath).catch(() => undefined);
	}
}

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

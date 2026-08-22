import { existsSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { SCHEMA_V12_VERSION } from "./schema.ts";
import { StorageFailure } from "./session-store.ts";
import type { SQLiteSessionStoreOptions } from "./sqlite-session-store.ts";
import { SQLiteTranscriptEventRepository } from "./transcript-event-repository.ts";

export type RuntimeSessionStore = SQLiteTranscriptEventRepository;

export type OpenRuntimeSessionStoreOptions = SQLiteSessionStoreOptions;

export function openRuntimeSessionStore(
	options: OpenRuntimeSessionStoreOptions,
): RuntimeSessionStore {
	const schema = inspectRuntimeSessionSchema(options.dbPath);
	if (schema === "empty") {
		return new SQLiteTranscriptEventRepository({
			...options,
			initializeSchemaVersion: SCHEMA_V12_VERSION,
		});
	}
	if (schema === SCHEMA_V12_VERSION) {
		return new SQLiteTranscriptEventRepository(options);
	}
	throw new StorageFailure("unsupported session schema version", {
		expected_version: SCHEMA_V12_VERSION,
		actual_version: schema,
	});
}

function inspectRuntimeSessionSchema(dbPath: string): "empty" | number {
	if (!existsSync(dbPath) || statSync(dbPath).size === 0) return "empty";
	let database: Database.Database | undefined;
	try {
		database = new Database(dbPath, { readonly: true, fileMustExist: true });
		const marker = database.prepare(`
			SELECT 1 AS present FROM sqlite_master
			WHERE type = 'table' AND name = 'schema_version'
		`).get();
		if (!marker) {
			const objects = database.prepare(`
				SELECT COUNT(*) AS count FROM sqlite_master
				WHERE name NOT LIKE 'sqlite_%'
			`).get() as { readonly count: unknown };
			if (Number(objects.count) === 0) return "empty";
			throw new StorageFailure("session schema version marker is invalid");
		}
		const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as {
			readonly version: unknown;
		} | undefined;
		if (!row || typeof row.version !== "number" || !Number.isSafeInteger(row.version)) {
			throw new StorageFailure("session schema version marker is invalid");
		}
		return row.version;
	} catch (error) {
		if (error instanceof StorageFailure) throw error;
		throw new StorageFailure("session schema inspection failed", {
			...(sqliteCode(error) ? { sqlite_code: sqliteCode(error) } : {}),
		});
	} finally {
		database?.close();
	}
}

function sqliteCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" && error.code.length <= 64 ? error.code : undefined;
}

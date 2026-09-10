// Frozen storage admission gate from 1598f84ba11e5274b54404d104e9a0da2ec62e04.
// The repository constructor is injected so tests prove rejection before writable access.
import { existsSync, statSync } from "node:fs";
import Database from "better-sqlite3";

export function openPreviousRuntimeSessionStore(options, createRepository) {
	const schema = inspectRuntimeSessionSchema(options.dbPath);
	if (schema === "empty") return createRepository({ ...options, initializeSchemaVersion: 12 });
	if (schema === 12) return createRepository(options);
	const error = new Error("persistence_error: unsupported session schema version");
	error.code = "persistence_error";
	error.diagnostics = { expected_version: 12, actual_version: schema };
	throw error;
}

function inspectRuntimeSessionSchema(dbPath) {
	if (!existsSync(dbPath) || statSync(dbPath).size === 0) return "empty";
	const database = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const marker = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
		if (!marker) {
			const objects = database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get();
			if (Number(objects.count) === 0) return "empty";
			throw new Error("session schema version marker is invalid");
		}
		const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get();
		if (!row || typeof row.version !== "number" || !Number.isSafeInteger(row.version)) throw new Error("session schema version marker is invalid");
		return row.version;
	} finally { database.close(); }
}

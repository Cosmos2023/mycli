import type Database from "better-sqlite3";
import { SCHEMA_V13_VERSION, SCHEMA_V14_VERSION } from "../../schema.ts";
import { StorageFailure } from "../../sessions/session-store.ts";

export function migrateV13ErrorContexts(
	database: Database.Database,
	write: <Result>(operation: () => Result) => Result,
): typeof SCHEMA_V14_VERSION {
	return write(() => {
		const version = database.prepare("SELECT version FROM schema_version LIMIT 1").pluck().get();
		if (version === SCHEMA_V14_VERSION) return SCHEMA_V14_VERSION;
		if (version !== SCHEMA_V13_VERSION) throw new StorageFailure("error context migration requires schema version 13");
		// The JSON payload format changes; existing tables and transcript bytes do not.
		database.prepare("UPDATE schema_version SET version = ? WHERE version = ?")
			.run(SCHEMA_V14_VERSION, SCHEMA_V13_VERSION);
		return SCHEMA_V14_VERSION;
	});
}

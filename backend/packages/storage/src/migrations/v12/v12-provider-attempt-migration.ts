import type Database from "better-sqlite3";
import { SCHEMA_V12_VERSION, SCHEMA_V13_PROVIDER_ATTEMPTS_SQL, SCHEMA_V13_VERSION } from "../../schema.ts";
import { StorageFailure } from "../../sessions/session-store.ts";

export function migrateV12ProviderAttempts(
	database: Database.Database,
	write: <Result>(operation: () => Result) => Result,
): typeof SCHEMA_V13_VERSION {
	return write(() => {
		const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as {
			readonly version: unknown;
		} | undefined;
		if (row?.version === SCHEMA_V13_VERSION) return SCHEMA_V13_VERSION;
		if (row?.version !== SCHEMA_V12_VERSION) {
			throw new StorageFailure("provider attempt migration requires schema version 12");
		}
		database.exec(SCHEMA_V13_PROVIDER_ATTEMPTS_SQL);
		database.prepare("UPDATE schema_version SET version = ? WHERE version = ?")
			.run(SCHEMA_V13_VERSION, SCHEMA_V12_VERSION);
		return SCHEMA_V13_VERSION;
	});
}

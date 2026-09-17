import type Database from "better-sqlite3";
import { SCHEMA_V14_VERSION, SCHEMA_V15_VERSION, SESSION_GOAL_USAGE_SQL } from "../../schema.ts";
import { StorageFailure } from "../../sessions/session-store.ts";

/** A format fence for goal snapshots and machine-generated continuation inputs. */
export function migrateV14Goals(
	database: Database.Database,
	write: <Result>(operation: () => Result) => Result,
): typeof SCHEMA_V15_VERSION {
	return write(() => {
		const version = database.prepare("SELECT version FROM schema_version LIMIT 1").pluck().get();
		if (version === SCHEMA_V15_VERSION) return SCHEMA_V15_VERSION;
		if (version !== SCHEMA_V14_VERSION) throw new StorageFailure("goal migration requires schema version 14");
		database.exec(SESSION_GOAL_USAGE_SQL);
		database.prepare("UPDATE schema_version SET version = ? WHERE version = ?")
			.run(SCHEMA_V15_VERSION, SCHEMA_V14_VERSION);
		return SCHEMA_V15_VERSION;
	});
}

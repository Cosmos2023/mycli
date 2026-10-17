import type Database from "better-sqlite3";
import { SCHEMA_V15_VERSION, SCHEMA_V16_VERSION } from "../../schema.ts";
import { StorageFailure } from "../../sessions/session-store.ts";

/**
 * A format fence for turn inputs an extension admitted under its own label.
 *
 * There is no SQL to run: the payload of a `user_input` event gained a source value and an owner id,
 * so the marker is the only thing that has to move. It still has to move, because a reader that
 * predates the value rejects the event rather than ignoring it.
 */
export function migrateV15ExtensionInputs(
	database: Database.Database,
	write: <Result>(operation: () => Result) => Result,
): typeof SCHEMA_V16_VERSION {
	return write(() => {
		const version = database.prepare("SELECT version FROM schema_version LIMIT 1").pluck().get();
		if (version === SCHEMA_V16_VERSION) return SCHEMA_V16_VERSION;
		if (version !== SCHEMA_V15_VERSION) {
			throw new StorageFailure("extension input migration requires schema version 15");
		}
		database.prepare("UPDATE schema_version SET version = ? WHERE version = ?")
			.run(SCHEMA_V16_VERSION, SCHEMA_V15_VERSION);
		return SCHEMA_V16_VERSION;
	});
}

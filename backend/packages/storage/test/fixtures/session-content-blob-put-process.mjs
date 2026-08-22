import process from "node:process";
import Database from "better-sqlite3";
import { SQLiteSessionContentBlobRepository } from "../../src/index.ts";

const [dbPath] = process.argv.slice(2);
if (!dbPath) throw new Error("db path is required");

const database = new Database(dbPath);
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");
const write = (operation) => {
	if (database.inTransaction) return operation();
	database.exec("BEGIN IMMEDIATE");
	try {
		const result = operation();
		database.exec("COMMIT");
		return result;
	} catch (error) {
		if (database.inTransaction) database.exec("ROLLBACK");
		throw error;
	}
};
const repository = new SQLiteSessionContentBlobRepository({
	database,
	write,
	clock: () => "2026-08-14T00:00:00.000Z",
});

try {
	const blob = repository.put("shared concurrent payload\n".repeat(1_000));
	process.stdout.write(JSON.stringify({ blobId: blob.blobId }));
} finally {
	database.close();
}

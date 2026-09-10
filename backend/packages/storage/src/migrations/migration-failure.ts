import { StorageFailure } from "../sessions/session-store.ts";

export function migrationFailure(error: unknown, fallback: string): Error {
	if (error instanceof StorageFailure || error instanceof RangeError) return error;
	const code = sqliteCode(error);
	if (code?.startsWith("SQLITE_BUSY") || code?.startsWith("SQLITE_LOCKED")) {
		return new StorageFailure("database is busy", { sqlite_code: code });
	}
	return new StorageFailure(fallback, { ...(code ? { sqlite_code: code } : {}) });
}

function sqliteCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || Array.isArray(error) || !("code" in error)) {
		return undefined;
	}
	return typeof error.code === "string" ? error.code.slice(0, 64) : undefined;
}

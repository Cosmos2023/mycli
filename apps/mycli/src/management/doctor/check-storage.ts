import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@mycli/storage";
import { scanDoctorFiles } from "./redaction.ts";
import type { DoctorCheck } from "./types.ts";

export interface StorageDoctorOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
}

const REQUIRED_SCHEMA_OBJECTS = Object.freeze(new Map<string, string>([
	["schema_version", "table"],
	["sessions", "table"],
	["conversation_messages", "table"],
	["conversation_messages_fts", "table"],
	["conversation_messages_fts_insert", "trigger"],
	["conversation_messages_fts_delete", "trigger"],
	["conversation_messages_fts_update", "trigger"],
	["conversation_trees", "table"],
	["history_items", "table"],
	["history_items_fts", "table"],
	["history_items_fts_insert", "trigger"],
	["history_items_fts_delete", "trigger"],
	["history_items_fts_update", "trigger"],
	["turn_rollouts", "table"],
	["session_state", "table"],
	["session_summaries", "table"],
	["runtime_turns", "table"],
	["subagent_tasks", "table"],
]));
const CRITICAL_STATE_KEYS = Object.freeze([
	"pending_decision",
	"suspended_turn",
	"turn_record",
	"responses_continuation_state",
]);
const MAX_TRACE_FILES = 64;
const MAX_TRACE_FILE_BYTES = 1_048_576;

export async function collectStorageChecks(
	options: StorageDoctorOptions,
): Promise<readonly DoctorCheck[]> {
	const homeRoot = join(options.homeDir, ".mycli");
	const logsRoot = join(homeRoot, "logs");
	const tracesRoot = join(homeRoot, "traces");
	return Object.freeze([
		await checkStorageLayout(homeRoot),
		await checkSessionsDatabase(join(homeRoot, "sessions.db")),
		await checkDirectory("logs", logsRoot, "warning"),
		await checkTraces(tracesRoot),
		await checkRedaction(homeRoot, logsRoot, tracesRoot),
	]);
}

async function checkStorageLayout(homeRoot: string): Promise<DoctorCheck> {
	const problems: string[] = [];
	for (const name of ["traces", "artifacts"] as const) {
		const metadata = await optionalStat(join(homeRoot, name));
		if (!metadata) continue;
		if (!metadata.isDirectory()) problems.push(`${name}_not_directory`);
		else if ((metadata.mode & 0o222) === 0) problems.push(`${name}_not_writable`);
	}
	return problems.length > 0
		? check("storage_layout", "failed", `issues=${problems.length}`, problems.join(","))
		: check("storage_layout", "ok", "reserved storage layout valid");
}

async function checkSessionsDatabase(path: string): Promise<DoctorCheck> {
	const metadata = await optionalStat(path);
	if (!metadata) return check("sessions_db", "warning", "sessions database not created yet");
	if (!metadata.isFile()) return check("sessions_db", "failed", "sessions database is not a file");

	let database: DatabaseSyncType | undefined;
	try {
		const { DatabaseSync } = await import("node:sqlite");
		database = new DatabaseSync(path, { readOnly: true });
		const integrity = database.prepare("PRAGMA quick_check").get();
		if (!integrity || !Object.values(integrity).includes("ok")) {
			return check("sessions_db", "failed", "SQLite integrity check failed");
		}
		const objects = database.prepare(
			"SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
		).all() as readonly Readonly<Record<string, unknown>>[];
		const present = new Map(objects.flatMap((row) => (
			typeof row.name === "string" && typeof row.type === "string"
				? [[row.name, row.type] as const]
				: []
		)));
		const missing = [...REQUIRED_SCHEMA_OBJECTS].flatMap(([name, type]) => (
			present.get(name) === type ? [] : [name]
		));
		if (missing.length > 0) {
			return check(
				"sessions_db",
				"failed",
				`missing_schema_objects=${missing.length}`,
				missing.slice(0, 12).join(","),
			);
		}
		const versions = database.prepare("SELECT version FROM schema_version").all();
		if (versions.length !== 1 || versions[0]?.version !== SCHEMA_VERSION) {
			return check("sessions_db", "failed", `schema_version expected=${SCHEMA_VERSION}`);
		}
		const invalidStates = invalidCriticalStates(database);
		if (invalidStates > 0) {
			return check("sessions_db", "failed", `invalid_recovery_states=${invalidStates}`);
		}
		const invalidLineage = invalidLineageCount(database);
		if (invalidLineage > 0) {
			return check("sessions_db", "failed", `invalid_session_lineage=${invalidLineage}`);
		}
		return check("sessions_db", "ok", `schema_version=${SCHEMA_VERSION} integrity=ok`);
	} catch {
		return check("sessions_db", "failed", "sessions database is not readable");
	} finally {
		database?.close();
	}
}

function invalidCriticalStates(database: DatabaseSyncType): number {
	const placeholders = CRITICAL_STATE_KEYS.map(() => "?").join(",");
	const rows = database.prepare(
		`SELECT state_key, payload_json FROM session_state WHERE state_key IN (${placeholders})`,
	).all(...CRITICAL_STATE_KEYS) as readonly Readonly<Record<string, unknown>>[];
	let invalid = 0;
	for (const row of rows) {
		if (typeof row.payload_json !== "string") {
			invalid += 1;
			continue;
		}
		try {
			const payload: unknown = JSON.parse(row.payload_json);
			if (!isRecord(payload) || !validNestedRecoveryState(row.state_key, payload)) invalid += 1;
		} catch {
			invalid += 1;
		}
	}
	return invalid;
}

function validNestedRecoveryState(
	key: unknown,
	payload: Readonly<Record<string, unknown>>,
): boolean {
	if (key !== "suspended_turn") return true;
	for (const nested of ["pending_decision", "pending_clarification"] as const) {
		if (payload[nested] !== undefined && !isRecord(payload[nested])) return false;
	}
	return payload.user_message === undefined || typeof payload.user_message === "string";
}

function invalidLineageCount(database: DatabaseSyncType): number {
	const row = database.prepare(`
		WITH message_counts AS (
			SELECT session_id, COUNT(*) AS message_count
			FROM conversation_messages
			GROUP BY session_id
		)
		SELECT COUNT(*) AS invalid_count
		FROM conversation_trees AS tree
		LEFT JOIN message_counts AS child ON child.session_id = tree.session_id
		LEFT JOIN message_counts AS parent ON parent.session_id = tree.parent_id
		WHERE tree.fork_point IS NOT NULL
		  AND (
			tree.fork_point < 0
			OR tree.fork_point > COALESCE(child.message_count, 0)
			OR (tree.parent_id IS NOT NULL AND tree.fork_point > COALESCE(parent.message_count, 0))
		  )
	`).get();
	return typeof row?.invalid_count === "number" ? row.invalid_count : Number(row?.invalid_count ?? 0);
}

async function checkDirectory(
	name: string,
	path: string,
	missingStatus: DoctorCheck["status"],
): Promise<DoctorCheck> {
	const metadata = await optionalStat(path);
	if (!metadata) return check(name, missingStatus, `${name} directory not created yet`);
	if (!metadata.isDirectory()) return check(name, "failed", `${name} path is not a directory`);
	return check(name, "ok", `${name} directory readable`);
}

async function checkTraces(path: string): Promise<DoctorCheck> {
	const metadata = await optionalStat(path);
	if (!metadata) return check("traces", "ok", "trace directory not created yet");
	if (!metadata.isDirectory()) return check("traces", "failed", "trace path is not a directory");
	let entries;
	try {
		entries = (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.sort((left, right) => left.name.localeCompare(right.name))
			.slice(0, MAX_TRACE_FILES);
	} catch {
		return check("traces", "failed", "trace directory is not readable");
	}
	let rows = 0;
	let invalid = 0;
	let unreadable = 0;
	for (const entry of entries) {
		const filePath = join(path, entry.name);
		try {
			const fileStats = await stat(filePath);
			if (fileStats.size > MAX_TRACE_FILE_BYTES) {
				invalid += 1;
				continue;
			}
			for (const line of (await readFile(filePath, "utf8")).split(/\r?\n/u)) {
				if (!line) continue;
				rows += 1;
				try {
					const parsed: unknown = JSON.parse(line);
					if (!isRecord(parsed)) invalid += 1;
				} catch {
					invalid += 1;
				}
			}
		} catch {
			unreadable += 1;
		}
	}
	if (unreadable > 0) return check("traces", "failed", `unreadable_files=${unreadable}`);
	return check(
		"traces",
		invalid > 0 ? "warning" : "ok",
		`files=${entries.length} rows=${rows} invalid_rows=${invalid}`,
	);
}

async function checkRedaction(
	homeRoot: string,
	logsRoot: string,
	tracesRoot: string,
): Promise<DoctorCheck> {
	const paths = await diagnosticFiles(logsRoot, tracesRoot);
	if (paths.length === 0) return check("logs_redaction", "ok", "no diagnostic files found");
	const scan = await scanDoctorFiles({ root: homeRoot, paths });
	if (scan.unreadableCount > 0) {
		return check("logs_redaction", "failed", `unreadable_files=${scan.unreadableCount}`);
	}
	return check(
		"logs_redaction",
		scan.findingCount > 0 ? "failed" : "ok",
		`files=${scan.scannedFileCount} findings=${scan.findingCount}`,
	);
}

async function diagnosticFiles(logsRoot: string, tracesRoot: string): Promise<readonly string[]> {
	const paths: string[] = [];
	for (const name of ["agent.log", "errors.log", "model-events.jsonl"] as const) {
		if (await optionalStat(join(logsRoot, name))) paths.push(join(logsRoot, name));
	}
	for (const [root, suffix] of [[tracesRoot, ".jsonl"], [join(logsRoot, "model-raw"), ".json"]] as const) {
		try {
			const entries = await readdir(root, { recursive: true, withFileTypes: true });
			for (const entry of entries) {
				if (paths.length >= MAX_TRACE_FILES) break;
				if (entry.isFile() && entry.name.endsWith(suffix)) paths.push(join(entry.parentPath, entry.name));
			}
		} catch {
			// Missing diagnostic directories are healthy and created lazily.
		}
	}
	return Object.freeze(paths);
}

async function optionalStat(path: string) {
	try {
		return await stat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

function check(
	name: string,
	status: DoctorCheck["status"],
	message: string,
	detail?: string,
): DoctorCheck {
	return Object.freeze({ name, status, message, ...(detail ? { detail } : {}) });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

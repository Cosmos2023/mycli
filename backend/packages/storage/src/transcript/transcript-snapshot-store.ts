import { randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	readFile,
	rename,
	rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	SessionArtifactPaths,
	subagentRunId,
	validateStorageIdentity,
} from "../artifacts/session-artifact-paths.ts";
import {
	sanitizeTranscriptItem,
	type TranscriptItem,
} from "../projections/transcript-projector.ts";
import {
	parseSnapshotCoverage,
	parseSnapshotRequestSummary,
	parseSnapshotSessionMetadata,
	type TranscriptSnapshotCoverage,
	type TranscriptSnapshotRequestSummary,
	type TranscriptSnapshotSessionMetadata,
} from "./transcript-snapshot-metadata.ts";

export type TranscriptSessionState =
	| "idle"
	| "running"
	| "waiting_approval"
	| "waiting_clarification"
	| "interrupted";

export interface TranscriptSnapshotV2 {
	readonly schema_version: 2;
	readonly session_id: string;
	readonly cwd: string;
	readonly state: TranscriptSessionState;
	readonly message_count: number;
	readonly created_at: string;
	readonly updated_at: string;
	readonly session?: TranscriptSnapshotSessionMetadata;
	readonly last_request?: TranscriptSnapshotRequestSummary;
	readonly coverage?: TranscriptSnapshotCoverage;
	readonly transcript: readonly TranscriptItem[];
	readonly subagents?: readonly TranscriptSubagentIndexEntry[];
	readonly links?: Readonly<{ readonly events: "events.jsonl" }>;
}

export interface TranscriptSubagentIndexEntry {
	readonly run_id: string;
	readonly child_session_id: string;
	readonly parent_turn_id: string;
	readonly role: string;
	readonly thread_id?: string;
	readonly root_thread_id?: string;
	readonly parent_thread_id?: string;
	readonly agent_path?: string;
	readonly task_name?: string;
	readonly nickname?: string;
	readonly lifecycle_kind?: string;
	readonly description?: string;
	readonly status: "queued" | "running" | "completed" | "failed" | "interrupted";
	readonly mode?: "foreground" | "background";
	readonly summary: string;
	readonly tool_calls: number;
	readonly error?: string;
	readonly started_at?: string;
	readonly completed_at?: string;
	readonly path: string;
}

export interface LegacySnapshotMessage extends Readonly<Record<string, unknown>> {
	readonly role: string;
	readonly content: string;
}

export interface TranscriptSnapshotProject {
	loadCanonical(sessionId: string): TranscriptSnapshotV2 | undefined | Promise<TranscriptSnapshotV2 | undefined>;
	importLegacy(
		sessionId: string,
		messages: readonly LegacySnapshotMessage[],
	): TranscriptSnapshotV2 | Promise<TranscriptSnapshotV2>;
}

export interface TranscriptSnapshotLoadResult {
	readonly source: "snapshot" | "sqlite_rebuild" | "legacy_import" | "snapshot_read_only";
	readonly snapshot: TranscriptSnapshotV2;
	readonly readOnly: boolean;
	readonly errorCode?: "session_storage_unavailable" | "session_canonical_missing";
}

export interface TranscriptSnapshotOperations {
	rename(source: string, target: string): Promise<void>;
}

export interface TranscriptSnapshotStoreOptions {
	readonly homeDir: string;
	readonly operations?: Partial<TranscriptSnapshotOperations>;
	readonly failpoint?: (name: TranscriptSnapshotFailpoint) => void;
}

export type TranscriptSnapshotFailpoint = "snapshot_before_write" | "snapshot_before_rename";

interface LegacySnapshotV1 {
	readonly sessionId: string;
	readonly messages: readonly LegacySnapshotMessage[];
}

type SnapshotFile =
	| { readonly kind: "missing" | "invalid" }
	| { readonly kind: "v1"; readonly snapshot: LegacySnapshotV1 }
	| { readonly kind: "v2"; readonly snapshot: TranscriptSnapshotV2 };

export class TranscriptSnapshotStore {
	readonly #paths: SessionArtifactPaths;
	readonly #operations: TranscriptSnapshotOperations;
	readonly #failpoint: (name: TranscriptSnapshotFailpoint) => void;

	constructor(options: TranscriptSnapshotStoreOptions) {
		this.#paths = new SessionArtifactPaths(options.homeDir);
		this.#operations = {
			rename: options.operations?.rename ?? rename,
		};
		this.#failpoint = options.failpoint ?? (() => undefined);
	}

	sessionDirectory(sessionId: string): string {
		try {
			return this.#paths.sessionDirectory(sessionId);
		} catch {
			throw new SnapshotStateError("invalid storage session id");
		}
	}

	snapshotPath(sessionId: string): string {
		return join(this.sessionDirectory(sessionId), "session.json");
	}

	async ensureSessionDirectory(sessionId: string): Promise<void> {
		await mkdir(this.sessionDirectory(sessionId), { recursive: true });
	}

	async write(snapshot: TranscriptSnapshotV2): Promise<void> {
		const validated = parseSnapshotV2(snapshot, snapshot.session_id);
		if (!validated) throw new SnapshotStateError("invalid transcript snapshot");
		await this.ensureSessionDirectory(validated.session_id);
		const target = this.snapshotPath(validated.session_id);
		const temporary = join(
			dirname(target),
			`.${basename(target)}.${randomUUID()}.tmp`,
		);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporary, "wx", 0o600);
			this.#failpoint("snapshot_before_write");
			await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			this.#failpoint("snapshot_before_rename");
			await this.#operations.rename(temporary, target);
		} finally {
			await handle?.close().catch(() => undefined);
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	async loadOrRebuild(
		sessionId: string,
		project: TranscriptSnapshotProject,
	): Promise<TranscriptSnapshotLoadResult> {
		const normalizedSessionId = validSessionId(sessionId);
		const file = await this.#read(normalizedSessionId);
		let canonical: TranscriptSnapshotV2 | undefined;
		try {
			canonical = await project.loadCanonical(normalizedSessionId);
		} catch (error) {
			if (file.kind === "v2") {
				return freezeResult({
					source: "snapshot_read_only",
					snapshot: file.snapshot,
					readOnly: true,
					errorCode: "session_storage_unavailable",
				});
			}
			throw error;
		}

		if (canonical !== undefined) {
			const validated = parseSnapshotV2(canonical, normalizedSessionId);
			if (!validated) throw new SnapshotStateError("invalid canonical transcript projection");
			if (file.kind === "v2") {
				if (JSON.stringify(file.snapshot) !== JSON.stringify(validated)) {
					await this.write(validated);
				}
				return freezeResult({ source: "snapshot", snapshot: validated, readOnly: false });
			}
			await this.write(validated);
			return freezeResult({ source: "sqlite_rebuild", snapshot: validated, readOnly: false });
		}

		if (file.kind === "v1") {
			const imported = await project.importLegacy(normalizedSessionId, file.snapshot.messages);
			const validated = parseSnapshotV2(imported, normalizedSessionId);
			if (!validated) throw new SnapshotStateError("invalid imported transcript projection");
			await this.write(validated);
			return freezeResult({ source: "legacy_import", snapshot: validated, readOnly: false });
		}
		if (file.kind === "v2") {
			return freezeResult({
				source: "snapshot_read_only",
				snapshot: file.snapshot,
				readOnly: true,
				errorCode: "session_canonical_missing",
			});
		}
		throw new SnapshotStateError("session transcript is unavailable");
	}

	async #read(sessionId: string): Promise<SnapshotFile> {
		let bytes: Buffer;
		try {
			bytes = await readFile(this.snapshotPath(sessionId));
		} catch (error) {
			if (isMissingFile(error)) return { kind: "missing" };
			return { kind: "invalid" };
		}
		let payload: unknown;
		try {
			const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			payload = JSON.parse(source) as unknown;
		} catch {
			return { kind: "invalid" };
		}
		const v2 = parseSnapshotV2(payload, sessionId);
		if (v2) return { kind: "v2", snapshot: v2 };
		const v1 = parseLegacySnapshot(payload, sessionId);
		return v1 ? { kind: "v1", snapshot: v1 } : { kind: "invalid" };
	}
}

export class SnapshotStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SnapshotStateError";
	}
}

function parseSnapshotV2(value: unknown, sessionId: string): TranscriptSnapshotV2 | undefined {
	if (!isRecord(value)
		|| value.schema_version !== 2
		|| value.session_id !== sessionId
		|| typeof value.cwd !== "string"
		|| !isTranscriptState(value.state)
		|| !Number.isSafeInteger(value.message_count)
		|| (value.message_count as number) < 0
		|| typeof value.created_at !== "string"
		|| typeof value.updated_at !== "string"
		|| !Array.isArray(value.transcript)) {
		return undefined;
	}
	const transcript: TranscriptItem[] = [];
	for (const rawItem of value.transcript) {
		const item = parseTranscriptItem(rawItem);
		if (!item) return undefined;
		transcript.push(item);
	}
	const subagents = value.subagents === undefined
		? undefined
		: parseSubagentIndex(value.subagents);
	if (value.subagents !== undefined && !subagents) return undefined;
	const links = value.links === undefined ? undefined : parseLinks(value.links);
	if (value.links !== undefined && !links) return undefined;
	const session = value.session === undefined ? undefined : parseSnapshotSessionMetadata(value.session);
	if (value.session !== undefined && !session) return undefined;
	const lastRequest = value.last_request === undefined ? undefined : parseSnapshotRequestSummary(value.last_request);
	if (value.last_request !== undefined && !lastRequest) return undefined;
	const coverage = value.coverage === undefined ? undefined : parseSnapshotCoverage(value.coverage, transcript);
	if (value.coverage !== undefined && !coverage) return undefined;
	return Object.freeze({
		schema_version: 2,
		session_id: sessionId,
		cwd: value.cwd,
		state: value.state,
		message_count: value.message_count as number,
		created_at: value.created_at,
		updated_at: value.updated_at,
		...(session ? { session } : {}),
		...(lastRequest ? { last_request: lastRequest } : {}),
		...(coverage ? { coverage } : {}),
		transcript: Object.freeze(transcript),
		...(subagents ? { subagents } : {}),
		...(links ? { links } : {}),
	});
}

function parseSubagentIndex(value: unknown): readonly TranscriptSubagentIndexEntry[] | undefined {
	if (!Array.isArray(value) || value.length > 1_000) return undefined;
	const entries: TranscriptSubagentIndexEntry[] = [];
	for (const raw of value) {
		if (!isRecord(raw)
			|| !boundedString(raw.run_id, 128)
			|| !boundedString(raw.child_session_id, 256)
			|| !boundedString(raw.parent_turn_id, 256)
			|| !boundedString(raw.role, 64)
			|| !boundedString(raw.thread_id ?? raw.child_session_id, 256)
			|| !isSubagentStatus(raw.status)
			|| !boundedString(raw.summary, 160, true)
			|| !Number.isSafeInteger(raw.tool_calls)
			|| (raw.tool_calls as number) < 0
			|| raw.path !== `subagents/${raw.run_id}.json`
			|| (raw.description !== undefined && !boundedString(raw.description, 2_048, true))
			|| (raw.root_thread_id !== undefined && !boundedString(raw.root_thread_id, 256))
			|| (raw.parent_thread_id !== undefined && !boundedString(raw.parent_thread_id, 256))
			|| (raw.agent_path !== undefined && !boundedString(raw.agent_path, 512))
			|| (raw.task_name !== undefined && !boundedString(raw.task_name, 64))
			|| (raw.nickname !== undefined && !boundedString(raw.nickname, 64))
			|| (raw.lifecycle_kind !== undefined && !boundedString(raw.lifecycle_kind, 64))
			|| (raw.mode !== undefined && raw.mode !== "foreground" && raw.mode !== "background")
			|| (raw.error !== undefined && !boundedString(raw.error, 4_096, true))
			|| (raw.started_at !== undefined && !boundedString(raw.started_at, 64))
			|| (raw.completed_at !== undefined && !boundedString(raw.completed_at, 64))) {
			return undefined;
		}
		try {
			validateStorageIdentity(raw.child_session_id, "child session id");
			if (raw.run_id !== subagentRunId(raw.child_session_id)) return undefined;
		} catch {
			return undefined;
		}
		entries.push(Object.freeze({
			run_id: raw.run_id,
			child_session_id: raw.child_session_id,
				parent_turn_id: raw.parent_turn_id,
				role: raw.role,
				thread_id: (raw.thread_id ?? raw.child_session_id) as string,
				...(raw.root_thread_id === undefined ? {} : { root_thread_id: raw.root_thread_id }),
				...(raw.parent_thread_id === undefined ? {} : { parent_thread_id: raw.parent_thread_id }),
				...(raw.agent_path === undefined ? {} : { agent_path: raw.agent_path }),
				...(raw.task_name === undefined ? {} : { task_name: raw.task_name }),
				...(raw.nickname === undefined ? {} : { nickname: raw.nickname }),
				...(raw.lifecycle_kind === undefined ? {} : { lifecycle_kind: raw.lifecycle_kind }),
			...(raw.description === undefined ? {} : { description: raw.description }),
			status: raw.status,
			...(raw.mode === undefined ? {} : { mode: raw.mode }),
			summary: raw.summary,
			tool_calls: raw.tool_calls as number,
			...(raw.error === undefined ? {} : { error: raw.error }),
			...(raw.started_at === undefined ? {} : { started_at: raw.started_at }),
			...(raw.completed_at === undefined ? {} : { completed_at: raw.completed_at }),
			path: raw.path,
		}));
	}
	return Object.freeze(entries);
}

function parseLinks(value: unknown): Readonly<{ readonly events: "events.jsonl" }> | undefined {
	return isRecord(value) && Object.keys(value).length === 1 && value.events === "events.jsonl"
		? Object.freeze({ events: "events.jsonl" as const })
		: undefined;
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
	return typeof value === "string"
		&& value.length <= maximum
		&& !value.includes("\0")
		&& (allowEmpty || value.length > 0);
}

function isSubagentStatus(value: unknown): value is TranscriptSubagentIndexEntry["status"] {
	return value === "queued" || value === "running" || value === "completed"
		|| value === "failed" || value === "interrupted";
}

function parseLegacySnapshot(value: unknown, sessionId: string): LegacySnapshotV1 | undefined {
	if (!isRecord(value)
		|| value.schema_version !== 1
		|| value.session_id !== sessionId
		|| !Array.isArray(value.messages)) {
		return undefined;
	}
	const messages: LegacySnapshotMessage[] = [];
	for (const raw of value.messages) {
		if (!isRecord(raw) || typeof raw.role !== "string" || typeof raw.content !== "string") {
			return undefined;
		}
		messages.push(Object.freeze({ ...raw, role: raw.role, content: raw.content }));
	}
	return Object.freeze({ sessionId, messages: Object.freeze(messages) });
}

function parseTranscriptItem(value: unknown): TranscriptItem | undefined {
	return sanitizeTranscriptItem(value);
}

function freezeResult(result: TranscriptSnapshotLoadResult): TranscriptSnapshotLoadResult {
	return Object.freeze(result);
}

function validSessionId(value: string): string {
	try {
		return validateStorageIdentity(value, "storage session id");
	} catch {
		throw new SnapshotStateError("invalid storage session id");
	}
}

function isTranscriptState(value: unknown): value is TranscriptSessionState {
	return value === "idle" || value === "running"
		|| value === "waiting_approval" || value === "waiting_clarification"
		|| value === "interrupted";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

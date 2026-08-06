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
	sanitizeTranscriptItem,
	type TranscriptItem,
} from "./transcript-projector.ts";

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
	readonly transcript: readonly TranscriptItem[];
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
	readonly #sessionsRoot: string;
	readonly #operations: TranscriptSnapshotOperations;
	readonly #failpoint: (name: TranscriptSnapshotFailpoint) => void;

	constructor(options: TranscriptSnapshotStoreOptions) {
		this.#sessionsRoot = join(options.homeDir, ".mycli", "sessions");
		this.#operations = {
			rename: options.operations?.rename ?? rename,
		};
		this.#failpoint = options.failpoint ?? (() => undefined);
	}

	sessionDirectory(sessionId: string): string {
		return join(this.#sessionsRoot, validSessionId(sessionId));
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
				return freezeResult({ source: "snapshot", snapshot: file.snapshot, readOnly: false });
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
	return Object.freeze({
		schema_version: 2,
		session_id: sessionId,
		cwd: value.cwd,
		state: value.state,
		message_count: value.message_count as number,
		created_at: value.created_at,
		updated_at: value.updated_at,
		transcript: Object.freeze(transcript),
	});
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
	if (!value || value.startsWith("<") || value.endsWith(">")
		|| value.includes("/") || value.includes("\\") || value.includes("..")) {
		throw new SnapshotStateError("invalid storage session id");
	}
	return value;
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

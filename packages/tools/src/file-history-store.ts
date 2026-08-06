import { createHash, randomUUID } from "node:crypto";
import {
	appendFile,
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { resolveWritableWorkspaceFile } from "./path-policy.ts";

const MAX_FILE_BYTES = 1_000_000;
const SENSITIVE_PATH_PARTS = new Set([
	".env",
	".mycli",
	".ssh",
	".gnupg",
	".aws",
	".kube",
	"id_rsa",
	"id_ed25519",
]);

interface BeforeEvent {
	readonly version: 1;
	readonly action: "before";
	readonly snapshot_id: string;
	readonly turn_id: string;
	readonly tool_name: string;
	readonly path: string;
	readonly existed: boolean;
	readonly object_name?: string;
	readonly mode?: number;
}

interface AfterEvent {
	readonly version: 1;
	readonly action: "after";
	readonly snapshot_id: string;
	readonly existed: boolean;
	readonly sha256?: string;
	readonly size?: number;
}

interface TerminalEvent {
	readonly version: 1;
	readonly action: "discard" | "undo";
	readonly snapshot_id: string;
}

type HistoryEvent = BeforeEvent | AfterEvent | TerminalEvent;

export interface FileHistoryCapture {
	readonly snapshotId: string;
}

export interface FileHistoryUndoResult {
	readonly snapshotId?: string;
	readonly restoredPaths: readonly string[];
	readonly deletedPaths: readonly string[];
	readonly error?: string;
}

export interface FileHistoryStoreOptions {
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly maxFileBytes?: number;
}

export class FileHistoryStore {
	readonly #homeDir: string;
	readonly #workspaceRoot: string;
	readonly #maxFileBytes: number;

	constructor(options: FileHistoryStoreOptions) {
		this.#homeDir = options.homeDir;
		this.#workspaceRoot = options.workspaceRoot;
		this.#maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
	}

	async capture(input: {
		readonly sessionId: string;
		readonly turnId: string;
		readonly toolName: string;
		readonly path: string;
	}): Promise<FileHistoryCapture | undefined> {
		const resolved = await resolveWritableWorkspaceFile(this.#workspaceRoot, input.path);
		if (sensitivePath(resolved.relativePath)) return undefined;
		let bytes: Buffer | undefined;
		let mode: number | undefined;
		if (resolved.existed) {
			const metadata = await stat(resolved.target);
			if (!metadata.isFile() || metadata.size > this.#maxFileBytes) return undefined;
			bytes = await readFile(resolved.target);
			mode = metadata.mode & 0o777;
		}

		const sessionKey = sessionDigest(input.sessionId);
		const snapshotId = `${sessionKey}-${randomUUID().replaceAll("-", "")}`;
		const root = this.#historyRoot(sessionKey);
		const objectName = bytes ? `${snapshotId}.before` : undefined;
		await mkdir(this.#objectsRoot(sessionKey), { recursive: true });
		if (bytes && objectName) {
			await writeFile(join(this.#objectsRoot(sessionKey), objectName), bytes, {
				flag: "wx",
				mode: 0o600,
			});
		}
		await appendHistoryEvent(join(root, "manifest.jsonl"), {
			version: 1,
			action: "before",
			snapshot_id: snapshotId,
			turn_id: input.turnId.slice(0, 256),
			tool_name: input.toolName.slice(0, 128),
			path: resolved.relativePath,
			existed: resolved.existed,
			...(objectName ? { object_name: objectName } : {}),
			...(mode === undefined ? {} : { mode }),
		});
		return Object.freeze({ snapshotId });
	}

	async complete(snapshotId: string): Promise<void> {
		const sessionKey = snapshotSessionKey(snapshotId);
		const before = latestBefore(await this.#events(sessionKey), snapshotId);
		if (!before) throw new Error("file_history_snapshot_not_found");
		const resolved = await resolveWritableWorkspaceFile(this.#workspaceRoot, before.path);
		const current = await currentFileState(resolved.target, this.#maxFileBytes);
		await appendHistoryEvent(this.#manifestPath(sessionKey), {
			version: 1,
			action: "after",
			snapshot_id: snapshotId,
			existed: current.existed,
			...(current.sha256 ? { sha256: current.sha256, size: current.size } : {}),
		});
	}

	async discard(snapshotId: string): Promise<void> {
		const sessionKey = snapshotSessionKey(snapshotId);
		await appendHistoryEvent(this.#manifestPath(sessionKey), {
			version: 1,
			action: "discard",
			snapshot_id: snapshotId,
		});
	}

	async undoLatest(input: { readonly sessionId: string }): Promise<FileHistoryUndoResult> {
		const sessionKey = sessionDigest(input.sessionId);
		const events = await this.#events(sessionKey);
		const candidate = latestRecoverable(events);
		if (!candidate) return emptyUndo("No file history snapshots.");
		const resolved = await resolveWritableWorkspaceFile(this.#workspaceRoot, candidate.before.path);
		const current = await currentFileState(resolved.target, this.#maxFileBytes);
		if (!sameFileState(current, candidate.after)) {
			return emptyUndo(`Cannot rewind ${candidate.before.path}: changed after snapshot.`, candidate.before.snapshot_id);
		}

		const restoredPaths: string[] = [];
		const deletedPaths: string[] = [];
		if (candidate.before.existed && candidate.before.object_name) {
			const objectName = safeObjectName(candidate.before.object_name);
			const bytes = await readFile(join(this.#objectsRoot(sessionKey), objectName));
			await mkdir(dirname(resolved.target), { recursive: true });
			const temporary = join(dirname(resolved.target), `.${basename(resolved.target)}.${randomUUID()}.undo`);
			try {
				await writeFile(temporary, bytes, { flag: "wx", mode: candidate.before.mode ?? 0o600 });
				if (candidate.before.mode !== undefined) await chmod(temporary, candidate.before.mode);
				await rename(temporary, resolved.target);
			} finally {
				await rm(temporary, { force: true }).catch(() => undefined);
			}
			restoredPaths.push(candidate.before.path);
		} else if (!candidate.before.existed && current.existed) {
			await rm(resolved.target, { force: true });
			deletedPaths.push(candidate.before.path);
		}
		await appendHistoryEvent(this.#manifestPath(sessionKey), {
			version: 1,
			action: "undo",
			snapshot_id: candidate.before.snapshot_id,
		});
		return Object.freeze({
			snapshotId: candidate.before.snapshot_id,
			restoredPaths: Object.freeze(restoredPaths),
			deletedPaths: Object.freeze(deletedPaths),
		});
	}

	#historyRoot(sessionKey: string): string {
		return join(this.#homeDir, ".mycli", "file-history", sessionKey);
	}

	#objectsRoot(sessionKey: string): string {
		return join(this.#historyRoot(sessionKey), "objects");
	}

	#manifestPath(sessionKey: string): string {
		return join(this.#historyRoot(sessionKey), "manifest.jsonl");
	}

	async #events(sessionKey: string): Promise<readonly HistoryEvent[]> {
		let content: string;
		try {
			content = await readFile(this.#manifestPath(sessionKey), "utf8");
		} catch (error) {
			if (hasCode(error, "ENOENT")) return [];
			throw error;
		}
		return content.split("\n").filter(Boolean).flatMap((line): HistoryEvent[] => {
			try {
				const value = JSON.parse(line) as unknown;
				return isHistoryEvent(value) ? [value] : [];
			} catch {
				return [];
			}
		});
	}
}

async function appendHistoryEvent(path: string, event: HistoryEvent): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

function sessionDigest(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

function snapshotSessionKey(snapshotId: string): string {
	const key = snapshotId.slice(0, 32);
	if (!/^[a-f0-9]{32}$/u.test(key) || snapshotId[32] !== "-") {
		throw new Error("invalid_file_history_snapshot_id");
	}
	return key;
}

function sensitivePath(path: string): boolean {
	return path.toLocaleLowerCase().split("/").some((part) => SENSITIVE_PATH_PARTS.has(part));
}

function safeObjectName(value: string): string {
	if (!/^[a-f0-9]{32}-[a-f0-9]{32}\.before$/u.test(value)) {
		throw new Error("invalid_file_history_object");
	}
	return value;
}

async function currentFileState(target: string, maxBytes: number): Promise<{
	readonly existed: boolean;
	readonly sha256?: string;
	readonly size?: number;
}> {
	try {
		const metadata = await stat(target);
		if (!metadata.isFile() || metadata.size > maxBytes) return { existed: true };
		const bytes = await readFile(target);
		return {
			existed: true,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			size: bytes.length,
		};
	} catch (error) {
		if (hasCode(error, "ENOENT")) return { existed: false };
		throw error;
	}
}

function sameFileState(
	current: { readonly existed: boolean; readonly sha256?: string; readonly size?: number },
	after: AfterEvent,
): boolean {
	return current.existed === after.existed
		&& (!current.existed || (current.sha256 === after.sha256 && current.size === after.size));
}

function latestBefore(events: readonly HistoryEvent[], snapshotId: string): BeforeEvent | undefined {
	return events.findLast((event): event is BeforeEvent =>
		event.action === "before" && event.snapshot_id === snapshotId);
}

function latestRecoverable(events: readonly HistoryEvent[]): {
	readonly before: BeforeEvent;
	readonly after: AfterEvent;
} | undefined {
	const terminal = new Set(events.filter((event) => event.action === "discard" || event.action === "undo")
		.map((event) => event.snapshot_id));
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index]!;
		if (event.action !== "before" || terminal.has(event.snapshot_id)) continue;
		const after = events.findLast((candidate): candidate is AfterEvent =>
			candidate.action === "after" && candidate.snapshot_id === event.snapshot_id);
		if (after) return { before: event, after };
	}
	return undefined;
}

function emptyUndo(error: string, snapshotId?: string): FileHistoryUndoResult {
	return Object.freeze({
		...(snapshotId ? { snapshotId } : {}),
		restoredPaths: Object.freeze([]),
		deletedPaths: Object.freeze([]),
		error,
	});
}

function isHistoryEvent(value: unknown): value is HistoryEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const event = value as Partial<HistoryEvent>;
	return event.version === 1
		&& typeof event.snapshot_id === "string"
		&& (event.action === "before" || event.action === "after"
			|| event.action === "discard" || event.action === "undo");
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

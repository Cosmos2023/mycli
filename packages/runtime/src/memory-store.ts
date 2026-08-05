import { randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { compareUnicodeCodePoints } from "./memory-ordering.ts";
import { deterministicMemorySelection } from "./memory-selector.ts";

const ENTRYPOINT_NAME = "MEMORY.md";
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;
const MAX_MEMORY_FILES = 200;
const MAX_FORGET_MEMORIES = 5;
const FRONTMATTER_MAX_LINES = 30;
const MEMORY_LOCK_NAME = ".memory.lock";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const PROJECT_KEY_PATTERN = /[^a-zA-Z0-9_.-]+/gu;
const VALID_MEMORY_KINDS = new Set<FileMemoryKind>([
	"user",
	"feedback",
	"project",
	"reference",
]);

export type FileMemoryKind = "user" | "feedback" | "project" | "reference";

export interface FileMemory {
	readonly filename: string;
	readonly mtime: number;
	readonly kind?: FileMemoryKind;
	readonly name: string;
	readonly description: string;
	readonly content: string;
}

export type ForgetMemoryResult = FileMemory;

export interface EntrypointContent {
	readonly content: string;
	readonly lineCount: number;
	readonly byteCount: number;
	readonly wasLineTruncated: boolean;
	readonly wasByteTruncated: boolean;
}

export interface RememberMemoryInput {
	readonly kind: FileMemoryKind;
	readonly name: string;
	readonly description: string;
	readonly content: string;
}

export interface MemoryAtomicFileHandle {
	writeFile(content: string): Promise<void>;
	sync(): Promise<void>;
	stat(): Promise<{
		readonly dev: number | bigint;
		readonly ino: number | bigint;
		readonly mtimeMs: number;
	}>;
	close(): Promise<void>;
}

export interface MemoryAtomicOperations {
	open(path: string, flags: string, mode?: number): Promise<MemoryAtomicFileHandle>;
	rename(source: string, target: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

export interface MemoryStoreOptions {
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly atomicOperations?: MemoryAtomicOperations;
	readonly lockTimeoutMs?: number;
	readonly lockStaleMs?: number;
	readonly lockRetryDelayMs?: number;
}

export type MemoryStoreErrorKind =
	| "memory_invalid_input"
	| "memory_invalid_utf8"
	| "memory_path_escape"
	| "memory_read_failed"
	| "memory_write_failed";

type DiagnosticValue = string | number | boolean | null;

interface FileIdentity {
	readonly dev: number | bigint;
	readonly ino: number | bigint;
}

interface OwnedFile {
	readonly path: string;
	readonly identity: FileIdentity;
	readonly mtimeMs: number;
}

interface OwnedMemoryLock extends OwnedFile {
	readonly ownerId: string;
}

interface MemoryLockPayload {
	readonly version: 1;
	readonly owner_id: string;
	readonly pid: number;
	readonly created_at_ms: number;
}

export class MemoryStoreError extends Error {
	readonly diagnostics: Readonly<Record<string, DiagnosticValue>>;

	constructor(
		readonly kind: MemoryStoreErrorKind,
		diagnostics: Readonly<Record<string, DiagnosticValue>> = {},
	) {
		super(kind);
		this.name = "MemoryStoreError";
		this.diagnostics = Object.freeze({ ...diagnostics });
	}
}

export class MemoryStore {
	readonly #homeDir: string;
	readonly #workspaceRoot: string;
	readonly #atomicOperations: MemoryAtomicOperations;
	readonly #lockTimeoutMs: number;
	readonly #lockStaleMs: number;
	readonly #lockRetryDelayMs: number;
	#mutationTail: Promise<void> = Promise.resolve();
	#directoryPromise: Promise<string> | undefined;
	#realDirectoryPromise: Promise<string> | undefined;

	constructor(options: MemoryStoreOptions) {
		this.#homeDir = options.homeDir;
		this.#workspaceRoot = options.workspaceRoot;
		this.#atomicOperations = options.atomicOperations ?? {
			open,
			rename,
			unlink,
		};
		this.#lockTimeoutMs = nonNegativeDuration(
			options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
			"lockTimeoutMs",
		);
		this.#lockStaleMs = positiveDuration(
			options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
			"lockStaleMs",
		);
		this.#lockRetryDelayMs = positiveDuration(
			options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
			"lockRetryDelayMs",
		);
	}

	directory(): Promise<string> {
		this.#directoryPromise ??= this.#prepareDirectory();
		return this.#directoryPromise;
	}

	async loadEntrypoint(): Promise<EntrypointContent> {
		const raw = await this.#readEntrypoint();
		if (raw === undefined) return emptyEntrypoint();
		return truncateEntrypoint(raw);
	}

	async scan(): Promise<readonly FileMemory[]> {
		const memoryDir = await this.directory();
		const paths = await this.#topicPaths(memoryDir);
		const candidates: { readonly path: string; readonly filename: string; readonly mtime: number }[] = [];
		for (const path of paths) {
			const filename = relative(memoryDir, path).split(sep).join("/");
			await this.#assertContained(path, filename);
			try {
				const metadata = await stat(path);
				if (metadata.isFile()) candidates.push({ path, filename, mtime: metadata.mtimeMs });
			} catch (error) {
				throw normalizeReadError(error, filename);
			}
		}
		candidates.sort((left, right) => (
			right.mtime - left.mtime
			|| compareUnicodeCodePoints(left.filename, right.filename)
		));

		const memories: FileMemory[] = [];
		for (const candidate of candidates.slice(0, MAX_MEMORY_FILES)) {
			let raw: string;
			try {
				raw = await readStrictUtf8(candidate.path, candidate.filename);
			} catch (error) {
				throw normalizeReadError(error, candidate.filename);
			}
			const header = parseFrontmatter(raw.split(/\r\n|\n|\r/u).slice(0, FRONTMATTER_MAX_LINES));
			const kind = memoryKind(header.type);
			const stem = basename(candidate.filename, ".md");
			memories.push(Object.freeze({
				filename: candidate.filename,
				mtime: candidate.mtime,
				...(kind ? { kind } : {}),
				name: header.name?.trim() || stem,
				description: header.description?.trim() ?? "",
				content: stripFrontmatter(raw).trim(),
			}));
		}
		return Object.freeze(memories);
	}

	async remember(input: RememberMemoryInput): Promise<FileMemory> {
		const normalized = validateRememberInput(input);
		return this.#enqueueMutation(() => this.#withDirectoryLock(
			() => this.#remember(normalized),
		));
	}

	async #remember(normalized: RememberMemoryInput): Promise<FileMemory> {
		const memoryDir = await this.directory();
		const reserved = await this.#reserveUniqueTopic(memoryDir, normalized.name);
		const { filename, path: topicPath } = reserved;
		let ownedTopic: OwnedFile = reserved;
		const rendered = [
			"---",
			`name: ${frontmatterScalar(normalized.name)}`,
			`description: ${frontmatterScalar(normalized.description)}`,
			`type: ${normalized.kind}`,
			"---",
			"",
			normalized.content,
			"",
		].join("\n");
		try {
			ownedTopic = await this.#atomicWrite(topicPath, rendered);
			const existing = await this.#rawEntrypoint();
			const lines = existing.split(/\r\n|\n|\r/u).filter(
				(line) => line.trim() && !line.includes(`](${filename})`),
			);
			const title = markdownScalar(normalized.name) || filename;
			const hook = markdownScalar(normalized.description || normalized.name);
			lines.push(`- [${title}](${filename}) - ${hook}`);
			await this.#atomicWrite(join(memoryDir, ENTRYPOINT_NAME), `${lines.join("\n")}\n`);
		} catch (error) {
			await this.#unlinkOwnedFile(ownedTopic);
			if (error instanceof MemoryStoreError) throw error;
			throw new MemoryStoreError("memory_write_failed", { operation: "remember" });
		}
		return Object.freeze({
			filename,
			mtime: ownedTopic.mtimeMs,
			kind: normalized.kind,
			name: normalized.name,
			description: normalized.description,
			content: normalized.content,
		});
	}

	async forget(query: string): Promise<readonly ForgetMemoryResult[]> {
		const needle = query.trim();
		if (!needle) return [];
		return this.#enqueueMutation(() => this.#withDirectoryLock(
			() => this.#forget(needle),
		));
	}

	async #forget(needle: string): Promise<readonly ForgetMemoryResult[]> {
		const memories = await this.scan();
		const exact = memories.filter((memory) => (
			memory.filename === needle
			|| memory.name === needle
			|| basename(memory.filename) === needle
		));
		const selected = exact.length > 0
			? exact
			: deterministicMemorySelection(needle, memories, MAX_FORGET_MEMORIES);
		if (selected.length === 0) return [];
		const memoryDir = await this.directory();
		const existing = await this.#rawEntrypoint();
		const removed: FileMemory[] = [];
		for (const memory of selected) {
			const path = join(memoryDir, ...memory.filename.split("/"));
			await this.#assertContained(path, memory.filename);
			const owned = await this.#ownedPath(path);
			if (owned && await this.#unlinkOwnedFile(owned)) removed.push(memory);
		}
		if (removed.length > 0) {
			const removedNames = new Set(removed.map((memory) => memory.filename));
			const kept = existing.split(/\r\n|\n|\r/u).filter(
				(line) => ![...removedNames].some((filename) => line.includes(`](${filename})`)),
			);
			try {
				await this.#atomicWrite(
					join(memoryDir, ENTRYPOINT_NAME),
					kept.length > 0 ? `${kept.join("\n").trim()}\n` : "",
				);
			} catch {
				throw new MemoryStoreError("memory_write_failed", { operation: "forget_index" });
			}
		}
		return Object.freeze(removed);
	}

	async #prepareDirectory(): Promise<string> {
		let resolvedWorkspace: string;
		try {
			resolvedWorkspace = await realpath(this.#workspaceRoot);
		} catch {
			throw new MemoryStoreError("memory_read_failed", { operation: "resolve_workspace" });
		}
		const stripped = resolvedWorkspace.replace(/^\/+|\/+$/gu, "");
		const key = stripped.replace(PROJECT_KEY_PATTERN, "-").replace(/^-+|-+$/gu, "") || "default";
		const memoryDir = join(this.#homeDir, ".mycli", "projects", key, "memory");
		try {
			await mkdir(memoryDir, { recursive: true, mode: 0o700 });
			this.#realDirectoryPromise = realpath(memoryDir);
			await this.#realDirectoryPromise;
			return memoryDir;
		} catch {
			throw new MemoryStoreError("memory_write_failed", { operation: "prepare_directory" });
		}
	}

	async #topicPaths(directory: string): Promise<readonly string[]> {
		const paths: string[] = [];
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			throw normalizeReadError(error, "memory_root");
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				paths.push(...await this.#topicPaths(path));
				continue;
			}
			if ((entry.isFile() || entry.isSymbolicLink())
				&& entry.name.endsWith(".md")
				&& entry.name !== ENTRYPOINT_NAME) {
				paths.push(path);
			}
		}
		return paths;
	}

	async #assertContained(path: string, filename: string): Promise<void> {
		const root = await this.#realDirectory();
		let resolved: string;
		try {
			resolved = await realpath(path);
		} catch (error) {
			throw normalizeReadError(error, filename);
		}
		if (isPathWithin(root, resolved)) return;
		throw new MemoryStoreError("memory_path_escape", { filename: boundedFilename(filename) });
	}

	async #realDirectory(): Promise<string> {
		await this.directory();
		return this.#realDirectoryPromise!;
	}

	async #rawEntrypoint(): Promise<string> {
		return (await this.#readEntrypoint())?.trim() ?? "";
	}

	async #readEntrypoint(): Promise<string | undefined> {
		const memoryDir = await this.directory();
		const path = join(memoryDir, ENTRYPOINT_NAME);
		await this.#assertWriteParentContained(path);
		try {
			await lstat(path);
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return undefined;
			throw normalizeReadError(error, ENTRYPOINT_NAME);
		}
		await this.#assertContained(path, ENTRYPOINT_NAME);
		let content: string;
		try {
			content = await readStrictUtf8(path, ENTRYPOINT_NAME);
		} catch (error) {
			throw normalizeReadError(error, ENTRYPOINT_NAME);
		}
		await this.#assertContained(path, ENTRYPOINT_NAME);
		return content;
	}

	async #atomicWrite(target: string, content: string): Promise<OwnedFile> {
		await this.#assertWriteParentContained(target);
		const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
		let handle: MemoryAtomicFileHandle | undefined;
		let ownedTemporary: OwnedFile | undefined;
		let renamed = false;
		try {
			handle = await this.#atomicOperations.open(temporary, "wx", 0o600);
			ownedTemporary = await ownedFileFromHandle(temporary, handle);
			await handle.writeFile(content);
			await handle.sync();
			ownedTemporary = await ownedFileFromHandle(temporary, handle);
			await handle.close();
			handle = undefined;
			await this.#assertWriteParentContained(target);
			await this.#atomicOperations.rename(temporary, target);
			renamed = true;
			await this.#syncDirectory(dirname(target));
			return { ...ownedTemporary, path: target };
		} catch (error) {
			await handle?.close().catch(() => {});
			if (!renamed && ownedTemporary) await this.#unlinkOwnedFile(ownedTemporary);
			throw error;
		}
	}

	async #reserveUniqueTopic(
		memoryDir: string,
		name: string,
	): Promise<OwnedFile & { readonly filename: string }> {
		const stem = memoryFilenameStem(name);
		let index = 1;
		while (true) {
			const filename = index === 1 ? `${stem}.md` : `${stem}-${index}.md`;
			const path = join(memoryDir, filename);
			await this.#assertWriteParentContained(path);
			let handle: MemoryAtomicFileHandle;
			try {
				handle = await this.#atomicOperations.open(path, "wx", 0o600);
			} catch (error) {
				if (isNodeError(error, "EEXIST")) {
					index += 1;
					continue;
				}
				throw error;
			}
			let owned: OwnedFile | undefined;
			try {
				owned = await ownedFileFromHandle(path, handle);
				await handle.close();
			} catch (error) {
				await handle.close().catch(() => {});
				if (owned) await this.#unlinkOwnedFile(owned);
				throw error;
			}
			if (!owned) throw new MemoryStoreError("memory_write_failed", {
				operation: "memory_topic_reserve",
			});
			return { ...owned, filename };
		}
	}

	async #withDirectoryLock<Result>(operation: () => Promise<Result>): Promise<Result> {
		const lock = await this.#acquireDirectoryLock();
		try {
			return await operation();
		} finally {
			await this.#releaseDirectoryLock(lock);
		}
	}

	async #acquireDirectoryLock(): Promise<OwnedMemoryLock> {
		const memoryDir = await this.directory();
		const path = join(memoryDir, MEMORY_LOCK_NAME);
		const startedAt = Date.now();
		while (true) {
			await this.#assertWriteParentContained(path);
			const ownerId = randomUUID();
			let handle: Awaited<ReturnType<typeof open>>;
			try {
				handle = await open(path, "wx", 0o600);
			} catch (error) {
				if (!isNodeError(error, "EEXIST")) {
					throw new MemoryStoreError("memory_write_failed", {
						operation: "memory_lock_acquire",
					});
				}
				if (await this.#recoverStaleLock(path)) continue;
				const elapsed = Date.now() - startedAt;
				if (elapsed >= this.#lockTimeoutMs) {
					throw new MemoryStoreError("memory_write_failed", {
						operation: "memory_lock_timeout",
					});
				}
				await delay(Math.min(this.#lockRetryDelayMs, this.#lockTimeoutMs - elapsed));
				continue;
			}
			let owned: OwnedFile | undefined;
			try {
				owned = await ownedFileFromHandle(path, handle);
				await handle.writeFile(JSON.stringify({
					version: 1,
					owner_id: ownerId,
					pid: process.pid,
					created_at_ms: Date.now(),
				}), "utf8");
				await handle.sync();
				owned = await ownedFileFromHandle(path, handle);
				await handle.close();
				return { ...owned, ownerId };
			} catch {
				await handle.close().catch(() => {});
				if (owned) await this.#unlinkOwnedFile(owned);
				throw new MemoryStoreError("memory_write_failed", {
					operation: "memory_lock_acquire",
				});
			}
		}
	}

	async #recoverStaleLock(path: string): Promise<boolean> {
		const owned = await this.#ownedPath(path);
		if (!owned || Date.now() - owned.mtimeMs < this.#lockStaleMs) return false;
		let payload: unknown;
		try {
			payload = JSON.parse(await readFile(path, "utf8"));
		} catch {
			payload = undefined;
		}
		if (isMemoryLockPayload(payload)
			&& Date.now() - payload.created_at_ms < this.#lockStaleMs) {
			return false;
		}
		if (isMemoryLockPayload(payload) && isProcessAlive(payload.pid)) return false;
		return this.#unlinkOwnedFile(
			owned,
			isMemoryLockPayload(payload) ? payload.owner_id : undefined,
		);
	}

	async #releaseDirectoryLock(lock: OwnedMemoryLock): Promise<void> {
		await this.#unlinkOwnedFile(lock, lock.ownerId);
	}

	async #ownedPath(path: string): Promise<OwnedFile | undefined> {
		try {
			const metadata = await lstat(path);
			return {
				path,
				identity: fileIdentity(metadata),
				mtimeMs: metadata.mtimeMs,
			};
		} catch {
			return undefined;
		}
	}

	async #unlinkOwnedFile(owned: OwnedFile, ownerId?: string): Promise<boolean> {
		try {
			await this.#assertWriteParentContained(owned.path);
			const current = await lstat(owned.path);
			if (!sameFileIdentity(owned.identity, fileIdentity(current))) return false;
			if (ownerId !== undefined) {
				const payload = JSON.parse(await readFile(owned.path, "utf8")) as unknown;
				if (!isMemoryLockPayload(payload) || payload.owner_id !== ownerId) return false;
				const rechecked = await lstat(owned.path);
				if (!sameFileIdentity(owned.identity, fileIdentity(rechecked))) return false;
			}
			await this.#atomicOperations.unlink(owned.path);
			return true;
		} catch {
			return false;
		}
	}

	async #assertWriteParentContained(target: string): Promise<void> {
		const root = await this.#realDirectory();
		let resolvedParent: string;
		try {
			resolvedParent = await realpath(dirname(target));
		} catch {
			throw new MemoryStoreError("memory_path_escape", {
				filename: boundedFilename(target),
			});
		}
		if (!isPathWithin(root, resolvedParent)) {
			throw new MemoryStoreError("memory_path_escape", {
				filename: boundedFilename(target),
			});
		}
	}

	#enqueueMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
		const result = this.#mutationTail.then(operation);
		this.#mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	async #syncDirectory(path: string): Promise<void> {
		let handle: MemoryAtomicFileHandle | undefined;
		try {
			handle = await this.#atomicOperations.open(path, "r");
			await handle.sync();
		} catch {
			// Some filesystems do not permit directory fsync; the file itself was synced.
		} finally {
			await handle?.close().catch(() => {});
		}
	}
}

function truncateEntrypoint(raw: string): EntrypointContent {
	const trimmed = raw.trim();
	const lines = trimmed ? trimmed.split(/\r\n|\n|\r/u) : [];
	const lineCount = lines.length;
	const byteCount = Buffer.byteLength(trimmed, "utf8");
	const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
	const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;
	if (!wasLineTruncated && !wasByteTruncated) {
		return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
	}
	let truncated = wasLineTruncated ? lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed;
	while (Buffer.byteLength(truncated, "utf8") > MAX_ENTRYPOINT_BYTES) {
		const cutAt = truncated.lastIndexOf("\n");
		if (cutAt <= 0) {
			truncated = new TextDecoder("utf-8").decode(Buffer.from(truncated, "utf8").subarray(0, MAX_ENTRYPOINT_BYTES));
			break;
		}
		truncated = truncated.slice(0, cutAt);
	}
	const reasons = [
		...(wasLineTruncated ? [`${lineCount} lines`] : []),
		...(wasByteTruncated ? [`${byteCount} bytes`] : []),
	];
	return {
		content: `${truncated}\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reasons.join(" and ")}. Only part of it was loaded. Keep index entries concise and move detail into topic files.`,
		lineCount,
		byteCount,
		wasLineTruncated,
		wasByteTruncated,
	};
}

function emptyEntrypoint(): EntrypointContent {
	return { content: "", lineCount: 0, byteCount: 0, wasLineTruncated: false, wasByteTruncated: false };
}

async function readStrictUtf8(path: string, filename: string): Promise<string> {
	const bytes = await readFile(path);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new MemoryStoreError("memory_invalid_utf8", { filename: boundedFilename(filename) });
	}
}

function parseFrontmatter(lines: readonly string[]): Readonly<Record<string, string>> {
	if (lines[0]?.trim() !== "---") return {};
	const data: Record<string, string> = {};
	for (const line of lines.slice(1)) {
		if (line.trim() === "---") break;
		const separator = line.indexOf(":");
		if (separator < 0) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, "");
		data[key] = value;
	}
	return data;
}

function stripFrontmatter(raw: string): string {
	const lines = raw.split(/\r\n|\n|\r/u);
	if (lines[0]?.trim() !== "---") return raw;
	const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
	return closing < 0 ? raw : lines.slice(closing + 2).join("\n");
}

function memoryKind(value: string | undefined): FileMemoryKind | undefined {
	return value && VALID_MEMORY_KINDS.has(value as FileMemoryKind)
		? value as FileMemoryKind
		: undefined;
}

function validateRememberInput(input: RememberMemoryInput): RememberMemoryInput {
	const name = input.name.trim();
	const description = input.description.trim();
	const content = input.content.trim();
	if (!VALID_MEMORY_KINDS.has(input.kind)
		|| !name
		|| name.length > 200
		|| description.length > 1_000
		|| !content) {
		throw new MemoryStoreError("memory_invalid_input");
	}
	return { kind: input.kind, name, description, content };
}

function memoryFilenameStem(name: string): string {
	const stem = name.trim().toLowerCase().replace(PROJECT_KEY_PATTERN, "_").replace(/^[._-]+|[._-]+$/gu, "").slice(0, 80) || "memory";
	return stem;
}

function frontmatterScalar(value: string): string {
	return value.replace(/[\r\n]+/gu, " ").trim();
}

function markdownScalar(value: string): string {
	return frontmatterScalar(value).replaceAll("[", "").replaceAll("]", "");
}

function normalizeReadError(error: unknown, filename: string): MemoryStoreError {
	if (error instanceof MemoryStoreError) return error;
	return new MemoryStoreError("memory_read_failed", { filename: boundedFilename(filename) });
}

function boundedFilename(filename: string): string {
	return basename(filename).slice(0, 128);
}

function isPathWithin(root: string, candidate: string): boolean {
	const remainder = relative(root, candidate);
	return remainder === ""
		|| (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !remainder.startsWith(sep));
}

async function ownedFileFromHandle(
	path: string,
	handle: Pick<MemoryAtomicFileHandle, "stat">,
): Promise<OwnedFile> {
	const metadata = await handle.stat();
	return {
		path,
		identity: fileIdentity(metadata),
		mtimeMs: metadata.mtimeMs,
	};
}

function fileIdentity(metadata: { readonly dev: number | bigint; readonly ino: number | bigint }): FileIdentity {
	return { dev: metadata.dev, ino: metadata.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function isMemoryLockPayload(value: unknown): value is MemoryLockPayload {
	return isRecord(value)
		&& value.version === 1
		&& typeof value.owner_id === "string"
		&& value.owner_id.length > 0
		&& value.owner_id.length <= 128
		&& typeof value.pid === "number"
		&& Number.isSafeInteger(value.pid)
		&& value.pid > 0
		&& typeof value.created_at_ms === "number"
		&& Number.isSafeInteger(value.created_at_ms)
		&& value.created_at_ms >= 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeDuration(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative safe integer`);
	}
	return value;
}

function positiveDuration(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
	return value;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function isProcessAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return isNodeError(error, "ESRCH") ? false : true;
	}
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

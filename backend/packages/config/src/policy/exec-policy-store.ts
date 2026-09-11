import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	rename,
	unlink,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	ExecPolicyDecision,
	ExecPolicyRule,
	ExecPolicySource,
} from "@mycli/core";

const RULES_FILE_NAME = "default.rules";
const LOCK_FILE_NAME = `${RULES_FILE_NAME}.lock`;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const MAX_PATTERN_TOKENS = 16;
const MAX_PATTERN_TOKEN_CHARS = 256;
const MAX_PATTERN_TOTAL_CHARS = 512;

export interface ExecPolicyWriteResult {
	readonly status: "created" | "existing";
	readonly patternHash: string;
}

export interface ExecPolicyStoreOptions {
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly lockTimeoutMs?: number;
	readonly lockStaleMs?: number;
	readonly lockRetryDelayMs?: number;
	readonly processAlive?: (pid: number) => boolean;
	readonly failpoint?: (name: string) => void;
}

export type ExecPolicyStoreErrorKind =
	| "exec_policy_invalid_rule"
	| "exec_policy_read_failed"
	| "exec_policy_write_failed"
	| "exec_policy_lock_timeout";

export class ExecPolicyStoreError extends Error {
	constructor(
		readonly kind: ExecPolicyStoreErrorKind,
		message: string,
	) {
		super(`${kind}: ${message}`);
		this.name = "ExecPolicyStoreError";
	}
}

interface OwnedLock {
	readonly path: string;
	readonly ownerId: string;
	readonly dev: number | bigint;
	readonly ino: number | bigint;
}

interface LockPayload {
	readonly version: 1;
	readonly owner_id: string;
	readonly pid: number;
	readonly created_at_ms: number;
}

export class ExecPolicyStore {
	readonly #homeDir: string;
	readonly #workspaceRoot: string;
	readonly #lockTimeoutMs: number;
	readonly #lockStaleMs: number;
	readonly #lockRetryDelayMs: number;
	readonly #processAlive: (pid: number) => boolean;
	readonly #failpoint: (name: string) => void;

	constructor(options: ExecPolicyStoreOptions) {
		if (!options.homeDir.trim() || !options.workspaceRoot.trim()) {
			throw new TypeError("homeDir and workspaceRoot must be non-empty strings");
		}
		this.#homeDir = options.homeDir;
		this.#workspaceRoot = options.workspaceRoot;
		this.#lockTimeoutMs = duration(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, true);
		this.#lockStaleMs = duration(options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS, false);
		this.#lockRetryDelayMs = duration(
			options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
			false,
		);
		this.#processAlive = options.processAlive ?? isProcessAlive;
		this.#failpoint = options.failpoint ?? (() => undefined);
	}

	async load(): Promise<readonly ExecPolicyRule[]> {
		const user = await this.loadUserRules();
		const project = await readRulesFile(
			join(this.#workspaceRoot, ".mycli", "rules", RULES_FILE_NAME),
			"project",
		);
		return Object.freeze([...user, ...project]);
	}

	async loadUserRules(): Promise<readonly ExecPolicyRule[]> {
		return readRulesFile(this.#rulesPath(), "user");
	}

	async allow(patternValue: readonly string[]): Promise<ExecPolicyWriteResult> {
		const pattern = validatedPattern(patternValue);
		const patternHash = hashPattern(pattern);
		const rulesDir = this.#rulesDirectory();
		try {
			await mkdir(rulesDir, { recursive: true, mode: 0o700 });
			await harden(rulesDir, 0o700);
			const lock = await this.#acquireLock();
			try {
				await hardenOptional(this.#rulesPath(), 0o600);
				const existing = await this.loadUserRules();
				if (existing.some((rule) => rule.decision === "allow"
					&& equalTokens(rule.pattern, pattern))) {
					return Object.freeze({ status: "existing" as const, patternHash });
				}
				const path = this.#rulesPath();
				const current = await readOptionalFile(path);
				const separator = !current || /(?:\r\n|\n|\r)$/u.test(current) ? "" : "\n";
				const serialized = `prefix_rule(pattern=${serializedPattern(pattern)}, decision="allow")`;
				await this.#atomicReplace(path, `${current}${separator}${serialized}\n`);
				return Object.freeze({ status: "created" as const, patternHash });
			} finally {
				await this.#releaseLock(lock);
			}
		} catch (error) {
			if (error instanceof ExecPolicyStoreError) throw error;
			throw new ExecPolicyStoreError(
				"exec_policy_write_failed",
				"Could not update global Shell approval rules.",
			);
		}
	}

	#rulesDirectory(): string {
		return join(this.#homeDir, ".mycli", "rules");
	}

	#rulesPath(): string {
		return join(this.#rulesDirectory(), RULES_FILE_NAME);
	}

	async #acquireLock(): Promise<OwnedLock> {
		const path = join(this.#rulesDirectory(), LOCK_FILE_NAME);
		const startedAt = Date.now();
		while (true) {
			const ownerId = randomUUID();
			let handle: Awaited<ReturnType<typeof open>>;
			try {
				handle = await open(path, "wx", 0o600);
			} catch (error) {
				if (!isNodeError(error, "EEXIST")) {
					throw new ExecPolicyStoreError(
						"exec_policy_write_failed",
						"Could not acquire the global rule lock.",
					);
				}
				if (await this.#recoverStaleLock(path)) continue;
				const elapsed = Date.now() - startedAt;
				if (elapsed >= this.#lockTimeoutMs) {
					throw new ExecPolicyStoreError(
						"exec_policy_lock_timeout",
						"Timed out waiting for the global rule lock.",
					);
				}
				await delay(Math.min(this.#lockRetryDelayMs, this.#lockTimeoutMs - elapsed));
				continue;
			}
			try {
				const payload: LockPayload = {
					version: 1,
					owner_id: ownerId,
					pid: process.pid,
					created_at_ms: Date.now(),
				};
				await handle.writeFile(JSON.stringify(payload), "utf8");
				await handle.sync();
				const metadata = await handle.stat();
				await handle.close();
				return { path, ownerId, dev: metadata.dev, ino: metadata.ino };
			} catch {
				await handle.close().catch(() => undefined);
				await unlink(path).catch(() => undefined);
				throw new ExecPolicyStoreError(
					"exec_policy_write_failed",
					"Could not initialize the global rule lock.",
				);
			}
		}
	}

	async #recoverStaleLock(path: string): Promise<boolean> {
		let metadata: Awaited<ReturnType<typeof lstat>>;
		try {
			metadata = await lstat(path);
		} catch {
			return false;
		}
		if (Date.now() - metadata.mtimeMs < this.#lockStaleMs) return false;
		let payload: unknown;
		try {
			payload = JSON.parse(await readFile(path, "utf8"));
		} catch {
			payload = undefined;
		}
		if (isLockPayload(payload) && Date.now() - payload.created_at_ms < this.#lockStaleMs) {
			return false;
		}
		if (isLockPayload(payload) && this.#processAlive(payload.pid)) return false;
		try {
			const rechecked = await lstat(path);
			if (!sameIdentity(metadata, rechecked)) return false;
			if (isLockPayload(payload)) {
				const latest = JSON.parse(await readFile(path, "utf8")) as unknown;
				if (!isLockPayload(latest) || latest.owner_id !== payload.owner_id) return false;
			}
			await unlink(path);
			return true;
		} catch {
			return false;
		}
	}

	async #releaseLock(lock: OwnedLock): Promise<void> {
		try {
			const metadata = await lstat(lock.path);
			if (!sameIdentity(lock, metadata)) return;
			const payload = JSON.parse(await readFile(lock.path, "utf8")) as unknown;
			if (!isLockPayload(payload) || payload.owner_id !== lock.ownerId) return;
			const rechecked = await lstat(lock.path);
			if (!sameIdentity(lock, rechecked)) return;
			await unlink(lock.path);
		} catch {
			// A replaced or already removed lock is not ours to mutate.
		}
	}

	async #atomicReplace(path: string, content: string): Promise<void> {
		const temporaryPath = join(
			this.#rulesDirectory(),
			`.default.rules.${process.pid}.${randomUUID()}.tmp`,
		);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporaryPath, "wx", 0o600);
			await handle.writeFile(content, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			this.#failpoint("exec_policy_before_rename");
			await rename(temporaryPath, path);
			await harden(path, 0o600);
			await syncDirectory(this.#rulesDirectory());
		} finally {
			await handle?.close().catch(() => undefined);
			await unlink(temporaryPath).catch(() => undefined);
		}
	}
}

async function readRulesFile(
	path: string,
	source: ExecPolicySource,
): Promise<readonly ExecPolicyRule[]> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return Object.freeze([]);
		throw new ExecPolicyStoreError(
			"exec_policy_read_failed",
			`Could not read ${basename(path)}.`,
		);
	}
	const rules: ExecPolicyRule[] = [];
	for (const [offset, line] of content.split(/\r\n|\n|\r/u).entries()) {
		const stripped = line.trim();
		if (!stripped || stripped.startsWith("#")) continue;
		try {
			const parsed = parseRule(stripped);
			rules.push(Object.freeze({
				source,
				index: rules.length,
				pattern: parsed.pattern,
				decision: parsed.decision,
			}));
		} catch {
			throw new ExecPolicyStoreError(
				"exec_policy_invalid_rule",
				`${basename(path)}:${offset + 1}: invalid prefix_rule declaration.`,
			);
		}
	}
	return Object.freeze(rules);
}

function parseRule(line: string): {
	readonly pattern: readonly string[];
	readonly decision: ExecPolicyDecision;
} {
	const prefix = "prefix_rule(";
	if (!line.startsWith(prefix) || !line.endsWith(")")) throw new Error("invalid rule");
	const fields = parseNamedJsonFields(line.slice(prefix.length, -1));
	if (fields.size !== 2 || !fields.has("pattern") || !fields.has("decision")) {
		throw new Error("invalid fields");
	}
	const pattern = validatedPattern(fields.get("pattern"));
	const decision = fields.get("decision");
	if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
		throw new Error("invalid decision");
	}
	return { pattern, decision };
}

function parseNamedJsonFields(input: string): ReadonlyMap<string, unknown> {
	const fields = new Map<string, unknown>();
	let cursor = 0;
	while (cursor < input.length) {
		cursor = skipSpaces(input, cursor);
		const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(input.slice(cursor))?.[0];
		if (!name || (name !== "pattern" && name !== "decision") || fields.has(name)) {
			throw new Error("invalid field name");
		}
		cursor = skipSpaces(input, cursor + name.length);
		if (input[cursor] !== "=") throw new Error("missing equals");
		cursor = skipSpaces(input, cursor + 1);
		const value = scanJsonValue(input, cursor);
		fields.set(name, JSON.parse(input.slice(cursor, value.end)) as unknown);
		cursor = skipSpaces(input, value.end);
		if (cursor === input.length) break;
		if (input[cursor] !== ",") throw new Error("missing comma");
		cursor = skipSpaces(input, cursor + 1);
		if (cursor === input.length) throw new Error("trailing comma");
	}
	return fields;
}

function scanJsonValue(input: string, start: number): { readonly end: number } {
	const opening = input[start];
	if (opening !== '"' && opening !== "[") throw new Error("unsupported value");
	let inString = opening === '"';
	let escaped = false;
	let depth = opening === "[" ? 1 : 0;
	for (let cursor = start + 1; cursor < input.length; cursor += 1) {
		const char = input[cursor]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString && char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			if (!inString && depth === 0) return { end: cursor + 1 };
			continue;
		}
		if (inString) continue;
		if (char === "[") depth += 1;
		if (char === "]") {
			depth -= 1;
			if (depth === 0) return { end: cursor + 1 };
		}
	}
	throw new Error("unterminated JSON value");
}

function validatedPattern(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATTERN_TOKENS
		|| !value.every((token) => typeof token === "string" && token.trim()
			&& token.length <= MAX_PATTERN_TOKEN_CHARS)
		|| value.reduce((total, token) => total + (typeof token === "string" ? token.length : 0), 0)
			> MAX_PATTERN_TOTAL_CHARS) {
		throw new TypeError("pattern must be a bounded non-empty string array");
	}
	return Object.freeze([...(value as string[])]);
}

async function readOptionalFile(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return "";
		throw error;
	}
}

async function harden(path: string, mode: number): Promise<void> {
	try {
		await chmod(path, mode);
	} catch (error) {
		if (process.platform !== "win32") throw error;
	}
}

async function syncDirectory(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch {
		// Some platforms and filesystems reject directory fsync after the file was synced.
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function hashPattern(pattern: readonly string[]): string {
	return createHash("sha256")
		.update(asciiJson({ pattern }))
		.digest("hex")
		.slice(0, 16);
}

function asciiJson(value: unknown): string {
	return JSON.stringify(value).replace(/[\x7F-\uFFFF]/g, (character) =>
		`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function serializedPattern(pattern: readonly string[]): string {
	return `[${pattern.map((token) => asciiJson(token)).join(", ")}]`;
}

async function hardenOptional(path: string, mode: number): Promise<void> {
	try {
		await harden(path, mode);
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) throw error;
	}
}

function equalTokens(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((token, index) => token === right[index]);
}

function isLockPayload(value: unknown): value is LockPayload {
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

function sameIdentity(
	left: { readonly dev: number | bigint; readonly ino: number | bigint },
	right: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isNodeError(error, "ESRCH");
	}
}

function duration(value: number, allowZero: boolean): number {
	if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
		throw new RangeError("lock durations must be valid safe integers");
	}
	return value;
}

function skipSpaces(value: string, cursor: number): number {
	while (cursor < value.length && /\s/u.test(value[cursor]!)) cursor += 1;
	return cursor;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

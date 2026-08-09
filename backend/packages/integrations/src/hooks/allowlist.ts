import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	open,
	readFile,
	rename,
	unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	ConfiguredHookSpec,
	HookAllowlistSnapshot,
	HookApprovalRecord,
	HookApprovalStatus,
} from "./types.ts";

export interface HookAllowlistStoreOptions {
	readonly homeDir: string;
	readonly now?: () => Date;
	readonly lockTimeoutMs?: number;
	readonly lockRetryDelayMs?: number;
}

interface AllowlistFile {
	readonly schemaVersion: 1;
	readonly approvals: readonly HookApprovalRecord[];
}

interface LoadedAllowlist extends HookAllowlistSnapshot {
	readonly exists: boolean;
}

const ALLOWLIST_FILE = "hook-allowlist.json";
const LOCK_FILE = `${ALLOWLIST_FILE}.lock`;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const IDENTITY = /^(?:user|repo):[A-Za-z0-9][A-Za-z0-9._-]{0,63}:(?:pre_tool_use|post_tool_use|user_prompt_submit|stop|pre_compact|session_start|session_end)$/u;

export class HookAllowlistStoreError extends Error {
	constructor(readonly kind: "hook_allowlist_invalid" | "hook_allowlist_write_failed" | "hook_allowlist_lock_timeout") {
		super(kind);
		this.name = "HookAllowlistStoreError";
	}
}

export class HookAllowlistStore {
	readonly #homeDir: string;
	readonly #now: () => Date;
	readonly #lockTimeoutMs: number;
	readonly #lockRetryDelayMs: number;

	constructor(options: HookAllowlistStoreOptions) {
		if (!options.homeDir.trim()) throw new TypeError("homeDir must be non-empty");
		this.#homeDir = options.homeDir;
		this.#now = options.now ?? (() => new Date());
		this.#lockTimeoutMs = positiveDuration(
			options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
		);
		this.#lockRetryDelayMs = positiveDuration(
			options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
		);
	}

	async load(): Promise<HookAllowlistSnapshot> {
		const loaded = await this.#loadInternal();
		return Object.freeze({ records: loaded.records, issues: loaded.issues });
	}

	async statusFor(spec: ConfiguredHookSpec): Promise<HookApprovalStatus> {
		const commandDigest = hookCommandDigest(spec.command);
		const loaded = await this.#loadInternal();
		if (loaded.issues.length > 0) return status(false, "allowlist_invalid", commandDigest);
		if (!loaded.exists) return status(false, "allowlist_missing", commandDigest);
		const record = loaded.records.find((item) => (
			item.scope === spec.scope && item.identity === hookIdentity(spec)
		));
		if (!record) return status(false, "entry_missing", commandDigest);
		if (record.configPathHash !== hookConfigPathHash(spec.configPath)) {
			return status(false, "config_path_changed", commandDigest);
		}
		if (record.commandDigest !== commandDigest) {
			return status(false, "digest_changed", commandDigest);
		}
		return status(true, "matched", commandDigest);
	}

	async approve(spec: ConfiguredHookSpec): Promise<HookApprovalRecord> {
		return this.#withLock(async () => {
			const loaded = await this.#loadInternal();
			if (loaded.issues.length > 0) {
				throw new HookAllowlistStoreError("hook_allowlist_invalid");
			}
			const approved = approvalRecord(spec, this.#now());
			const records = loaded.records.filter((item) => !sameIdentity(item, approved));
			records.push(approved);
			await this.#write(records);
			return approved;
		});
	}

	async revoke(spec: ConfiguredHookSpec): Promise<boolean> {
		return this.#withLock(async () => {
			const loaded = await this.#loadInternal();
			if (loaded.issues.length > 0) {
				throw new HookAllowlistStoreError("hook_allowlist_invalid");
			}
			const identity = hookIdentity(spec);
			const records = loaded.records.filter((item) => (
				item.scope !== spec.scope || item.identity !== identity
			));
			const removed = records.length !== loaded.records.length;
			if (removed || loaded.exists) await this.#write(records);
			return removed;
		});
	}

	#directory(): string {
		return join(this.#homeDir, ".mycli");
	}

	#path(): string {
		return join(this.#directory(), ALLOWLIST_FILE);
	}

	async #loadInternal(): Promise<LoadedAllowlist> {
		let raw: string;
		try {
			raw = await readFile(this.#path(), "utf8");
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				return frozenLoaded(false, [], []);
			}
			return frozenLoaded(true, [], ["allowlist_read_failed"]);
		}
		let payload: unknown;
		try {
			payload = JSON.parse(raw) as unknown;
		} catch {
			return frozenLoaded(true, [], ["allowlist_invalid_json"]);
		}
		if (!isRecord(payload)
			|| payload.schemaVersion !== 1
			|| !Array.isArray(payload.approvals)) {
			return frozenLoaded(true, [], ["allowlist_invalid_schema"]);
		}
		const records: HookApprovalRecord[] = [];
		const identities = new Set<string>();
		for (const rawRecord of payload.approvals) {
			const record = parseRecord(rawRecord);
			const key = record ? `${record.scope}\0${record.identity}` : "";
			if (!record || identities.has(key)) {
				return frozenLoaded(true, [], ["allowlist_invalid_record"]);
			}
			identities.add(key);
			records.push(record);
		}
		return frozenLoaded(true, records, []);
	}

	async #withLock<Value>(operation: () => Promise<Value>): Promise<Value> {
		await mkdir(this.#directory(), { recursive: true, mode: 0o700 });
		await chmod(this.#directory(), 0o700);
		const lockPath = join(this.#directory(), LOCK_FILE);
		const startedAt = Date.now();
		let handle: Awaited<ReturnType<typeof open>>;
		while (true) {
			try {
				handle = await open(lockPath, "wx", 0o600);
				break;
			} catch (error) {
				if (errorCode(error) !== "EEXIST") {
					throw new HookAllowlistStoreError("hook_allowlist_write_failed");
				}
				if (Date.now() - startedAt >= this.#lockTimeoutMs) {
					throw new HookAllowlistStoreError("hook_allowlist_lock_timeout");
				}
				await delay(this.#lockRetryDelayMs);
			}
		}
		try {
			await handle.writeFile(JSON.stringify({
				schemaVersion: 1,
				ownerId: randomUUID(),
				pid: process.pid,
				createdAtMs: Date.now(),
			}), "utf8");
			await handle.sync();
			return await operation();
		} finally {
			await handle.close().catch(() => undefined);
			await unlink(lockPath).catch(() => undefined);
		}
	}

	async #write(records: readonly HookApprovalRecord[]): Promise<void> {
		const sorted = [...records].sort((left, right) => (
			left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0
		));
		const payload: AllowlistFile = {
			schemaVersion: 1,
			approvals: sorted,
		};
		const temporaryPath = join(
			this.#directory(),
			`.hook-allowlist.${process.pid}.${randomUUID()}.tmp`,
		);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporaryPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporaryPath, this.#path());
			await chmod(this.#path(), 0o600);
			await syncDirectory(this.#directory());
		} catch (error) {
			if (error instanceof HookAllowlistStoreError) throw error;
			throw new HookAllowlistStoreError("hook_allowlist_write_failed");
		} finally {
			await handle?.close().catch(() => undefined);
			await unlink(temporaryPath).catch(() => undefined);
		}
	}
}

export function hookIdentity(spec: ConfiguredHookSpec): string {
	return `${spec.scope}:${spec.hookId}:${spec.hookPoint}`;
}

export function hookCommandDigest(command: readonly string[]): string {
	if (command.length === 0 || command.some((item) => !item || item.includes("\0"))) {
		throw new TypeError("hook command must contain canonical argv");
	}
	return sha256(command.join("\0"));
}

export function hookConfigPathHash(configPath: string): string {
	if (!configPath.trim() || configPath.includes("\0")) {
		throw new TypeError("hook config path must be non-empty");
	}
	return sha256(resolve(configPath));
}

function approvalRecord(spec: ConfiguredHookSpec, now: Date): HookApprovalRecord {
	return Object.freeze({
		schemaVersion: 1,
		identity: hookIdentity(spec),
		scope: spec.scope,
		configPathHash: hookConfigPathHash(spec.configPath),
		commandDigest: hookCommandDigest(spec.command),
		approvedAt: now.toISOString(),
	});
}

function parseRecord(value: unknown): HookApprovalRecord | undefined {
	if (!isRecord(value)
		|| value.schemaVersion !== 1
		|| typeof value.identity !== "string"
		|| !IDENTITY.test(value.identity)
		|| (value.scope !== "user" && value.scope !== "repo")
		|| !value.identity.startsWith(`${value.scope}:`)
		|| typeof value.configPathHash !== "string"
		|| !SHA256.test(value.configPathHash)
		|| typeof value.commandDigest !== "string"
		|| !SHA256.test(value.commandDigest)
		|| typeof value.approvedAt !== "string"
		|| !validIsoDate(value.approvedAt)
		|| Object.keys(value).length !== 6) {
		return undefined;
	}
	return Object.freeze({
		schemaVersion: 1,
		identity: value.identity,
		scope: value.scope,
		configPathHash: value.configPathHash,
		commandDigest: value.commandDigest,
		approvedAt: value.approvedAt,
	});
}

function sameIdentity(left: HookApprovalRecord, right: HookApprovalRecord): boolean {
	return left.scope === right.scope && left.identity === right.identity;
}

function status(
	allowed: boolean,
	reason: HookApprovalStatus["reason"],
	commandDigest: string,
): HookApprovalStatus {
	return Object.freeze({ allowed, reason, commandDigest });
}

function frozenLoaded(
	exists: boolean,
	records: readonly HookApprovalRecord[],
	issues: readonly string[],
): LoadedAllowlist {
	return Object.freeze({
		exists,
		records: Object.freeze([...records]),
		issues: Object.freeze([...issues]),
	});
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function validIsoDate(value: string): boolean {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function positiveDuration(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("duration must be positive");
	return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

async function syncDirectory(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		if (process.platform !== "win32") throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

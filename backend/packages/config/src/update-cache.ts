import { open } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateFileUpdate } from "./private-file-writer.ts";

const CACHE_FILE_NAME = "version.json";
const CACHE_SCHEMA_VERSION = 1 as const;
const MAX_CACHE_BYTES = 16 * 1024;
const MAX_REGISTRY_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export const UPDATE_CACHE_TTL_MS = 20 * 60 * 60 * 1_000;

export type UpdateCacheState = "fresh" | "invalid" | "missing" | "stale" | "unreadable";
export type UpdateAvailability = "available" | "current" | "disabled" | "dismissed" | "unknown";
export type UpdateInstallMethod = "bun" | "npm" | "pnpm" | "unknown" | "yarn";
export type UpdateRefreshOutcome = "disabled" | "failed" | "not_needed" | "refreshed";

export interface UpdateCacheRecord {
	readonly schemaVersion: typeof CACHE_SCHEMA_VERSION;
	readonly packageName: string;
	readonly latestVersion: string;
	readonly lastCheckedAt: string;
	readonly dismissedVersion?: string;
}

export interface UpdateInstallGuidance {
	readonly method: UpdateInstallMethod;
	readonly command: string;
	readonly fallback: boolean;
}

export interface CachedUpdateStatus {
	readonly schemaVersion: typeof CACHE_SCHEMA_VERSION;
	readonly packageName: string;
	readonly currentVersion: string;
	readonly checkOnStartup: boolean;
	readonly availability: UpdateAvailability;
	readonly cacheState: UpdateCacheState;
	readonly install: UpdateInstallGuidance;
	readonly latestVersion?: string;
	readonly lastCheckedAt?: string;
	readonly dismissedVersion?: string;
}

export interface UpdateRefreshResult {
	readonly outcome: UpdateRefreshOutcome;
	readonly status: CachedUpdateStatus;
}

export type CachedUpdateErrorCode =
	| "invalid_update_version"
	| "update_cache_write_failed"
	| "update_version_unavailable";

export class CachedUpdateError extends Error {
	constructor(readonly code: CachedUpdateErrorCode) {
		super(code);
		this.name = "CachedUpdateError";
	}
}

export interface CachedUpdateServiceOptions {
	readonly homeDir: string;
	readonly packageName: string;
	readonly currentVersion: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly executablePath?: string;
	readonly fetch?: typeof fetch;
	readonly now?: () => Date;
	readonly requestTimeoutMs?: number;
	readonly cacheTtlMs?: number;
}

type CacheReadResult =
	| { readonly state: "fresh" | "stale"; readonly record: UpdateCacheRecord }
	| { readonly state: "invalid" | "missing" | "unreadable" };

export class CachedUpdateService {
	readonly #options: CachedUpdateServiceOptions;
	readonly #fetch: typeof fetch;
	readonly #now: () => Date;
	readonly #controller = new AbortController();
	readonly #requestTimeoutMs: number;
	readonly #cacheTtlMs: number;
	#refreshPromise: Promise<UpdateRefreshResult> | null = null;
	#closePromise: Promise<void> | null = null;
	#closed = false;

	constructor(options: CachedUpdateServiceOptions) {
		if (!options.packageName.trim() || options.packageName.length > 214) {
			throw new TypeError("invalid_update_package_name");
		}
		this.#options = options;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? (() => new Date());
		this.#requestTimeoutMs = boundedPositiveInteger(
			options.requestTimeoutMs,
			DEFAULT_REQUEST_TIMEOUT_MS,
		);
		this.#cacheTtlMs = boundedPositiveInteger(options.cacheTtlMs, UPDATE_CACHE_TTL_MS);
	}

	async status(checkOnStartup: boolean): Promise<CachedUpdateStatus> {
		const cached = await readCache(this.#cachePath(), this.#options.packageName, this.#now(), this.#cacheTtlMs);
		return projectStatus({
			cached,
			checkOnStartup,
			packageName: this.#options.packageName,
			currentVersion: this.#options.currentVersion,
			install: updateInstallGuidance(
				this.#options.packageName,
				this.#options.env,
				this.#options.executablePath,
			),
		});
	}

	refreshIfNeeded(checkOnStartup: boolean): Promise<UpdateRefreshResult> {
		return this.#startRefresh(checkOnStartup, false);
	}

	refreshNow(checkOnStartup: boolean): Promise<UpdateRefreshResult> {
		return this.#startRefresh(checkOnStartup, true);
	}

	#startRefresh(checkOnStartup: boolean, force: boolean): Promise<UpdateRefreshResult> {
		if (this.#refreshPromise) return this.#refreshPromise;
		const promise = this.#refreshIfNeeded(checkOnStartup, force);
		this.#refreshPromise = promise;
		void promise.finally(() => {
			if (this.#refreshPromise === promise) this.#refreshPromise = null;
		}).catch(() => undefined);
		return promise;
	}

	startBackgroundRefresh(checkOnStartup: boolean): void {
		if (!checkOnStartup || this.#closed) return;
		void this.refreshIfNeeded(true).catch(() => undefined);
	}

	async dismiss(version: string, checkOnStartup: boolean): Promise<CachedUpdateStatus> {
		if (!isStableSemanticVersion(version)) {
			throw new CachedUpdateError("invalid_update_version");
		}
		if (this.#closed) throw new CachedUpdateError("update_cache_write_failed");
		try {
			await atomicPrivateFileUpdate({
				directory: this.#cacheDirectory(),
				fileName: CACHE_FILE_NAME,
				maxCurrentBytes: MAX_CACHE_BYTES,
				buildContent: (current) => {
					const record = parseCacheRecord(current, this.#options.packageName);
					if (!record || record.latestVersion !== version) {
						throw new CachedUpdateError("update_version_unavailable");
					}
					return serializeCacheRecord({ ...record, dismissedVersion: version });
				},
			});
		} catch (error) {
			if (error instanceof CachedUpdateError) throw error;
			throw new CachedUpdateError("update_cache_write_failed");
		}
		return this.status(checkOnStartup);
	}

	close(): Promise<void> {
		this.#closePromise ??= (async () => {
			this.#closed = true;
			this.#controller.abort();
			await this.#refreshPromise?.catch(() => undefined);
		})();
		return this.#closePromise;
	}

	async #refreshIfNeeded(
		checkOnStartup: boolean,
		force: boolean,
	): Promise<UpdateRefreshResult> {
		const current = await this.status(checkOnStartup);
		if ((!checkOnStartup && !force) || this.#closed) {
			return Object.freeze({ outcome: "disabled", status: current });
		}
		if (!force && current.cacheState === "fresh") {
			return Object.freeze({ outcome: "not_needed", status: current });
		}
		return this.#refresh(current, checkOnStartup);
	}

	async #refresh(
		previous: CachedUpdateStatus,
		checkOnStartup: boolean,
	): Promise<UpdateRefreshResult> {
		const startedAt = this.#now();
		try {
			const latestVersion = await fetchLatestVersion({
				fetch: this.#fetch,
				packageName: this.#options.packageName,
				signal: AbortSignal.any([
					this.#controller.signal,
					AbortSignal.timeout(this.#requestTimeoutMs),
				]),
			});
			if (this.#closed) return Object.freeze({ outcome: "failed", status: previous });
			await atomicPrivateFileUpdate({
				directory: this.#cacheDirectory(),
				fileName: CACHE_FILE_NAME,
				maxCurrentBytes: MAX_CACHE_BYTES,
				buildContent: (current) => {
					const existing = parseCacheRecord(current, this.#options.packageName);
					if (existing && Date.parse(existing.lastCheckedAt) > startedAt.getTime()) {
						return undefined;
					}
					return serializeCacheRecord({
						schemaVersion: CACHE_SCHEMA_VERSION,
						packageName: this.#options.packageName,
						latestVersion,
						lastCheckedAt: startedAt.toISOString(),
						...(existing?.dismissedVersion
							? { dismissedVersion: existing.dismissedVersion }
							: {}),
					});
				},
			});
			return Object.freeze({ outcome: "refreshed", status: await this.status(checkOnStartup) });
		} catch {
			return Object.freeze({ outcome: "failed", status: await this.status(checkOnStartup) });
		}
	}

	#cacheDirectory(): string {
		return join(this.#options.homeDir, ".mycli");
	}

	#cachePath(): string {
		return join(this.#cacheDirectory(), CACHE_FILE_NAME);
	}
}

export function isStableSemanticVersion(value: unknown): value is string {
	return typeof value === "string"
		&& value.length <= 64
		&& /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value);
}

export function compareStableSemanticVersions(left: string, right: string): number {
	if (!isStableSemanticVersion(left) || !isStableSemanticVersion(right)) {
		throw new TypeError("invalid_stable_semantic_version");
	}
	const leftParts = left.split(".");
	const rightParts = right.split(".");
	for (let index = 0; index < 3; index += 1) {
		const comparison = compareNumericText(leftParts[index]!, rightParts[index]!);
		if (comparison !== 0) return comparison;
	}
	return 0;
}

export function updateInstallGuidance(
	packageName: string,
	env: NodeJS.ProcessEnv = process.env,
	executablePath = process.argv[1] ?? "",
): UpdateInstallGuidance {
	const evidence = [
		env.npm_config_user_agent,
		env.npm_execpath,
		executablePath,
	].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
	let method: UpdateInstallMethod = "unknown";
	if (/(?:^|[\\/\s])pnpm(?:[\\/\s@]|$)|[\\/]\.pnpm[\\/]/u.test(evidence)) method = "pnpm";
	else if (/(?:^|[\\/\s])bun(?:[\\/\s@]|$)|[\\/]\.bun[\\/]/u.test(evidence)) method = "bun";
	else if (/(?:^|[\\/\s])yarn(?:[\\/\s@]|$)|[\\/]\.yarn[\\/]/u.test(evidence)) method = "yarn";
	else if (/(?:^|[\\/\s])npm(?:[\\/\s@]|$)|[\\/]node_modules[\\/]/u.test(evidence)) method = "npm";
	const command = method === "pnpm"
		? `pnpm add -g ${packageName}@latest`
		: method === "yarn"
			? `yarn global add ${packageName}@latest`
			: method === "bun"
				? `bun add -g ${packageName}@latest`
				: `npm install -g ${packageName}@latest`;
	return Object.freeze({ method, command, fallback: method === "unknown" });
}

async function fetchLatestVersion(input: {
	readonly fetch: typeof fetch;
	readonly packageName: string;
	readonly signal: AbortSignal;
}): Promise<string> {
	const registryName = input.packageName.replaceAll("/", "%2F");
	const response = await input.fetch(`https://registry.npmjs.org/${registryName}/latest`, {
		headers: { accept: "application/vnd.npm.install-v1+json" },
		signal: input.signal,
	});
	if (!response.ok) throw new Error("update_registry_unavailable");
	const raw = await readResponseText(response, MAX_REGISTRY_RESPONSE_BYTES);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("invalid_update_registry_response");
	}
	const version = isRecord(parsed) ? parsed.version : undefined;
	if (!isStableSemanticVersion(version)) throw new Error("invalid_update_registry_version");
	return version;
}

async function readResponseText(response: Response, limit: number): Promise<string> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > limit) {
		throw new Error("update_registry_response_too_large");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		total += next.value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			throw new Error("update_registry_response_too_large");
		}
		chunks.push(next.value);
	}
	const content = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		content.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

async function readCache(
	path: string,
	packageName: string,
	now: Date,
	ttlMs: number,
): Promise<CacheReadResult> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		const stats = await handle.stat();
		if (!stats.isFile() || stats.size > MAX_CACHE_BYTES) return Object.freeze({ state: "invalid" });
		const content = Buffer.alloc(Number(stats.size));
		const { bytesRead } = await handle.read(content, 0, content.length, 0);
		const record = parseCacheRecord(content.subarray(0, bytesRead).toString("utf8"), packageName);
		if (!record) return Object.freeze({ state: "invalid" });
		const checkedAt = Date.parse(record.lastCheckedAt);
		const age = now.getTime() - checkedAt;
		return Object.freeze({
			state: age >= 0 && age < ttlMs ? "fresh" : "stale",
			record,
		});
	} catch (error) {
		return Object.freeze({ state: isNodeError(error, "ENOENT") ? "missing" : "unreadable" });
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function parseCacheRecord(raw: string | undefined, packageName: string): UpdateCacheRecord | undefined {
	if (raw === undefined || Buffer.byteLength(raw, "utf8") > MAX_CACHE_BYTES) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(value)
		|| value.schemaVersion !== CACHE_SCHEMA_VERSION
		|| value.packageName !== packageName
		|| !isStableSemanticVersion(value.latestVersion)
		|| !canonicalIsoTimestamp(value.lastCheckedAt)
		|| (value.dismissedVersion !== undefined && !isStableSemanticVersion(value.dismissedVersion))) {
		return undefined;
	}
	return Object.freeze({
		schemaVersion: CACHE_SCHEMA_VERSION,
		packageName,
		latestVersion: value.latestVersion,
		lastCheckedAt: value.lastCheckedAt,
		...(value.dismissedVersion ? { dismissedVersion: value.dismissedVersion } : {}),
	});
}

function serializeCacheRecord(record: UpdateCacheRecord): string {
	return `${JSON.stringify(record, null, 2)}\n`;
}

function projectStatus(input: {
	readonly cached: CacheReadResult;
	readonly checkOnStartup: boolean;
	readonly packageName: string;
	readonly currentVersion: string;
	readonly install: UpdateInstallGuidance;
}): CachedUpdateStatus {
	const record = "record" in input.cached ? input.cached.record : undefined;
	let availability: UpdateAvailability = "unknown";
	if (!input.checkOnStartup) availability = "disabled";
	else if (record && isStableSemanticVersion(input.currentVersion)) {
		const comparison = compareStableSemanticVersions(record.latestVersion, input.currentVersion);
		availability = comparison <= 0
			? "current"
			: record.dismissedVersion === record.latestVersion ? "dismissed" : "available";
	}
	return Object.freeze({
		schemaVersion: CACHE_SCHEMA_VERSION,
		packageName: input.packageName,
		currentVersion: input.currentVersion.slice(0, 64),
		checkOnStartup: input.checkOnStartup,
		availability,
		cacheState: input.cached.state,
		install: input.install,
		...(record ? {
			latestVersion: record.latestVersion,
			lastCheckedAt: record.lastCheckedAt,
			...(record.dismissedVersion ? { dismissedVersion: record.dismissedVersion } : {}),
		} : {}),
	});
}

function compareNumericText(left: string, right: string): number {
	if (left.length !== right.length) return left.length < right.length ? -1 : 1;
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 32) return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
	const selected = value ?? fallback;
	if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 7 * 24 * 60 * 60 * 1_000) {
		throw new RangeError("invalid_update_timeout");
	}
	return selected;
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { join } from "node:path";
import type {
	McpServerConfig,
	McpToolDescriptor,
} from "./types.ts";

export interface McpCachedServerCatalog {
	readonly serverId: string;
	readonly tools: readonly McpToolDescriptor[];
	readonly resourceCount: number;
}

export interface McpCatalogCacheContract {
	load(configs: readonly McpServerConfig[]): Promise<readonly McpCachedServerCatalog[] | undefined>;
	save(
		configs: readonly McpServerConfig[],
		catalogs: readonly McpCachedServerCatalog[],
	): Promise<void>;
}

export interface McpCatalogCacheOptions {
	readonly directory: string;
	readonly ttlMs?: number;
	readonly clock?: () => number;
}

const CACHE_VERSION = 2;
const CACHE_FILE = "mcp-catalog-v2.json";
const LEGACY_CACHE_FILES = Object.freeze(["mcp-catalog-v1.json"]);
const DEFAULT_TTL_MS = 60 * 60 * 1_000;
const MAX_CACHE_BYTES = 2 * 1_024 * 1_024;
const MAX_SERVERS = 64;
const MAX_TOOLS_PER_SERVER = 512;
const MAX_TEXT_CHARS = 16_384;
const MAX_SCHEMA_CHARS = 131_072;

export class McpCatalogCache implements McpCatalogCacheContract {
	readonly #directory: string;
	readonly #ttlMs: number;
	readonly #clock: () => number;

	constructor(options: McpCatalogCacheOptions) {
		this.#directory = options.directory;
		this.#ttlMs = validTtl(options.ttlMs);
		this.#clock = options.clock ?? Date.now;
	}

	async load(
		configs: readonly McpServerConfig[],
	): Promise<readonly McpCachedServerCatalog[] | undefined> {
		await Promise.all(LEGACY_CACHE_FILES.map(
			(fileName) => rm(join(this.#directory, fileName), { force: true }).catch(() => undefined),
		));
		const path = join(this.#directory, CACHE_FILE);
		try {
			const metadata = await stat(path);
			if (!metadata.isFile() || metadata.size > MAX_CACHE_BYTES) {
				await rm(path, { force: true }).catch(() => undefined);
				return undefined;
			}
			const payload = JSON.parse(await readFile(path, "utf8")) as unknown;
			const parsed = parseCache(payload, configFingerprint(configs), this.#clock(), this.#ttlMs);
			if (!parsed) await rm(path, { force: true }).catch(() => undefined);
			return parsed;
		} catch {
			await rm(path, { force: true }).catch(() => undefined);
			return undefined;
		}
	}

	async save(
		configs: readonly McpServerConfig[],
		catalogs: readonly McpCachedServerCatalog[],
	): Promise<void> {
		const now = this.#clock();
		const content = `${JSON.stringify({
			version: CACHE_VERSION,
			fingerprint: configFingerprint(configs),
			expires_at: now + this.#ttlMs,
			catalogs,
		})}\n`;
		if (content.length > MAX_CACHE_BYTES) return;
		await writePrivateFile(this.#directory, CACHE_FILE, content);
	}
}

async function writePrivateFile(directory: string, fileName: string, content: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await harden(directory, 0o700);
	const target = join(directory, fileName);
	const temporary = join(directory, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, target);
		await harden(target, 0o600);
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function harden(path: string, mode: number): Promise<void> {
	try {
		await chmod(path, mode);
	} catch (error) {
		if (process.platform !== "win32") throw error;
	}
}

function parseCache(
	value: unknown,
	fingerprint: string,
	now: number,
	ttlMs: number,
): readonly McpCachedServerCatalog[] | undefined {
	if (!isRecord(value)
		|| value.version !== CACHE_VERSION
		|| value.fingerprint !== fingerprint
		|| typeof value.expires_at !== "number"
		|| !Number.isSafeInteger(value.expires_at)
		|| value.expires_at <= now
		|| value.expires_at > now + ttlMs
		|| !Array.isArray(value.catalogs)
		|| value.catalogs.length > MAX_SERVERS) {
		return undefined;
	}
	const catalogs = value.catalogs.flatMap(parseCatalog);
	if (catalogs.length !== value.catalogs.length) return undefined;
	return Object.freeze(catalogs);
}

function parseCatalog(value: unknown): McpCachedServerCatalog[] {
	if (!isRecord(value)
		|| !boundedString(value.serverId, 64)
		|| !Array.isArray(value.tools)
		|| value.tools.length > MAX_TOOLS_PER_SERVER
		|| !Number.isSafeInteger(value.resourceCount)
		|| (value.resourceCount as number) < 0
		|| (value.resourceCount as number) > 100_000) {
		return [];
	}
	const tools = value.tools.flatMap((tool) => parseTool(value.serverId as string, tool));
	if (tools.length !== value.tools.length) return [];
	return [Object.freeze({
		serverId: value.serverId as string,
		tools: Object.freeze(tools),
		resourceCount: value.resourceCount as number,
	})];
}

function parseTool(serverId: string, value: unknown): McpToolDescriptor[] {
	if (!isRecord(value)
		|| value.serverId !== serverId
		|| !boundedString(value.name, 512)
		|| !boundedString(value.description, MAX_TEXT_CHARS, true)
		|| (value.serverInstructions !== undefined && !boundedString(value.serverInstructions, MAX_TEXT_CHARS, true))
		|| !isRecord(value.inputSchema)
		|| JSON.stringify(value.inputSchema).length > MAX_SCHEMA_CHARS
		|| typeof value.supportsParallelToolCalls !== "boolean") {
		return [];
	}
	return [Object.freeze({
		serverId,
		name: value.name as string,
		description: value.description as string,
		...(typeof value.serverInstructions === "string" ? { serverInstructions: value.serverInstructions } : {}),
		inputSchema: Object.freeze({ ...value.inputSchema }),
		supportsParallelToolCalls: value.supportsParallelToolCalls,
	})];
}

function configFingerprint(configs: readonly McpServerConfig[]): string {
	const canonical = configs.map((config) => ({
		id: config.id,
		transport: config.transport,
		command: config.command ?? null,
		url: config.url ?? null,
		args: [...config.args],
		cwd: config.cwd ?? null,
		pluginDescription: config.pluginDescription ?? null,
		env: sortedRecord(config.env),
		headers: sortedRecord(config.headers),
		enabled: config.enabled,
		supportsParallelToolCalls: config.supportsParallelToolCalls,
		timeoutMs: config.timeoutMs,
	}));
	return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function sortedRecord(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	return Object.freeze(Object.fromEntries(
		Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
	));
}

function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
	return typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0);
}

function validTtl(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TTL_MS;
	if (!Number.isSafeInteger(value) || value <= 0 || value > 7 * 24 * 60 * 60 * 1_000) {
		throw new Error("invalid_mcp_catalog_cache_ttl");
	}
	return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

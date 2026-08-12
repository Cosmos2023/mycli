import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
	McpConfigDiagnostic,
	McpConfigDiscovery,
	McpConfigSource,
	McpServerConfig,
	McpTransportKind,
} from "./types.ts";

export interface DiscoverMcpConfigOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

interface ConfigFile {
	readonly path: string;
	readonly source: McpConfigSource;
}

const ROOT_ALIASES = ["servers", "mcp_servers", "mcpServers"] as const;
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

class McpConfigError extends Error {
	readonly errorClass: string;

	constructor(errorClass: string) {
		super(errorClass);
		this.errorClass = errorClass;
	}
}

export async function discoverMcpConfig(
	options: DiscoverMcpConfigOptions,
): Promise<McpConfigDiscovery> {
	const files: readonly ConfigFile[] = [
		{ path: join(options.homeDir, ".mycli", "mcp_servers.toml"), source: "user" },
		{
			path: join(options.workspaceRoot, ".mycli", "mcp_servers.toml"),
			source: "repository",
		},
	];
	const servers = new Map<string, McpServerConfig>();
	const diagnostics: McpConfigDiagnostic[] = [];

	for (const file of files) {
		const parsed = await readConfigFile(file, options.env, diagnostics);
		for (const [id, server] of parsed) servers.set(id, server);
	}

	const ordered = Object.freeze([...servers.values()].sort((left, right) => (
		left.id < right.id ? -1 : left.id > right.id ? 1 : 0
	)));
	const byId = new Map(ordered.map((server) => [server.id, server]));
	return Object.freeze({
		servers: ordered,
		diagnostics: Object.freeze(diagnostics),
		get: (id: string) => byId.get(id),
	});
}

async function readConfigFile(
	file: ConfigFile,
	env: Readonly<Record<string, string | undefined>>,
	diagnostics: McpConfigDiagnostic[],
): Promise<ReadonlyMap<string, McpServerConfig>> {
	let raw: string;
	try {
		raw = await readFile(file.path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return new Map();
		diagnostics.push(issue(file, "config", "config_read_failed"));
		return new Map();
	}

	let payload: Readonly<Record<string, unknown>>;
	try {
		payload = recordValue(parseToml(raw), "invalid_toml");
	} catch {
		diagnostics.push(issue(file, "config", "invalid_toml"));
		return new Map();
	}

	const rows = new Map<string, Readonly<Record<string, unknown>>>();
	for (const alias of ROOT_ALIASES) {
		const root = payload[alias];
		if (root === undefined) continue;
		if (!isRecord(root)) {
			diagnostics.push(issue(file, alias, "invalid_servers"));
			continue;
		}
		for (const [id, value] of Object.entries(root)) {
			if (rows.has(id)) {
				diagnostics.push(issue(file, id, "duplicate_server"));
				continue;
			}
			if (!isRecord(value)) {
				diagnostics.push(issue(file, id, "invalid_server"));
				continue;
			}
			rows.set(id, value);
		}
	}

	const parsed = new Map<string, McpServerConfig>();
	for (const [id, row] of rows) {
		try {
			parsed.set(id, parseServer(id, row, env));
		} catch (error) {
			diagnostics.push(issue(
				file,
				boundedServerId(id),
				error instanceof McpConfigError ? error.errorClass : "invalid_server",
			));
		}
	}
	return parsed;
}

function parseServer(
	id: string,
	raw: Readonly<Record<string, unknown>>,
	env: Readonly<Record<string, string | undefined>>,
): McpServerConfig {
	if (!SERVER_ID.test(id)) throw new McpConfigError("invalid_server_id");
	const transport = transportValue(raw.transport ?? raw.type ?? "stdio");
	const command = optionalNonEmptyString(raw.command, "invalid_command");
	const url = optionalNonEmptyString(raw.url, "invalid_url");
	if (transport === "stdio" && !command) throw new McpConfigError("missing_command");
	if (transport !== "stdio" && !url) throw new McpConfigError("missing_url");
	if (url) validateUrl(url);

	return Object.freeze({
		id,
		transport,
		...(command ? { command } : {}),
		...(url ? { url } : {}),
		args: Object.freeze(stringArray(raw.args)),
		env: Object.freeze(stringMap(raw.env, env, true)),
		headers: Object.freeze(stringMap(raw.headers, env, false)),
		enabled: booleanValue(raw.enabled, true),
		supportsParallelToolCalls: booleanValue(
			raw.supports_parallel_tool_calls,
			false,
			"invalid_parallel_tool_calls",
		),
		timeoutMs: timeoutValue(raw),
	});
}

function transportValue(value: unknown): McpTransportKind {
	if (typeof value !== "string") throw new McpConfigError("invalid_transport");
	const normalized = value.trim().toLowerCase().replaceAll("-", "_");
	if (normalized !== "stdio" && normalized !== "http" && normalized !== "streamable_http") {
		throw new McpConfigError("invalid_transport");
	}
	return normalized;
}

function optionalNonEmptyString(value: unknown, errorClass: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new McpConfigError(errorClass);
	return value.trim();
}

function stringArray(value: unknown): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new McpConfigError("invalid_args");
	}
	return value.map((item) => item);
}

function stringMap(
	value: unknown,
	env: Readonly<Record<string, string | undefined>>,
	environmentTable: boolean,
): Readonly<Record<string, string>> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new McpConfigError(environmentTable ? "invalid_env" : "invalid_headers");
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") {
			throw new McpConfigError(environmentTable ? "invalid_env" : "invalid_headers");
		}
		const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(item);
		if (match) {
			const resolved = env[match[1]!];
			if (resolved === undefined) throw new McpConfigError("missing_environment");
			result[key] = resolved;
		} else {
			result[key] = item;
		}
	}
	return result;
}

function booleanValue(value: unknown, fallback: boolean, errorClass = "invalid_enabled"): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new McpConfigError(errorClass);
	return value;
}

function timeoutValue(raw: Readonly<Record<string, unknown>>): number {
	const milliseconds = raw.timeout_ms;
	const seconds = raw.timeout_seconds;
	const value = milliseconds ?? (seconds === undefined ? DEFAULT_TIMEOUT_MS : Number(seconds) * 1_000);
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 300_000) {
		throw new McpConfigError("invalid_timeout");
	}
	return Math.round(value);
}

function validateUrl(value: string): void {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("unsupported protocol");
		}
	} catch {
		throw new McpConfigError("invalid_url");
	}
}

function recordValue(value: unknown, errorClass: string): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) throw new McpConfigError(errorClass);
	return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
	file: ConfigFile,
	serverId: string,
	errorClass: string,
): McpConfigDiagnostic {
	return Object.freeze({
		source: file.source,
		fileLabel: basename(file.path).slice(0, 128),
		serverId: boundedServerId(serverId),
		errorClass: errorClass.slice(0, 64),
	});
}

function boundedServerId(value: string): string {
	return value.trim().slice(0, 64) || "server";
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

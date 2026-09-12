import { open } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { McpConfigError, mcpExtendedConfig } from "./config-options.ts";
export { McpConfigError } from "./config-options.ts";
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
	readonly includeRepository?: boolean;
}

interface ConfigFile {
	readonly path: string;
	readonly source: McpConfigSource;
}

const ROOT_ALIASES = ["servers", "mcp_servers", "mcpServers"] as const;
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

export async function discoverMcpConfig(
	options: DiscoverMcpConfigOptions,
): Promise<McpConfigDiscovery> {
	const files: readonly ConfigFile[] = [
		{ path: join(options.homeDir, ".mycli", "mcp_servers.toml"), source: "user" },
		...(options.includeRepository === false
			? []
			: [{
				path: join(options.workspaceRoot, ".mycli", "mcp_servers.toml"),
				source: "repository" as const,
			}]),
	];
	const servers = new Map<string, McpServerConfig>();
	const diagnostics: McpConfigDiagnostic[] = [];

	for (const file of files) {
		const parsed = await readConfigFile(file, options.env, diagnostics);
		for (const [id, server] of parsed) servers.set(id, Object.freeze({ ...server, source: file.source,
			...(server.cwd || server.transport === "stdio" ? { cwd: resolve(options.workspaceRoot, server.cwd ?? ".") } : {}) }));
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
		raw = await readConfigText(file.path);
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
			parsed.set(id, parseMcpServerConfig(id, row, env));
		} catch (error) {
			diagnostics.push({ ...issue(
				file,
				boundedServerId(id),
				error instanceof McpConfigError ? error.errorClass : "invalid_server",
			), ...(row.required === true && row.enabled !== false ? { required: true } : {}) });
		}
	}
	return parsed;
}

export function parseMcpServerConfig(
	id: string,
	raw: Readonly<Record<string, unknown>>,
	env: Readonly<Record<string, string | undefined>>,
): McpServerConfig {
	if (!SERVER_ID.test(id)) throw new McpConfigError("invalid_server_id");
	const transport = transportValue(raw.transport ?? raw.type ?? (raw.url ? "streamable_http" : "stdio"));
	const command = optionalNonEmptyString(raw.command, "invalid_command");
	const url = optionalNonEmptyString(raw.url, "invalid_url");
	if (transport === "stdio" && !command) throw new McpConfigError("missing_command");
	if (transport !== "stdio" && !url) throw new McpConfigError("missing_url");
	if (url) validateUrl(url);
	if (raw.oauth !== undefined && transport !== "streamable_http") throw new McpConfigError("invalid_mcp_oauth_transport");

	return Object.freeze({
		id,
		transport,
		...mcpExtendedConfig(raw),
		...(command ? { command } : {}),
		...(url ? { url } : {}),
		args: Object.freeze(stringArray(raw.args)),
		env: mcpEnvironment(raw, env),
		headers: mcpHeaders(raw, env),
		enabled: booleanValue(raw.enabled, true),
		supportsParallelToolCalls: booleanValue(
			raw.supports_parallel_tool_calls,
			false,
			"invalid_parallel_tool_calls",
		),
		timeoutMs: timeoutValue(raw),
	});
}

function mcpEnvironment(raw: Readonly<Record<string, unknown>>, env: Readonly<NodeJS.ProcessEnv>): Readonly<Record<string, string>> {
	const values = Object.fromEntries(stringArray(raw.env_vars).map((key) => [key, environmentValue(key, env)]));
	return Object.freeze({ ...values, ...stringMap(raw.env, env, true) });
}

function mcpHeaders(raw: Readonly<Record<string, unknown>>, env: Readonly<NodeJS.ProcessEnv>): Readonly<Record<string, string>> {
	const entries = new Map<string, readonly [string, string]>();
	const set = (name: string, value: string): void => { entries.set(name.toLowerCase(), [name, value]); };
	for (const table of [raw.http_headers, raw.headers]) {
		for (const [name, value] of Object.entries(stringMap(table, env, false))) set(name, value);
	}
	for (const [name, key] of Object.entries(stringMap(raw.env_http_headers, {}, false))) set(name, environmentValue(key, env));
	if (raw.bearer_token_env_var !== undefined) {
		if (typeof raw.bearer_token_env_var !== "string") throw new McpConfigError("invalid_env");
		set("Authorization", `Bearer ${environmentValue(raw.bearer_token_env_var, env)}`);
	}
	const headers = Object.fromEntries(entries.values());
	try { new Headers(headers); } catch { throw new McpConfigError("invalid_headers"); }
	return Object.freeze(headers);
}

function environmentValue(key: string, env: Readonly<NodeJS.ProcessEnv>): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key)) throw new McpConfigError("invalid_env");
	const value = env[key];
	if (value === undefined) throw new McpConfigError("missing_environment");
	if (value.length > 32_768 || value.includes("\0")) throw new McpConfigError("invalid_env");
	return value;
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
	if (typeof value !== "string" || !value.trim() || value.length > 16_384 || value.includes("\0")) throw new McpConfigError(errorClass);
	return value.trim();
}

function stringArray(value: unknown): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 512 || value.some((item) => typeof item !== "string" || item.length > 16_384 || item.includes("\0"))) {
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
	const entries = Object.entries(value);
	const errorClass = environmentTable ? "invalid_env" : "invalid_headers";
	if (entries.length > 128) throw new McpConfigError(errorClass);
	const result = Object.fromEntries(entries.map(([key, item]) => {
		if (typeof item !== "string" || !key || key.length > 128
			|| environmentTable && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new McpConfigError(errorClass);
		const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(item);
		const resolved = match ? environmentValue(match[1]!, env) : item;
		if (resolved.length > 32_768 || resolved.includes("\0")) throw new McpConfigError(errorClass);
		return [key, resolved];
	}));
	if (Buffer.byteLength(JSON.stringify(result)) > 131_072) throw new McpConfigError(errorClass);
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

async function readConfigText(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const limit = 1_048_576;
		const info = await handle.stat();
		if (!info.isFile() || info.size > limit) throw new McpConfigError("mcp_config_too_large");
		const buffer = Buffer.alloc(limit + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (size > limit) throw new McpConfigError("mcp_config_too_large");
		return buffer.subarray(0, size).toString("utf8");
	} finally { await handle.close(); }
}

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateFileUpdate } from "@mycli/config";
import { parse, stringify } from "smol-toml";
import { McpConfigError, parseMcpServerConfig } from "./config.ts";

const CONFIG_FILE = "mcp_servers.toml";
const MAX_CONFIG_BYTES = 1_048_576;
const ROOT_ALIASES = ["servers", "mcp_servers", "mcpServers"] as const;

export class McpConfigStore {
	readonly #directory: string;
	readonly #env: Readonly<NodeJS.ProcessEnv>;
	constructor(options: { readonly homeDir: string; readonly env: Readonly<NodeJS.ProcessEnv> }) {
		this.#directory = join(options.homeDir, ".mycli");
		this.#env = options.env;
	}

	async add(serverId: string, config: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<boolean> {
		const definition = structuredClone(config);
		parseMcpServerConfig(serverId, definition, this.#env);
		return this.#update(signal, (document) => {
			if (serverTables(document).some((table) => Object.hasOwn(table, serverId))) throw new McpConfigError("mcp_server_exists");
			const key = ROOT_ALIASES.find((alias) => document[alias] !== undefined) ?? "servers";
			const table = document[key] ??= {};
			if (!record(table)) throw new McpConfigError("invalid_servers");
			Object.defineProperty(table, serverId, { value: definition, enumerable: true, writable: true, configurable: true });
			return true;
		});
	}

	async remove(serverId: string, signal: AbortSignal): Promise<boolean> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(serverId)) throw new McpConfigError("invalid_server_id");
		return this.#update(signal, (document) => {
			let changed = false;
			for (const table of serverTables(document)) {
				if (Object.hasOwn(table, serverId)) { delete table[serverId]; changed = true; }
			}
			return changed;
		});
	}

	async #update(signal: AbortSignal, edit: (document: Record<string, unknown>) => boolean): Promise<boolean> {
		try {
			return await atomicPrivateFileUpdate({ directory: this.#directory, fileName: CONFIG_FILE,
				maxCurrentBytes: MAX_CONFIG_BYTES, signal, buildContent: async (current) => {
					// The writer represents both missing and oversized files as undefined; never replace an oversized file.
					if (current === undefined && await stat(join(this.#directory, CONFIG_FILE)).then(() => true, (error: unknown) => {
						if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
						throw error;
					})) throw new McpConfigError("mcp_config_too_large");
					const document: unknown = current === undefined ? {} : parse(current);
					if (!record(document)) throw new McpConfigError("invalid_toml");
					serverTables(document);
					if (!edit(document)) return undefined;
					const content = `${stringify(document)}\n`;
					if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) throw new McpConfigError("mcp_config_too_large");
					return content;
				} });
		} catch (error) {
			if (signal.aborted || error instanceof McpConfigError) throw error;
			throw new McpConfigError("mcp_config_write_failed");
		}
	}
}

function serverTables(document: Record<string, unknown>): readonly Record<string, unknown>[] {
	return ROOT_ALIASES.flatMap((key) => {
		const value = document[key];
		if (value === undefined) return [];
		if (!record(value)) throw new McpConfigError("invalid_servers");
		return [value];
	});
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

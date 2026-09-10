import { createIntegrationId } from "../foundation/ids.ts";
import { deepFreezeCopy } from "./deep-freeze-copy.ts";
import { PluginHostError } from "./process-host.ts";
import type {
	PluginHostContract,
	PluginProtocolRegistration,
} from "./types.ts";

type PluginCommandRegistration = Extract<PluginProtocolRegistration, { readonly kind: "command" }>;

export interface PluginCommandDescriptor {
	readonly id: string;
	readonly pluginId: string;
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface PluginCommandResult {
	readonly ok: boolean;
	readonly summary: string;
	readonly content?: readonly unknown[];
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly error?: string;
}

interface RegisteredCommand {
	readonly descriptor: PluginCommandDescriptor;
	readonly host: PluginHostContract;
	readonly token: string;
}

const SUMMARY_LIMIT = 200;
const CONTENT_ITEMS_LIMIT = 32;
const CONTENT_CHARS_LIMIT = 16_000;
const METADATA_CHARS_LIMIT = 8_000;
const SENSITIVE_TEXT = /\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*\S+)/iu;

export class PluginCommandRegistry {
	readonly #commands = new Map<string, RegisteredCommand>();

	register(
		host: PluginHostContract,
		pluginId: string,
		registration: PluginCommandRegistration,
	): string {
		return this.registerAll(host, pluginId, [registration])[0]!;
	}

	registerAll(
		host: PluginHostContract,
		pluginId: string,
		registrations: readonly PluginCommandRegistration[],
	): readonly string[] {
		const commands = registrations.map((registration): RegisteredCommand => {
			const id = createIntegrationId("plugin", pluginId, registration.name);
			const descriptor = Object.freeze({
				id,
				pluginId,
				name: registration.name,
				description: registration.description,
				inputSchema: deepFreezeCopy(registration.input_schema),
			});
			return Object.freeze({ descriptor, host, token: registration.token });
		});
		const ids = commands.map((command) => command.descriptor.id);
		if (new Set(ids).size !== ids.length || ids.some((id) => this.#commands.has(id))) {
			throw new Error("duplicate_plugin_command");
		}
		for (const command of commands) this.#commands.set(command.descriptor.id, command);
		return Object.freeze(ids);
	}

	list(pluginId?: string): readonly PluginCommandDescriptor[] {
		return Object.freeze([...this.#commands.values()]
			.filter((command) => pluginId === undefined || command.descriptor.pluginId === pluginId)
			.map((command) => command.descriptor)
			.sort((left, right) => compareText(left.id, right.id)));
	}

	async execute(
		pluginId: string,
		name: string,
		argumentsValue: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<PluginCommandResult> {
		assertNotAborted(signal);
		const id = commandId(pluginId, name);
		const command = id ? this.#commands.get(id) : undefined;
		if (!command) return failure("plugin command not found", "command_not_found", pluginId, name);
		try {
			const response = await command.host.invoke(command.token, argumentsValue, signal);
			if (response.resultType !== "command_result") {
				return failure("plugin command failed", "protocol_invalid", pluginId, name);
			}
			return commandResult(response.value, pluginId, name);
		} catch (error) {
			if (signal.aborted || isAbortError(error)) throw error;
			return failure(
				"plugin command failed",
				error instanceof PluginHostError ? error.kind : "plugin_error",
				pluginId,
				name,
			);
		}
	}
}

function commandResult(
	value: Readonly<Record<string, unknown>>,
	pluginId: string,
	name: string,
): PluginCommandResult {
	const error = safeError(value.error);
	const ok = typeof value.ok === "boolean" ? value.ok : error === undefined;
	const summary = safeText(value.summary, ok ? "plugin command completed" : "plugin command failed");
	const content = boundedContent(value.content);
	return Object.freeze({
		ok,
		summary,
		...(content.length > 0 ? { content } : {}),
		metadata: boundedMetadata(value.metadata, pluginId, name),
		...(error ? { error } : !ok ? { error: "plugin_command_error" } : {}),
	});
}

function failure(summary: string, error: string, pluginId: string, name: string): PluginCommandResult {
	return Object.freeze({
		ok: false,
		summary,
		metadata: Object.freeze({ pluginId: safeId(pluginId), command: safeId(name) }),
		error: safeError(error) ?? "plugin_error",
	});
}

function boundedContent(value: unknown): readonly unknown[] {
	if (!Array.isArray(value)) return Object.freeze([]);
	const items: unknown[] = [];
	let remaining = CONTENT_CHARS_LIMIT;
	for (const item of value.slice(0, CONTENT_ITEMS_LIMIT)) {
		const bounded = boundValue(item, 0);
		let size: number;
		try {
			size = JSON.stringify(bounded).length;
		} catch {
			continue;
		}
		if (size > remaining) break;
		items.push(bounded);
		remaining -= size;
	}
	return Object.freeze(items);
}

function boundedMetadata(value: unknown, pluginId: string, name: string): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) return Object.freeze({ pluginId: safeId(pluginId), command: safeId(name) });
	const bounded = deepFreezeCopy(Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, item]) => [
		key.slice(0, 64),
		boundValue(item, 0),
	])));
	try {
		if (JSON.stringify(bounded).length <= METADATA_CHARS_LIMIT) return bounded;
	} catch {
		// Fall through to safe identity metadata.
	}
	return Object.freeze({ pluginId: safeId(pluginId), command: safeId(name), truncated: true });
}

function boundValue(value: unknown, depth: number): unknown {
	if (depth >= 4) return "[truncated]";
	if (typeof value === "string") return safeText(value, "").slice(0, 2_000);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return Object.freeze(value.slice(0, 32).map((item) => boundValue(item, depth + 1)));
	if (isRecord(value)) return Object.freeze(Object.fromEntries(
		Object.entries(value).slice(0, 32).map(([key, item]) => [key.slice(0, 64), boundValue(item, depth + 1)]),
	));
	return String(value).slice(0, 200);
}

function safeText(value: unknown, fallback: string): string {
	const text = typeof value === "string" && value.trim() ? value.replace(/\s+/gu, " ").trim() : fallback;
	return (SENSITIVE_TEXT.test(text) ? "redacted" : text).slice(0, SUMMARY_LIMIT);
}

function safeError(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(value)
		? value.toLowerCase()
		: undefined;
}

function safeId(value: string): string {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value) ? value : "plugin";
}

function commandId(pluginId: string, name: string): string | undefined {
	try {
		return createIntegrationId("plugin", pluginId, name);
	} catch {
		return undefined;
	}
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNotAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const error = new Error("interrupted");
	error.name = "AbortError";
	throw error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

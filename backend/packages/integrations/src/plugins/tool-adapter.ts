import type { ToolDefinition } from "@mycli/core";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "@mycli/tools";
import { createIntegrationId, providerSafeToolName } from "../foundation/ids.ts";
import { defineIntegrationRegistration } from "../foundation/registration.ts";
import type { IntegrationRegistration } from "../foundation/registration.ts";
import { PluginHostError } from "./process-host.ts";
import type {
	PluginHostContract,
	PluginProtocolRegistration,
} from "./types.ts";

type PluginToolRegistration = Extract<PluginProtocolRegistration, { readonly kind: "tool" }>;

const MODEL_OUTPUT_LIMIT = 4_000;
const SUMMARY_LIMIT = 200;
const METADATA_LIMIT = 12_000;

class PluginTool implements ToolAdapter {
	readonly definition: ToolDefinition;
	readonly #host: PluginHostContract;
	readonly #registration: PluginToolRegistration;

	constructor(
		host: PluginHostContract,
		registration: PluginToolRegistration,
		definition: ToolDefinition,
	) {
		this.#host = host;
		this.#registration = registration;
		this.definition = definition;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		assertNotAborted(options.signal);
		try {
			const result = await this.#host.invoke(
				this.#registration.token,
				argumentsValue,
				options.signal,
			);
			if (result.resultType !== "tool_result") return failedResult("protocol_invalid", this.definition.name);
			const success = result.value.success === true;
			const summary = safeText(result.value.summary, success ? "plugin tool completed" : "plugin tool failed", SUMMARY_LIMIT);
			const modelOutput = safeText(
				result.value.modelOutput ?? result.value.model_output,
				success ? "Plugin tool returned no content." : "Plugin tool failed.",
				MODEL_OUTPUT_LIMIT,
			);
			const errorKind = safeErrorKind(result.value.errorKind ?? result.value.error_kind ?? result.value.error);
			return Object.freeze({
				success,
				modelOutput,
				summary,
				...(!success ? { errorKind: errorKind ?? "plugin_tool_error" } : {}),
				metadata: boundedMetadata(result.value.metadata),
			});
		} catch (error) {
			if (options.signal.aborted || isAbortError(error)) throw error;
			return failedResult(error instanceof PluginHostError ? error.kind : "plugin_error", this.definition.name);
		}
	}
}

export function createPluginToolRegistration(
	host: PluginHostContract,
	pluginId: string,
	registration: PluginToolRegistration,
): IntegrationRegistration {
	const id = createIntegrationId("plugin", pluginId, registration.name);
	const definition: ToolDefinition = Object.freeze({
		id,
		name: providerSafeToolName("plugin", pluginId, registration.name),
		description: registration.description || `Plugin tool ${registration.name}`,
		inputSchema: registration.input_schema,
	});
	const adapter = new PluginTool(host, registration, definition);
	return defineIntegrationRegistration({
		id,
		source: "plugin",
		definition,
		adapter,
		originMetadata: { plugin: pluginId, tool: registration.name },
	});
}

function failedResult(kind: string, name: string): ToolAdapterResult {
	const errorKind = safeErrorKind(kind) ?? "plugin_error";
	return Object.freeze({
		success: false,
		modelOutput: `Plugin tool failed.\nError kind: ${errorKind}`,
		summary: `Plugin ${name} failed`,
		errorKind,
		metadata: Object.freeze({}),
	});
}

function boundedMetadata(value: unknown): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) return Object.freeze({});
	try {
		if (JSON.stringify(value).length <= METADATA_LIMIT) return deepFreezeCopy(value);
	} catch {
		// Fall through to a bounded marker.
	}
	return Object.freeze({ truncated: true });
}

function safeText(value: unknown, fallback: string, maximum: number): string {
	const text = typeof value === "string" ? value : "";
	const normalized = text.trim();
	return (normalized || fallback).slice(0, maximum);
}

function safeErrorKind(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : undefined;
}

function deepFreezeCopy<Value>(value: Value): Value {
	if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy)) as Value;
	if (!isRecord(value)) return value;
	return Object.freeze(Object.fromEntries(
		Object.entries(value).map(([key, child]) => [key, deepFreezeCopy(child)]),
	)) as Value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}

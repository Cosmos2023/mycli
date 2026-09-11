import type { ToolDefinition } from "@mycli/core";
import { failureScope } from "@mycli/contracts";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "@mycli/tools";
import { createIntegrationId, providerSafeToolName } from "../foundation/ids.ts";
import { defineIntegrationRegistration } from "../foundation/registration.ts";
import type { IntegrationRegistration } from "../foundation/registration.ts";
import { deepFreezeCopy } from "./deep-freeze-copy.ts";
import { pluginRouteNamespace } from "./package-files.ts";
import { PluginHostError } from "./process-host.ts";
import { pluginFailureContext, pluginFailureText } from "./diagnostics.ts";
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
	readonly #pluginId: string;

	constructor(
		host: PluginHostContract,
		registration: PluginToolRegistration,
		definition: ToolDefinition,
		pluginId: string,
	) {
		this.#host = host;
		this.#registration = registration;
		this.definition = definition;
		this.#pluginId = pluginId;
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
			if (result.resultType !== "tool_result") throw new PluginHostError("protocol_invalid");
			const success = result.value.success === true;
			const summary = safeText(result.value.summary, success ? "plugin tool completed" : "plugin tool failed", SUMMARY_LIMIT);
			const modelOutput = safeText(
				result.value.modelOutput ?? result.value.model_output,
				success ? "Plugin tool returned no content." : "Plugin tool failed.",
				MODEL_OUTPUT_LIMIT,
			);
			const errorKind = safeErrorKind(result.value.errorKind ?? result.value.error_kind ?? result.value.error);
			const errorContext = !success && options.errorContextVersion === 1 ? pluginFailureContext(new PluginHostError("handler_failed"), {
				pluginId: this.#pluginId, operation: "tools/call", scope: failureScope("tool_call", options.callId),
			}) : undefined;
			return Object.freeze({
				success,
				modelOutput,
				summary,
				...(!success ? { errorKind: errorKind ?? "plugin_tool_error" } : {}),
				...(errorContext ? { errorContext } : {}),
				metadata: Object.freeze({ ...boundedMetadata(result.value.metadata), ...(errorContext ? { error_context: errorContext } : {}) }),
			});
		} catch (error) {
			if (options.signal.aborted || isAbortError(error)) throw error;
			const errorContext = pluginFailureContext(error, { pluginId: this.#pluginId, operation: "tools/call", scope: failureScope("tool_call", options.callId) });
			return Object.freeze({ success: false, modelOutput: pluginFailureText(errorContext), summary: `Plugin ${this.definition.name} failed`,
				errorKind: `plugin_${error instanceof PluginHostError ? error.kind : "error"}`,
				...(options.errorContextVersion === 1 ? { errorContext, metadata: { error_context: errorContext } } : { metadata: {} }),
			});
		}
	}
}

export function createPluginToolRegistration(
	host: PluginHostContract,
	pluginId: string,
	registration: PluginToolRegistration,
	sourceDescription?: string,
): IntegrationRegistration {
	const owner = pluginRouteNamespace(pluginId);
	const id = createIntegrationId("plugin", owner, registration.name);
	const definition: ToolDefinition = Object.freeze({
		id,
		name: providerSafeToolName("plugin", owner, registration.name),
		description: registration.description || `Plugin tool ${registration.name}`,
		inputSchema: registration.input_schema,
	});
	const adapter = new PluginTool(host, registration, definition, pluginId);
	return defineIntegrationRegistration({
		id,
		source: "plugin",
		definition,
		adapter,
		originMetadata: { plugin: pluginId, tool: registration.name },
		...(sourceDescription ? { sourceDescription: sourceDescription.replace(/\s+/gu, " ").trim().slice(0, 1_024) } : {}),
	});
}

function boundedMetadata(value: unknown): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) return Object.freeze({});
	try {
		const metadata = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "error_context"));
		if (JSON.stringify(metadata).length <= METADATA_LIMIT) return deepFreezeCopy(metadata);
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

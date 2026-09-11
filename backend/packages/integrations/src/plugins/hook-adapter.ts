import type { HookInvocation, HookResult } from "@mycli/core";
import { failureScope } from "@mycli/contracts";
import type { HookRegistration } from "../hooks/manager.ts";
import { createIntegrationId } from "../foundation/ids.ts";
import { deepFreezeCopy } from "./deep-freeze-copy.ts";
import { pluginRouteNamespace } from "./package-files.ts";
import { PluginHostError } from "./process-host.ts";
import { pluginFailureContext, pluginFailureText } from "./diagnostics.ts";
import type {
	PluginHostContract,
	PluginProtocolRegistration,
} from "./types.ts";

type PluginHookRegistration = Extract<PluginProtocolRegistration, { readonly kind: "hook" }>;

const MAX_CONTEXTS = 8;
const MAX_CONTEXT_CHARS = 2_000;
const MAX_TOTAL_CONTEXT_CHARS = 4_000;
const MAX_MESSAGE_CHARS = 200;
const MAX_ARGUMENT_CHARS = 32_768;
const SENSITIVE_TEXT = /\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*\S+)/iu;

export function createPluginHookRegistration(
	host: PluginHostContract,
	pluginId: string,
	registration: PluginHookRegistration,
): HookRegistration {
	return Object.freeze({
		id: createIntegrationId("plugin", pluginRouteNamespace(pluginId), registration.name),
		hookPoint: registration.hook_point,
		handler: async (input: HookInvocation, signal: AbortSignal) => {
			try {
				const response = await host.invoke(registration.token, hookPayload(input), signal);
				if (response.resultType !== "hook_result") throw new PluginHostError("protocol_invalid");
				const result = normalizeHookResult(response.value);
				if (result.action !== "error") return result;
				return Object.freeze({ ...result, errorContext: pluginFailureContext(new PluginHostError("handler_failed"), {
					pluginId, operation: "hooks/run",
					scope: failureScope("request", `hook:${input.metadata.callId ?? input.turnId}:${pluginId}:${registration.name}`),
				}) });
			} catch (error) {
				if (signal.aborted || isAbortError(error)) throw error;
				const errorContext = pluginFailureContext(error, { pluginId, operation: "hooks/run",
					scope: failureScope("request", `hook:${input.metadata.callId ?? input.turnId}:${pluginId}:${registration.name}`) });
				return Object.freeze({ action: "error", message: pluginFailureText(errorContext), errorContext });
			}
		},
	});
}

function hookPayload(input: HookInvocation): Readonly<Record<string, unknown>> {
	return Object.freeze({
		point: input.point,
		sessionId: input.sessionId,
		turnId: input.turnId,
		toolName: input.toolName ?? null,
		arguments: Object.freeze({ ...(input.arguments ?? {}) }),
		metadata: Object.freeze({ ...input.metadata }),
	});
}

function normalizeHookResult(value: Readonly<Record<string, unknown>>): HookResult {
	if (value.action === "allow") {
		const contexts = boundedContexts(value.additionalContexts ?? value.additional_contexts);
		return contexts.length > 0
			? Object.freeze({ action: "allow", additionalContexts: contexts })
			: Object.freeze({ action: "allow" });
	}
	if (value.action === "deny" || value.action === "error") {
		const message = safeMessage(value.message, value.action === "deny" ? "blocked by plugin hook" : "plugin hook failed");
		return Object.freeze({ action: value.action, message });
	}
	if (value.action === "modify") {
		const argumentsValue = value.arguments ?? value.modified_args;
		if (!isRecord(argumentsValue) || !boundedJson(argumentsValue)) {
			return errorResult("plugin hook result invalid");
		}
		return Object.freeze({ action: "modify", arguments: deepFreezeCopy(argumentsValue) });
	}
	return errorResult("plugin hook result invalid");
}

function boundedContexts(value: unknown): readonly string[] {
	const source = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
	const contexts: string[] = [];
	let remaining = MAX_TOTAL_CONTEXT_CHARS;
	for (const item of source) {
		if (typeof item !== "string" || contexts.length >= MAX_CONTEXTS || remaining <= 0) continue;
		const raw = item.trim();
		const text = (SENSITIVE_TEXT.test(raw) ? "redacted" : raw)
			.slice(0, Math.min(MAX_CONTEXT_CHARS, remaining));
		if (!text) continue;
		contexts.push(text);
		remaining -= text.length;
	}
	return Object.freeze(contexts);
}

function boundedJson(value: Readonly<Record<string, unknown>>): boolean {
	try {
		return JSON.stringify(value).length <= MAX_ARGUMENT_CHARS;
	} catch {
		return false;
	}
}

function safeMessage(value: unknown, fallback: string): string {
	const text = typeof value === "string" && value.trim() ? value.replace(/\s+/gu, " ").trim() : fallback;
	return (SENSITIVE_TEXT.test(text) ? "redacted" : text).slice(0, MAX_MESSAGE_CHARS);
}

function errorResult(message: string): HookResult {
	return Object.freeze({ action: "error", message });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

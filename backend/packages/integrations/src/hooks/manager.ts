import type {
	HookExecution,
	HookInvocation,
	HookPoint,
	HookResult,
	HookRunnerContract,
} from "@mycli/core";
import { readErrorContext } from "@mycli/contracts";
import { configuredHookMatches } from "./config.ts";
import type {
	ConfiguredHookExecutorContract,
	ConfiguredHookSpec,
} from "./types.ts";

export interface HookRegistration {
	readonly origin?: { readonly pluginId: string; readonly path: string; readonly command?: readonly string[]; readonly enabled?: boolean };
	readonly id: string;
	readonly hookPoint: HookPoint;
	readonly handler: (
		input: HookInvocation,
		signal: AbortSignal,
	) => Promise<HookResult>;
}

export interface HookManagerOptions {
	readonly builtInHooks?: readonly HookRegistration[];
	readonly configuredHooks?: readonly ConfiguredHookSpec[];
	readonly configuredExecutor?: ConfiguredHookExecutorContract;
	readonly pluginHooks?: readonly HookRegistration[];
}

interface RunnableHook {
	readonly id: string;
	readonly run: HookRegistration["handler"];
}

const HOOK_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const MAX_MODIFIED_ARGUMENTS = 20;
const MAX_MODIFIED_ARGUMENT_CHARS = 32_768;
const MAX_CONTEXTS = 8;
const MAX_CONTEXT_CHARS = 2_000;
const MAX_TOTAL_CONTEXT_CHARS = 4_000;
const MAX_MESSAGE_CHARS = 200;
const SENSITIVE_TEXT = /\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*\S+)/iu;
const STOP_ON_FAILURE_POINTS = new Set<HookPoint>([
	"pre_tool_use",
	"user_prompt_submit",
	"stop",
	"pre_compact",
	"session_start",
]);

export class HookManager implements HookRunnerContract {
	readonly #builtInHooks: readonly HookRegistration[];
	readonly #configuredHooks: readonly ConfiguredHookSpec[];
	readonly #configuredExecutor?: ConfiguredHookExecutorContract;
	readonly #pluginHooks: readonly HookRegistration[];

	constructor(options: HookManagerOptions = {}) {
		this.#builtInHooks = validatedRegistrations(options.builtInHooks ?? []);
		this.#configuredHooks = Object.freeze([...(options.configuredHooks ?? [])]);
		this.#configuredExecutor = options.configuredExecutor;
		this.#pluginHooks = validatedRegistrations(options.pluginHooks ?? []);
		if (this.#configuredHooks.length > 0 && !this.#configuredExecutor) {
			throw new TypeError("configuredExecutor is required for configured hooks");
		}
		const ids = [
			...this.#builtInHooks.map((hook) => hook.id),
			...this.#configuredHooks.map((hook) => hook.name),
			...this.#pluginHooks.map((hook) => hook.id),
		];
		if (new Set(ids).size !== ids.length) throw new TypeError("duplicate hook registration id");
	}

	async run(
		input: HookInvocation,
		signal: AbortSignal,
	): Promise<readonly HookExecution[]> {
		assertNotAborted(signal);
		const hooks = this.#hooksFor(input);
		const executions: HookExecution[] = [];
		let currentArguments = Object.freeze({ ...(input.arguments ?? {}) });
		let remainingContexts = MAX_CONTEXTS;
		let remainingContextChars = MAX_TOTAL_CONTEXT_CHARS;

		for (const hook of hooks) {
			assertNotAborted(signal);
			const currentInput = Object.freeze({
				...input,
				arguments: currentArguments,
			});
			let rawResult: unknown;
			try {
				rawResult = await hook.run(currentInput, signal);
				assertNotAborted(signal);
			} catch (error) {
				if (signal.aborted || isAbortError(error)) throw error;
				rawResult = Object.freeze({ action: "error", message: "hook execution failed" });
			}
			const bounded = boundResult(rawResult, remainingContexts, remainingContextChars);
			const result = bounded.result;
			remainingContexts -= bounded.contextCount;
			remainingContextChars -= bounded.contextChars;
			executions.push(Object.freeze({ hookId: hook.id, result }));
			if (result.action === "modify") {
				currentArguments = Object.freeze({ ...currentArguments, ...result.arguments });
			}
			if ((result.action === "deny" || result.action === "error")
				&& STOP_ON_FAILURE_POINTS.has(input.point)) {
				break;
			}
		}
		return Object.freeze(executions);
	}

	#hooksFor(input: HookInvocation): readonly RunnableHook[] {
		const builtIn = this.#builtInHooks
			.filter((hook) => hook.hookPoint === input.point)
			.map((hook) => ({ id: hook.id, run: hook.handler }));
		const configured = this.#configuredHooks
			.filter((hook) => (
				hook.enabled
				&& hook.hookPoint === input.point
				&& configuredHookMatches(hook, {
					...(input.toolName ? { toolName: input.toolName } : {}),
					...(typeof input.metadata.source === "string"
						? { source: input.metadata.source }
						: {}),
				})
			))
			.map((hook): RunnableHook => ({
				id: hook.name,
				run: (invocation, signal) => this.#configuredExecutor!.run(hook, invocation, signal),
			}));
		const plugin = this.#pluginHooks
			.filter((hook) => hook.hookPoint === input.point)
			.map((hook) => ({ id: hook.id, run: hook.handler }));
		return Object.freeze([...builtIn, ...configured, ...plugin]);
	}
}

function validatedRegistrations(
	registrations: readonly HookRegistration[],
): readonly HookRegistration[] {
	const result = registrations.map((registration) => {
		if (!HOOK_ID.test(registration.id)) throw new TypeError("invalid hook registration id");
		if (typeof registration.handler !== "function") throw new TypeError("invalid hook handler");
		return Object.freeze({ ...registration });
	});
	return Object.freeze(result);
}

function boundResult(
	value: unknown,
	remainingContexts: number,
	remainingContextChars: number,
): {
	readonly result: HookResult;
	readonly contextCount: number;
	readonly contextChars: number;
} {
	if (!isRecord(value) || typeof value.action !== "string") {
		return boundedResult(
			Object.freeze({ action: "error", message: "hook result invalid" }),
		);
	}
	const result = value as Readonly<Record<string, unknown>>;
	if (result.action === "modify") {
		const entries = isRecord(result.arguments) ? Object.entries(result.arguments) : [];
		if (!isRecord(result.arguments)
			|| entries.length > MAX_MODIFIED_ARGUMENTS
			|| !boundedJson(result.arguments)) {
			return boundedResult(
				Object.freeze({ action: "error", message: "hook result exceeded limits" }),
			);
		}
		return boundedResult(Object.freeze({
			action: "modify",
			arguments: Object.freeze(Object.fromEntries(entries)),
		}));
	}
	if (result.action === "deny" || result.action === "error") {
		if (typeof result.message !== "string") {
			return boundedResult(
				Object.freeze({ action: "error", message: "hook result invalid" }),
			);
		}
		const errorContext = result.action === "error" ? readErrorContext(result.errorContext) : undefined;
		return boundedResult(Object.freeze({
			action: result.action,
			message: safeText(result.message, "hook execution failed", MAX_MESSAGE_CHARS),
			...(errorContext ? { errorContext } : {}),
		}));
	}
	if (result.action !== "allow"
		|| (result.additionalContexts !== undefined && !Array.isArray(result.additionalContexts))) {
		return boundedResult(
			Object.freeze({ action: "error", message: "hook result invalid" }),
		);
	}
	const contexts: string[] = [];
	let chars = 0;
	for (const contextValue of result.additionalContexts ?? []) {
		if (contexts.length >= remainingContexts || chars >= remainingContextChars) break;
		if (typeof contextValue !== "string") continue;
		const available = Math.min(MAX_CONTEXT_CHARS, remainingContextChars - chars);
		const context = safeContext(contextValue, available);
		if (!context) continue;
		contexts.push(context);
		chars += context.length;
	}
	return {
		result: contexts.length > 0
			? Object.freeze({ action: "allow", additionalContexts: Object.freeze(contexts) })
			: Object.freeze({ action: "allow" }),
		contextCount: contexts.length,
		contextChars: chars,
	};
}

function boundedResult(result: HookResult): {
	readonly result: HookResult;
	readonly contextCount: 0;
	readonly contextChars: 0;
} {
	return { result, contextCount: 0, contextChars: 0 };
}

function boundedJson(value: unknown): boolean {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string" && serialized.length <= MAX_MODIFIED_ARGUMENT_CHARS;
	} catch {
		return false;
	}
}

function safeText(value: string, fallback: string, maximum: number): string {
	const normalized = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
	if (!normalized) return fallback;
	return SENSITIVE_TEXT.test(normalized) ? "redacted" : normalized.slice(0, maximum);
}

function safeContext(value: string, maximum: number): string {
	const normalized = value.trim();
	if (!normalized) return "";
	return SENSITIVE_TEXT.test(normalized) ? "redacted" : normalized.slice(0, maximum);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNotAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	throw error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

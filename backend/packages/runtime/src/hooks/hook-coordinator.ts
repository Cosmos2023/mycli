import type {
	CanonicalToolCall,
	HookExecution,
	HookPoint,
	HookRunnerContract,
} from "@mycli/core";
import type { ToolExecutionResult } from "@mycli/tools";
import type { ErrorContext } from "@mycli/contracts";

export interface HookCoordinatorOptions {
	readonly runner: HookRunnerContract;
	readonly sessionId: string;
	readonly turnId: string;
}

export type BeforeToolHookResult =
	| {
		readonly status: "allow";
		readonly call: CanonicalToolCall;
		readonly contexts: readonly string[];
	}
	| {
		readonly status: "deny";
		readonly call: CanonicalToolCall;
		readonly errorKind: "tool_denied_by_hook" | "tool_hook_error";
		readonly message: string;
		readonly errorContext?: ErrorContext;
		readonly contexts: readonly string[];
	};

export interface AfterToolHookResult {
	readonly contexts: readonly string[];
	readonly failed: boolean;
	readonly errorContext?: ErrorContext;
}

export interface HookPointResult {
	readonly contexts: readonly string[];
	readonly failed: boolean;
	readonly denied: boolean;
	readonly message?: string;
	readonly errorContext?: ErrorContext;
}

export class HookCoordinator {
	readonly #runner: HookRunnerContract;
	readonly #sessionId: string;
	readonly #turnId: string;

	constructor(options: HookCoordinatorOptions) {
		this.#runner = options.runner;
		this.#sessionId = options.sessionId;
		this.#turnId = options.turnId;
	}

	async runPoint(
		point: Extract<HookPoint, "user_prompt_submit" | "stop">,
		metadata: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<HookPointResult> {
		let executions: readonly HookExecution[];
		try {
			executions = await this.#runner.run(this.#invocation(point, metadata), signal);
		} catch (error) {
			throwIfAborted(error, signal);
			return Object.freeze({
				contexts: Object.freeze([]),
				failed: true,
				denied: false,
			});
		}
		const contexts = hookContexts(executions);
		const blocked = executions.find((execution) =>
			execution.result.action === "deny" || execution.result.action === "error"
		);
		return Object.freeze({
			contexts,
			failed: executions.some((execution) => execution.result.action === "error"),
			denied: blocked?.result.action === "deny",
			...(blocked && "message" in blocked.result ? { message: blocked.result.message } : {}),
			...(blocked?.result.action === "error" && blocked.result.errorContext ? { errorContext: blocked.result.errorContext } : {}),
		});
	}

	async beforeTool(call: CanonicalToolCall, signal: AbortSignal): Promise<BeforeToolHookResult> {
		let executions: readonly HookExecution[];
		try {
			executions = await this.#runner.run(this.#invocation("pre_tool_use", {
				callId: call.callId,
		}, call), signal);
		} catch (error) {
			throwIfAborted(error, signal);
			return denied(call, "tool_hook_error", "hook execution failed", []);
		}
		const contexts: string[] = [];
		let argumentsValue = parseArguments(call.argumentsJson);
		let modified = false;
		for (const execution of executions) {
			const result = execution.result;
			if (result.action === "allow") {
				contexts.push(...(result.additionalContexts ?? []));
				continue;
			}
			if (result.action === "modify") {
				argumentsValue = { ...argumentsValue, ...result.arguments };
				modified = true;
				continue;
			}
			return denied(
				call,
				result.action === "deny" ? "tool_denied_by_hook" : "tool_hook_error",
				result.message,
				contexts,
				result.action === "error" ? result.errorContext : undefined,
			);
		}
		return Object.freeze({
			status: "allow",
			call: modified
				? Object.freeze({ ...call, argumentsJson: JSON.stringify(argumentsValue) })
				: call,
			contexts: uniqueContexts(contexts),
		});
	}

	async afterTool(
		call: CanonicalToolCall,
		result: ToolExecutionResult,
		signal: AbortSignal,
	): Promise<AfterToolHookResult> {
		let executions: readonly HookExecution[];
		try {
			executions = await this.#runner.run(this.#invocation("post_tool_use", {
				callId: call.callId,
				success: result.success,
				summary: result.summary.slice(0, 512),
				...(result.errorKind ? { errorKind: result.errorKind.slice(0, 128) } : {}),
			}, call), signal);
		} catch (error) {
			throwIfAborted(error, signal);
			return Object.freeze({ contexts: Object.freeze([]), failed: true });
		}
		const failure = executions.find((execution) => execution.result.action === "error" && execution.result.errorContext)?.result;
		return Object.freeze({
			contexts: hookContexts(executions),
			failed: executions.some((execution) =>
				execution.result.action === "deny" || execution.result.action === "error"
			),
			...(failure?.action === "error" && failure.errorContext ? { errorContext: failure.errorContext } : {}),
		});
	}

	#invocation(
		point: HookPoint,
		metadata: Readonly<Record<string, unknown>>,
		call?: CanonicalToolCall,
	) {
		return Object.freeze({
			point,
			sessionId: this.#sessionId,
			turnId: this.#turnId,
			...(call ? { toolName: call.name, arguments: parseArguments(call.argumentsJson) } : {}),
			metadata: Object.freeze({ ...metadata }),
		});
	}
}

function denied(
	call: CanonicalToolCall,
	errorKind: "tool_denied_by_hook" | "tool_hook_error",
	message: string,
	contexts: readonly string[],
	errorContext?: ErrorContext,
): BeforeToolHookResult {
	return Object.freeze({
		status: "deny",
		call,
		errorKind,
		message: message.slice(0, 512) || "hook blocked tool execution",
		...(errorContext ? { errorContext } : {}),
		contexts: uniqueContexts(contexts),
	});
}

function hookContexts(executions: readonly HookExecution[]): readonly string[] {
	return uniqueContexts(executions.flatMap((execution) =>
		execution.result.action === "allow"
			? execution.result.additionalContexts ?? []
			: []
	));
}

function uniqueContexts(contexts: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(contexts.map((context) => context.trim()).filter(Boolean))]);
}

function parseArguments(value: string): Readonly<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? parsed as Readonly<Record<string, unknown>>
			: Object.freeze({});
	} catch {
		return Object.freeze({});
	}
}

function throwIfAborted(error: unknown, signal: AbortSignal): void {
	if (!signal.aborted && (!(error instanceof Error) || error.name !== "AbortError")) return;
	throw error;
}

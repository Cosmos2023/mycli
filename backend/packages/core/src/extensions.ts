import type { ErrorContext } from "@mycli/contracts";

export type HookPoint =
	| "pre_tool_use"
	| "post_tool_use"
	| "user_prompt_submit"
	| "stop"
	| "pre_compact"
	| "session_start"
	| "session_end";

export type HookResult =
	| { readonly action: "allow"; readonly additionalContexts?: readonly string[] }
	| { readonly action: "deny"; readonly message: string }
	| { readonly action: "modify"; readonly arguments: Readonly<Record<string, unknown>> }
	| { readonly action: "error"; readonly message: string; readonly errorContext?: ErrorContext };

export interface HookInvocation {
	readonly point: HookPoint;
	readonly sessionId: string;
	readonly turnId: string;
	readonly toolName?: string;
	readonly arguments?: Readonly<Record<string, unknown>>;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export interface HookExecution {
	readonly hookId: string;
	readonly result: HookResult;
}

export interface HookRunnerContract {
	run(input: HookInvocation, signal: AbortSignal): Promise<readonly HookExecution[]>;
}

export type ChildTaskStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

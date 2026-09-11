import { errorSummary, type ErrorContext, type DiagnosticRecoveryActionId } from "@mycli/contracts";

interface HeadlessOptions {
	readonly json: boolean;
	readonly timeoutMs: number;
	readonly runtimeArgs: readonly string[];
	readonly outputLastMessage?: string;
}

interface ExecCommand extends HeadlessOptions {
	readonly kind: "exec";
	readonly prompt?: string;
	readonly outputSchema?: string;
}

export type ReviewTarget =
	| { readonly kind: "uncommitted" }
	| { readonly kind: "base" | "commit"; readonly ref: string };

interface ReviewCommand extends HeadlessOptions {
	readonly kind: "review";
	readonly target: ReviewTarget;
	readonly instructions?: string;
}

export type HeadlessCommand = ExecCommand | ReviewCommand;

export interface HeadlessResult {
	readonly message?: string;
	readonly additional_details?: string;
	readonly error_context?: ErrorContext;
	readonly recovery_actions?: readonly DiagnosticRecoveryActionId[];
	readonly status: "completed" | "failed" | "interaction_required" | "interrupted";
	readonly exit_code: number;
	readonly code?: string;
	readonly session_id?: string;
	readonly turn_id?: string;
	readonly final_message?: string;
	readonly usage?: Readonly<Record<string, number>>;
	readonly structured_output?: unknown;
}

export class HeadlessError extends Error {
	constructor(readonly code: string, readonly exitCode: number = 1, readonly errorContext?: ErrorContext) {
		super(errorContext ? errorSummary(errorContext) : code);
		this.name = "HeadlessError";
	}
}

import { createErrorContext, errorOccurrence, errorPublicDetails, errorSummary, failureScope,
	type ErrorContext, type FailureScope } from "@mycli/contracts";
import { PluginHostError } from "./process-host.ts";
import type { PluginHostFailure } from "./types.ts";

export type PluginOperation = "initialize" | "tools/call" | "hooks/run" | "commands/run" | "shutdown";

interface PluginFailureContextOptions {
	readonly pluginId: string;
	readonly operation: PluginOperation;
	readonly scope: Readonly<FailureScope>;
}

const PROTOCOL_FAILURES = new Set(["protocol_invalid", "registration_mismatch", "unknown_response_id", "stdout_limit_exceeded", "stderr_limit_exceeded"]);
const UNAVAILABLE_FAILURES = new Set(["call_timeout", "startup_timeout", "worker_exited", "host_closed", "spawn_failed", "missing_required_env", "sandbox_unavailable", "too_many_requests"]);
const NOT_STARTED_FAILURES = new Set(["unknown_target", "input_too_large", "too_many_requests", "spawn_failed", "missing_required_env", "sandbox_unavailable"]);
const TRANSPORT_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EPIPE", "EMFILE", "ENFILE", "ENOMEM"]);
const SIGNALS = new Set(["SIGTERM", "SIGINT", "SIGKILL", "SIGSEGV", "SIGABRT", "SIGBUS", "SIGHUP", "SIGPIPE", "SIGILL", "SIGTRAP"]);

export function pluginFailureContext(error: unknown, options: PluginFailureContextOptions): ErrorContext {
	const failure = error instanceof PluginHostError ? error : new PluginHostError("plugin_error");
	return contextForFailure(failure, options, true);
}

export function pluginFailureText(context: ErrorContext): string {
	return [errorSummary(context), errorPublicDetails(context)].filter(Boolean).join("\n");
}

function contextForFailure(failure: PluginHostFailure, options: PluginFailureContextOptions, includeCause: boolean): ErrorContext {
	const { kind, evidence } = failure;
	const phase = evidence.phase ?? "request";
	const notStarted = phase === "connect" || phase === "reconnect" || evidence.dispatched === false || NOT_STARTED_FAILURES.has(kind);
	return createErrorContext({
		reason: PROTOCOL_FAILURES.has(kind) ? "integration.protocol_invalid"
			: UNAVAILABLE_FAILURES.has(kind) ? "integration.unavailable" : "integration.failure_unclassified",
		source: "integration", scope: options.scope,
		outcome: notStarted ? { state: "not_started", effects: "none" }
			: { state: kind === "handler_failed" ? "failed" : "unknown", effects: "possible" },
		details: { integration: options.pluginId, legacy_kind: `plugin_${kind}`,
			operation: phase === "connect" || phase === "reconnect" ? "initialize" : phase === "shutdown" ? "shutdown" : options.operation,
			phase,
			...(evidence.timeoutMs === undefined ? {} : { timeout_ms: evidence.timeoutMs }),
			...(evidence.exitCode === undefined ? {} : { exit_code: evidence.exitCode }),
			...(evidence.signal && SIGNALS.has(evidence.signal) ? { signal: evidence.signal } : {}),
			...(evidence.transportCode && TRANSPORT_CODES.has(evidence.transportCode) ? { transport_code: evidence.transportCode } : {}),
			...(evidence.recoveryAttempts ? { recovery_attempts: evidence.recoveryAttempts } : {}),
		},
		...(includeCause && evidence.previous ? { causes: [errorOccurrence(contextForFailure(evidence.previous, {
			...options, scope: failureScope("connection", `plugin:${options.pluginId}`),
		}, false))] } : {}),
	});
}

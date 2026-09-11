import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createErrorContext, localConnectionReason, type ErrorContext } from "@mycli/contracts";

const MAX_FATAL_DIAGNOSTIC_CHARS = 32_768;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|authorization|bearer|password|secret|token)\b\s*[:=]\s*([^\s,;]+)/giu;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/giu;
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{12,}\b/gu;

interface FatalTuiDiagnosticOptions {
	readonly errorContext?: ErrorContext;
	readonly homeDir?: string;
	readonly now?: () => Date;
	readonly sessionId?: string;
	readonly diagnosticCode?: string;
}

export function fatalTuiErrorContext(kind: "render" | "terminal" | "connection", diagnosticCode?: string): ErrorContext {
	return createErrorContext({
		reason: kind === "render" ? "tui.render_failed" : kind === "terminal" ? "tui.terminal_unavailable" : localConnectionReason(diagnosticCode),
		source: kind === "connection" ? "gateway" : "tui",
		scope: { kind: kind === "connection" ? "connection" : "application", id: "mycli-shell" },
		outcome: { state: "unknown", effects: "possible" },
	});
}

export function appendFatalTuiDiagnostic(
	error: unknown,
	options: FatalTuiDiagnosticOptions = {},
): string | undefined {
	const home = options.homeDir ?? homedir();
	const logsRoot = join(home, ".mycli", "logs");
	const logPath = join(logsRoot, "tui-errors.log");
	const record = fatalDiagnosticRecord(error, options.now?.() ?? new Date(), options);
	try {
		mkdirSync(logsRoot, { recursive: true, mode: 0o700 });
		appendFileSync(logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(logPath, 0o600);
		return logPath;
	} catch {
		return undefined;
	}
}

function fatalDiagnosticRecord(error: unknown, now: Date, context: FatalTuiDiagnosticOptions): Readonly<Record<string, unknown>> {
	const name = error instanceof Error ? error.name : "Error";
	const message = error instanceof Error ? error.message : "Unknown terminal UI failure.";
	const stack = error instanceof Error && error.stack ? error.stack : `${name}: ${message}`;
	return Object.freeze({
		error_context: context.errorContext ?? fatalTuiErrorContext(context.diagnosticCode ? "connection" : "render", context.diagnosticCode),
		timestamp: now.toISOString(),
		name: redact(name).slice(0, 128),
		message: redact(message).slice(0, 2_048),
		stack: redact(stack).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS),
		...(context.sessionId ? { session_id: redact(context.sessionId).slice(0, 256) } : {}),
		...(context.diagnosticCode ? { diagnostic_code: redact(context.diagnosticCode).slice(0, 128) } : {}),
	});
}

function redact(value: string): string {
	return value
		.replace(BEARER_TOKEN, "Bearer [REDACTED]")
		.replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[REDACTED]`)
		.replace(OPENAI_STYLE_KEY, "[REDACTED]");
}

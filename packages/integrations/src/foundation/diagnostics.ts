import type { IntegrationSource } from "./ids.ts";

export interface IntegrationDiagnostic {
	readonly source: IntegrationSource;
	readonly label: string;
	readonly errorClass: string;
	readonly message: string;
}

export interface SafeDiagnosticInput {
	readonly source: IntegrationSource;
	readonly label: string;
	readonly errorClass: string;
	readonly summary: string;
}

const MAX_LABEL_LENGTH = 64;
const MAX_ERROR_CLASS_LENGTH = 64;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 160;
const ERROR_CLASS = /^[a-z][a-z0-9_]*$/;
const SUSPICIOUS_VALUE = /\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*\S+)/giu;

export function createSafeDiagnostic(input: SafeDiagnosticInput): IntegrationDiagnostic {
	const label = input.label.trim().slice(0, MAX_LABEL_LENGTH);
	if (!label) throw new Error("invalid_diagnostic_label");
	if (!ERROR_CLASS.test(input.errorClass) || input.errorClass.length > MAX_ERROR_CLASS_LENGTH) {
		throw new Error("invalid_diagnostic_error_class");
	}
	if (typeof input.summary !== "string") throw new Error("invalid_diagnostic_summary");
	const message = input.summary.replace(SUSPICIOUS_VALUE, "[REDACTED]")
		.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
	return Object.freeze({
		source: input.source,
		label,
		errorClass: input.errorClass,
		message,
	});
}

import type { ConfigLayerId } from "./config-layers.ts";

export const CONFIG_DIAGNOSTIC_VERSION = 1 as const;

export type ConfigFileLayerId = Extract<ConfigLayerId, "project" | "user" | "legacy_user">;

export type ConfigDiagnosticSeverity = "warning" | "error";

export type ConfigDiagnosticCode =
	| "config_read_failed"
	| "config_write_failed"
	| "deprecated_inline_secret"
	| "forbidden_inline_secret"
	| "invalid_toml"
	| "invalid_value"
	| "unknown_key"
	| "unknown_table";

export interface ConfigDiagnostic {
	readonly version: typeof CONFIG_DIAGNOSTIC_VERSION;
	readonly code: ConfigDiagnosticCode;
	readonly severity: ConfigDiagnosticSeverity;
	readonly layer?: ConfigLayerId;
	readonly keyPath?: string;
	readonly line?: number;
	readonly column?: number;
	readonly message: string;
	readonly remediation?: string;
}

interface ConfigDiagnosticInput {
	readonly code: ConfigDiagnosticCode;
	readonly severity: ConfigDiagnosticSeverity;
	readonly layer?: ConfigLayerId;
	readonly keyPath?: string;
	readonly line?: number;
	readonly column?: number;
	readonly message: string;
	readonly remediation?: string;
}

export class ConfigError extends Error {
	readonly diagnostic: ConfigDiagnostic;

	constructor(diagnostic: ConfigDiagnostic) {
		super(`config_error: ${diagnostic.message}`);
		this.name = "ConfigError";
		this.diagnostic = diagnostic;
	}
}

export function configDiagnostic(input: ConfigDiagnosticInput): ConfigDiagnostic {
	const keyPath = input.keyPath === undefined ? undefined : safeKeyPath(input.keyPath);
	const line = positiveSourcePosition(input.line);
	const column = positiveSourcePosition(input.column);
	return Object.freeze({
		version: CONFIG_DIAGNOSTIC_VERSION,
		code: input.code,
		severity: input.severity,
		...(input.layer === undefined ? {} : { layer: input.layer }),
		...(keyPath ? { keyPath } : {}),
		...(line === undefined ? {} : { line }),
		...(column === undefined ? {} : { column }),
		message: safeDiagnosticText(input.message, 240),
		...(input.remediation === undefined
			? {}
			: { remediation: safeDiagnosticText(input.remediation, 240) }),
	});
}

export function configError(input: ConfigDiagnosticInput): ConfigError {
	return new ConfigError(configDiagnostic({ ...input, severity: "error" }));
}

export function isConfigError(error: unknown): error is ConfigError {
	return error instanceof ConfigError;
}

function safeKeyPath(value: string): string {
	return safeDiagnosticText(value, 160).replace(/[\s.]+/gu, (match) => (
		match.includes(".") ? "." : "_"
	));
}

function safeDiagnosticText(value: string, limit: number): string {
	return value
		.replace(/\p{Cc}/gu, "?")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, limit);
}

function positiveSourcePosition(value: number | undefined): number | undefined {
	return Number.isSafeInteger(value) && (value ?? 0) > 0
		? Math.min(value!, 1_000_000)
		: undefined;
}

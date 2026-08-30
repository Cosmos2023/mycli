import { isConfigError, resolveConfigWithMetadata } from "@mycli/config";
import type { ConfigDiagnostic, WorkspaceTrustState } from "@mycli/config";
import { redactDoctorText } from "./redaction.ts";
import type { DoctorCheck } from "./types.ts";

export interface ConfigDoctorOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly workspaceTrust?: WorkspaceTrustState;
}

export async function collectConfigChecks(
	options: ConfigDoctorOptions,
): Promise<readonly DoctorCheck[]> {
	try {
		const resolved = await resolveConfigWithMetadata({
			...options,
			createSessionId: () => "doctor",
		});
		const config = resolved.config;
		return Object.freeze([
			check(
				"config",
				"ok",
				redactDoctorText(
					`provider=${config.provider} protocol=${config.protocol} model=${config.model}`,
				).slice(0, 320),
			),
			...resolved.diagnostics.map(diagnosticCheck),
			check(
				"api_key",
				config.apiKey ? "ok" : "warning",
				`api_key: ${config.apiKey ? "present" : "missing"}`,
			),
		]);
	} catch (error) {
		return Object.freeze([
			isConfigError(error)
				? diagnosticCheck(error.diagnostic, 0)
				: check("config", "failed", "configuration invalid"),
			check("api_key", "warning", "api_key: unknown"),
		]);
	}
}

function diagnosticCheck(diagnostic: ConfigDiagnostic, index: number): DoctorCheck {
	const detail = [
		diagnostic.layer === undefined ? undefined : `layer=${diagnostic.layer}`,
		diagnostic.keyPath === undefined ? undefined : `key=${diagnostic.keyPath}`,
		diagnostic.line === undefined ? undefined : `line=${diagnostic.line}`,
		diagnostic.column === undefined ? undefined : `column=${diagnostic.column}`,
		diagnostic.remediation,
	].filter((value): value is string => Boolean(value)).join(" ");
	return check(
		`config_${diagnostic.code}_${index + 1}`,
		diagnostic.severity === "error" ? "failed" : "warning",
		diagnostic.message,
		detail,
	);
}

function check(
	name: string,
	status: DoctorCheck["status"],
	message: string,
	detail?: string,
): DoctorCheck {
	return Object.freeze({ name, status, message, ...(detail ? { detail } : {}) });
}

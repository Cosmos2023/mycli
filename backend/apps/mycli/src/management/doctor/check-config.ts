import { resolveConfig } from "@mycli/config";
import type { WorkspaceTrustState } from "@mycli/config";
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
		const config = await resolveConfig({
			...options,
			createSessionId: () => "doctor",
		});
		return Object.freeze([
			check(
				"config",
				"ok",
				redactDoctorText(
					`provider=${config.provider} protocol=${config.protocol} model=${config.model}`,
				).slice(0, 320),
			),
			check(
				"api_key",
				config.apiKey ? "ok" : "warning",
				`api_key: ${config.apiKey ? "present" : "missing"}`,
			),
		]);
	} catch {
		return Object.freeze([
			check("config", "failed", "configuration invalid"),
			check("api_key", "warning", "api_key: unknown"),
		]);
	}
}

function check(
	name: string,
	status: DoctorCheck["status"],
	message: string,
): DoctorCheck {
	return Object.freeze({ name, status, message });
}

import {
	prepareSandboxedProcess,
	type ProcessSandboxProbes,
} from "@mycli/tools";
import { workspaceSandboxProfile } from "../../node-runtime/integration-sandbox.ts";
import type { DoctorCheck } from "./types.ts";

export interface ProcessDoctorOptions extends ProcessSandboxProbes {
	readonly workspaceRoot: string;
}

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux", "win32"]);

export function collectProcessChecks(options: ProcessDoctorOptions): readonly DoctorCheck[] {
	const platform = options.platform ?? process.platform;
	const supported = SUPPORTED_PLATFORMS.has(platform);
	let sandbox: DoctorCheck;
	if (!supported) {
		sandbox = check("process_sandbox", "failed", "process sandbox is unsupported");
	} else {
		try {
			const launch = prepareSandboxedProcess(
				[process.execPath, "-e", ""],
				workspaceSandboxProfile(options.workspaceRoot),
				{
					platform,
					...(options.isExecutable ? { isExecutable: options.isExecutable } : {}),
					...(options.pathExists ? { pathExists: options.pathExists } : {}),
					...(options.isSymbolicLink ? { isSymbolicLink: options.isSymbolicLink } : {}),
					...(options.windowsHelperPath ? { windowsHelperPath: options.windowsHelperPath } : {}),
				},
			);
			sandbox = check("process_sandbox", "ok", `isolation=${launch.isolation}`);
		} catch {
			sandbox = check("process_sandbox", "failed", "required process sandbox is unavailable");
		}
	}
	return Object.freeze([
		check(
			"process_support",
			supported ? "ok" : "failed",
			supported ? `platform=${platform} process_tree_cleanup=available` : "platform unsupported",
		),
		sandbox,
	]);
}

function check(
	name: string,
	status: DoctorCheck["status"],
	message: string,
): DoctorCheck {
	return Object.freeze({ name, status, message });
}

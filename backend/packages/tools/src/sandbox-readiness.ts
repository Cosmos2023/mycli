import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LINUX_BUBBLEWRAP_EXECUTABLES } from "./sandbox/linux-bubblewrap.ts";
import { MACOS_SEATBELT_EXECUTABLE } from "./sandbox/macos-seatbelt.ts";
import { WINDOWS_SANDBOX_PROTOCOL_VERSION } from "./sandbox/windows-restricted-token.ts";

const WINDOWS_HANDSHAKE_TIMEOUT_MS = 2_000;
const WINDOWS_HANDSHAKE_MAX_BYTES = 16_384;

export type SandboxReadinessState =
	| "ready"
	| "setup_required"
	| "unavailable"
	| "not_required";

export type SandboxReadinessCode =
	| "ready"
	| "setup_incomplete"
	| "helper_missing"
	| "handshake_failed"
	| "enforcement_unavailable"
	| "unsupported_platform"
	| "not_required";

export type SandboxReadinessIsolation =
	| "macos_seatbelt"
	| "linux_bubblewrap"
	| "windows_restricted_token"
	| "none";

export interface SandboxReadiness {
	readonly state: SandboxReadinessState;
	readonly code: SandboxReadinessCode;
	readonly platform: NodeJS.Platform;
	readonly isolation: SandboxReadinessIsolation;
}

export interface WindowsSandboxHandshake {
	readonly name: string;
	readonly protocolVersion: number;
	readonly setupComplete: boolean;
	readonly sandboxReady: boolean;
}

export interface SandboxReadinessProbes {
	readonly platform?: NodeJS.Platform;
	readonly isExecutable?: (path: string) => boolean;
	readonly windowsHelperPath?: string;
	readonly windowsHandshake?: (
		path: string,
		signal: AbortSignal | undefined,
	) => Promise<WindowsSandboxHandshake>;
}

export async function inspectSandboxReadiness(
	probes: SandboxReadinessProbes = {},
	signal?: AbortSignal,
): Promise<SandboxReadiness> {
	const platform = probes.platform ?? process.platform;
	const isExecutable = probes.isExecutable ?? sandboxExecutableExists;
	if (platform === "darwin") {
		return isExecutable(MACOS_SEATBELT_EXECUTABLE)
			? readiness(platform, "macos_seatbelt", "ready", "ready")
			: readiness(platform, "macos_seatbelt", "unavailable", "helper_missing");
	}
	if (platform === "linux") {
		return LINUX_BUBBLEWRAP_EXECUTABLES.some(isExecutable)
			? readiness(platform, "linux_bubblewrap", "ready", "ready")
			: readiness(platform, "linux_bubblewrap", "unavailable", "helper_missing");
	}
	if (platform === "win32") {
		const helper = probes.windowsHelperPath ?? packagedWindowsSandboxHelper();
		if (!isExecutable(helper)) {
			return readiness(platform, "windows_restricted_token", "unavailable", "helper_missing");
		}
		let handshake: WindowsSandboxHandshake;
		try {
			handshake = await (probes.windowsHandshake ?? runWindowsSandboxHandshake)(
				helper,
				signal,
			);
		} catch {
			return readiness(platform, "windows_restricted_token", "unavailable", "handshake_failed");
		}
		if (!validWindowsHandshake(handshake)) {
			return readiness(platform, "windows_restricted_token", "unavailable", "handshake_failed");
		}
		if (!handshake.setupComplete) {
			return readiness(platform, "windows_restricted_token", "setup_required", "setup_incomplete");
		}
		return handshake.sandboxReady
			? readiness(platform, "windows_restricted_token", "ready", "ready")
			: readiness(
				platform,
				"windows_restricted_token",
				"unavailable",
				"enforcement_unavailable",
			);
	}
	return readiness(platform, "none", "unavailable", "unsupported_platform");
}

export function sandboxNotRequired(platform = process.platform): SandboxReadiness {
	return readiness(platform, "none", "not_required", "not_required");
}

export function packagedWindowsSandboxHelper(): string {
	return join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"native",
		"windows",
		"mycli-windows-sandbox.exe",
	);
}

export function sandboxExecutableExists(path: string): boolean {
	try {
		const metadata = statSync(path);
		return metadata.isFile() && (process.platform === "win32" || (metadata.mode & 0o111) !== 0);
	} catch {
		return false;
	}
}

function runWindowsSandboxHandshake(
	path: string,
	signal: AbortSignal | undefined,
): Promise<WindowsSandboxHandshake> {
	return new Promise((resolve, reject) => {
		execFile(path, ["--handshake"], {
			encoding: "utf8",
			maxBuffer: WINDOWS_HANDSHAKE_MAX_BYTES,
			timeout: WINDOWS_HANDSHAKE_TIMEOUT_MS,
			windowsHide: true,
			...(signal ? { signal } : {}),
		}, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			try {
				const value: unknown = JSON.parse(stdout);
				if (!isRecord(value)) throw new TypeError("invalid sandbox handshake");
				resolve({
					name: value.name as string,
					protocolVersion: value.protocol_version as number,
					setupComplete: value.setup_complete as boolean,
					sandboxReady: value.sandbox_ready as boolean,
				});
			} catch (parseError) {
				reject(parseError);
			}
		});
	});
}

function validWindowsHandshake(value: WindowsSandboxHandshake): boolean {
	return value.name === "mycli-windows-sandbox"
		&& value.protocolVersion === WINDOWS_SANDBOX_PROTOCOL_VERSION
		&& typeof value.setupComplete === "boolean"
		&& typeof value.sandboxReady === "boolean";
}

function readiness(
	platform: NodeJS.Platform,
	isolation: SandboxReadinessIsolation,
	state: SandboxReadinessState,
	code: SandboxReadinessCode,
): SandboxReadiness {
	return Object.freeze({ state, code, platform, isolation });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	LINUX_BUBBLEWRAP_EXECUTABLES,
	linuxBubblewrapProbeArgs,
} from "./sandbox/linux-bubblewrap.ts";
import { MACOS_SEATBELT_EXECUTABLE } from "./sandbox/macos-seatbelt.ts";
import { WINDOWS_SANDBOX_PROTOCOL_VERSION } from "./sandbox/windows-restricted-token.ts";

const WINDOWS_HANDSHAKE_TIMEOUT_MS = 5_000;
const WINDOWS_HANDSHAKE_MAX_BYTES = 16_384;
const LINUX_PROBE_TIMEOUT_MS = 5_000;
const LINUX_PROBE_MAX_BYTES = 16_384;

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
	readonly helperVersion?: number;
	readonly helperCompatible?: boolean;
	readonly setupComplete?: boolean;
	readonly sandboxReady?: boolean;
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
	readonly linuxBubblewrapProbe?: (
		path: string,
		signal: AbortSignal | undefined,
	) => Promise<boolean>;
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
		const helper = LINUX_BUBBLEWRAP_EXECUTABLES.find(isExecutable);
		if (!helper) {
			return readiness(platform, "linux_bubblewrap", "unavailable", "helper_missing");
		}
		try {
			const capable = await (probes.linuxBubblewrapProbe ?? runLinuxBubblewrapProbe)(
				helper,
				signal,
			);
			return capable
				? readiness(platform, "linux_bubblewrap", "ready", "ready")
				: readiness(
					platform,
					"linux_bubblewrap",
					"unavailable",
					"enforcement_unavailable",
				);
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) throw error;
			return readiness(
				platform,
				"linux_bubblewrap",
				"unavailable",
				"enforcement_unavailable",
			);
		}
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
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) throw error;
			return readiness(platform, "windows_restricted_token", "unavailable", "handshake_failed");
		}
		if (!validWindowsHandshakeShape(handshake) || handshake.name !== "mycli-windows-sandbox") {
			return readiness(platform, "windows_restricted_token", "unavailable", "handshake_failed");
		}
		const details = {
			helperVersion: handshake.protocolVersion,
			helperCompatible: handshake.protocolVersion === WINDOWS_SANDBOX_PROTOCOL_VERSION,
			setupComplete: handshake.setupComplete,
			sandboxReady: handshake.sandboxReady,
		} as const;
		if (!details.helperCompatible) {
			return readiness(
				platform,
				"windows_restricted_token",
				"unavailable",
				"handshake_failed",
				details,
			);
		}
		if (!handshake.setupComplete) {
			return readiness(
				platform,
				"windows_restricted_token",
				"setup_required",
				"setup_incomplete",
				details,
			);
		}
		return handshake.sandboxReady
			? readiness(platform, "windows_restricted_token", "ready", "ready", details)
			: readiness(
				platform,
				"windows_restricted_token",
				"unavailable",
				"enforcement_unavailable",
				details,
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
				const handshake = {
					name: value.name,
					protocolVersion: value.protocol_version,
					setupComplete: value.setup_complete,
					sandboxReady: value.sandbox_ready,
				};
				if (!validWindowsHandshakeShape(handshake)) {
					throw new TypeError("invalid sandbox handshake");
				}
				resolve(handshake);
			} catch (parseError) {
				reject(parseError);
			}
		});
	});
}

function runLinuxBubblewrapProbe(
	path: string,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	return new Promise((resolve, reject) => {
		execFile(path, linuxBubblewrapProbeArgs(), {
			encoding: "utf8",
			maxBuffer: LINUX_PROBE_MAX_BYTES,
			timeout: LINUX_PROBE_TIMEOUT_MS,
			windowsHide: true,
			...(signal ? { signal } : {}),
		}, (error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(true);
		});
	});
}

function validWindowsHandshakeShape(value: unknown): value is WindowsSandboxHandshake {
	if (!isRecord(value)) return false;
	return typeof value.name === "string"
		&& typeof value.protocolVersion === "number"
		&& Number.isSafeInteger(value.protocolVersion)
		&& value.protocolVersion >= 0
		&& typeof value.setupComplete === "boolean"
		&& typeof value.sandboxReady === "boolean"
		&& (value.setupComplete || !value.sandboxReady);
}

function readiness(
	platform: NodeJS.Platform,
	isolation: SandboxReadinessIsolation,
	state: SandboxReadinessState,
	code: SandboxReadinessCode,
	details: Readonly<Partial<Pick<
		SandboxReadiness,
		"helperVersion" | "helperCompatible" | "setupComplete" | "sandboxReady"
	>>> = {},
): SandboxReadiness {
	return Object.freeze({ state, code, platform, isolation, ...details });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

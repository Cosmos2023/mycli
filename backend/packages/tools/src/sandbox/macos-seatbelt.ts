import {
	hasUnrestrictedFilesystem,
	hasUnrestrictedNetwork,
	type SandboxProfile,
} from "../execution-policy.ts";
import type { SandboxedProcessLaunch } from "../process-sandbox.ts";

export const MACOS_SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";

export function macosSeatbeltLaunch(
	argv: readonly string[],
	profile: SandboxProfile,
	protectedRoots: Readonly<Record<string, string>>,
): SandboxedProcessLaunch {
	const definitions: string[] = [];
	const rules = [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow signal (target same-sandbox))",
		"(allow process-info* (target same-sandbox))",
		"(allow file-read*)",
		"(allow file-write-data (literal \"/dev/null\"))",
		"(allow file-read* file-write* file-ioctl (literal \"/dev/ptmx\"))",
		"(allow pseudo-tty)",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow ipc-posix*)",
		"(allow user-preference-read)",
	];
	if (hasUnrestrictedFilesystem(profile)) rules.push("(allow file-write*)");
	for (const [index, root] of profile.writableRoots.entries()) {
		const key = `WRITABLE_ROOT_${index}`;
		definitions.push(`-D${key}=${root}`);
		rules.push(`(allow file-write* (literal (param "${key}")))`);
		rules.push(`(allow file-write* (subpath (param "${key}")))`);
	}
	for (const [key, path] of Object.entries(protectedRoots)) {
		definitions.push(`-D${key}=${path}`);
		rules.push(`(deny file-write* (literal (param "${key}")))`);
		rules.push(`(deny file-write* (subpath (param "${key}")))`);
	}
	if (hasUnrestrictedNetwork(profile)) {
		rules.push("(allow network-outbound)", "(allow network-inbound)", "(allow system-socket)");
	}
	return Object.freeze({
		executable: MACOS_SEATBELT_EXECUTABLE,
		args: Object.freeze(["-p", rules.join("\n"), ...definitions, "--", ...argv]),
		isolation: "macos_seatbelt",
	});
}

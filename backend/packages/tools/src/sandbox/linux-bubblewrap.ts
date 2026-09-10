import {
	hasUnrestrictedFilesystem,
	hasUnrestrictedNetwork,
	type SandboxProfile,
} from "../policy/execution-policy.ts";
import type { SandboxedProcessLaunch } from "./process-sandbox.ts";

export const LINUX_BUBBLEWRAP_EXECUTABLES = ["/usr/bin/bwrap", "/bin/bwrap"] as const;

export function linuxBubblewrapProbeArgs(nodeExecutable = process.execPath): readonly string[] {
	return Object.freeze([
		"--new-session",
		"--die-with-parent",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-net",
		"--proc",
		"/proc",
		"--",
		nodeExecutable,
		"-e",
		"",
	]);
}

export function linuxBubblewrapLaunch(
	executable: string,
	argv: readonly string[],
	profile: SandboxProfile,
	protectedRoots: readonly string[],
): SandboxedProcessLaunch {
	const args = [
		"--new-session",
		"--die-with-parent",
		hasUnrestrictedFilesystem(profile) ? "--bind" : "--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
	];
	for (const root of profile.writableRoots) args.push("--bind", root, root);
	for (const path of protectedRoots) args.push("--ro-bind", path, path);
	args.push("--unshare-user", "--unshare-pid");
	if (!hasUnrestrictedNetwork(profile)) args.push("--unshare-net");
	args.push("--proc", "/proc", "--chdir", profile.cwd, "--", ...argv);
	return Object.freeze({
		executable,
		args: Object.freeze(args),
		isolation: "linux_bubblewrap",
	});
}

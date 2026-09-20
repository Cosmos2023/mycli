import { resolveShellProfile } from "@mycli/tools";

/**
 * Renders `executable args...` the way the shell mycli selects on this host
 * expects it. PowerShell needs a call operator in front of a quoted path, POSIX
 * shells and CMD do not.
 *
 * Pass the same environment the backend under test receives: shell selection
 * reads `PATH`, `SystemRoot`, `ComSpec`, and `MYCLI_SHELL_PATH` from it.
 */
export function shellCommand(
	executable: string,
	args: readonly string[],
	env: Readonly<NodeJS.ProcessEnv>,
): string {
	const profile = resolveShellProfile({ env });
	const rendered = [`"${executable}"`, ...args.map(quoteArgument)].join(" ");
	return profile.kind === "powershell" ? `& ${rendered}` : rendered;
}

function quoteArgument(value: string): string {
	return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

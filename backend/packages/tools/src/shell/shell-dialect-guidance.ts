import type { ShellDialect } from "./shell-profile.ts";

/**
 * Fact line for the environment context. Codex reports the shell as plain
 * environment data and keeps command-writing rules in the tool spec, so this
 * stays descriptive instead of instructional.
 */
const DIALECT_FACTS: Readonly<Record<ShellDialect, string>> = Object.freeze({
	"posix-sh": "POSIX sh-family shell with sh-style syntax and pipelines.",
	"powershell-7": "PowerShell 7 cmdlet syntax with `$env:NAME` variables.",
	"windows-powershell-5.1": "Windows PowerShell 5.1 cmdlet syntax with `$env:NAME` variables.",
	cmd: "Command Prompt batch syntax with `%NAME%` variables and built-ins.",
});

/** Command-writing rules for the active shell, carried by the Shell tool description. */
const DIALECT_RULES: Readonly<Record<ShellDialect, string>> = Object.freeze({
	"posix-sh": "POSIX shell syntax: `$NAME` variables, `&&`/`|`/`;` chaining, "
		+ "`sed`/`awk`/`grep` and heredocs are available.",
	"powershell-7": "PowerShell 7 syntax: `$env:NAME` variables, `&&`/`||`/`;` chaining, "
		+ "cmdlets such as `Get-ChildItem`, `Get-Content`, `Select-String`, `Remove-Item`; "
		+ "no heredocs, use the file tools or a `@'...'@` here-string.",
	"windows-powershell-5.1": "Windows PowerShell 5.1 syntax: `$env:NAME` variables, "
		+ "`;` chaining only (`&&`/`||` require PowerShell 7), "
		+ "cmdlets such as `Get-ChildItem`, `Get-Content`, `Select-String`, `Remove-Item`; "
		+ "no heredocs, use the file tools or a `@'...'@` here-string.",
	cmd: "CMD syntax: `%NAME%` variables, `&&`/`&`/`|` chaining, "
		+ "built-ins such as `dir`, `type`, `where`, `del`; no heredocs, "
		+ "no `sed`/`awk`/`grep`, use `rg` or the file tools instead; "
		+ "for a bounded file window use `rg -n -A/-B` or a short Node script.",
});

const CONSOLE_ENCODING_RULE = "Output is decoded as UTF-8; never run `chcp` or set console encodings.";

const WINDOWS_SAFETY_RULES = [
	"Windows safety rules:",
	"- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to `cmd /c`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as `Remove-Item` / `Move-Item` with `-LiteralPath`, and avoid string-built shell commands for file operations.",
	"- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.",
	"- When using `Start-Process` to launch a background helper or service, pass `-WindowStyle Hidden` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.",
].join("\n");

const DARWIN_RULES = "macOS ships a BSD userland: `sed -i` needs an explicit suffix "
	+ "(`sed -i '' -e ...`), and `date -d`, `readlink -f`, `stat -c`, `xargs -r`, and GNU-only "
	+ "long options are unavailable; prefer `rg`, `perl -i`, or a short Node script.";

export interface ShellGuidanceOptions {
	/** Target platform; `darwin` adds the BSD userland caveats. */
	readonly platform?: NodeJS.Platform;
}

/** Model-visible fact describing the active shell family without stating rules. */
export function shellDialectFact(dialect: ShellDialect): string {
	return DIALECT_FACTS[dialect];
}

/**
 * Platform-aware command rules appended to the Shell tool description, the
 * place Codex attaches its Windows safety rules instead of the base prompt.
 */
export function shellToolGuidance(
	dialect: ShellDialect,
	options: ShellGuidanceOptions = {},
): string {
	const parts = [DIALECT_RULES[dialect]];
	if (dialect !== "posix-sh") parts.push(CONSOLE_ENCODING_RULE, WINDOWS_SAFETY_RULES);
	if (options.platform === "darwin" && dialect === "posix-sh") parts.push(DARWIN_RULES);
	return parts.join("\n\n");
}

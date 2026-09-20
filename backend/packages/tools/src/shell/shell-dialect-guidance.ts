import type { ShellDialect } from "./shell-profile.ts";

const DIALECT_NOTES: Readonly<Record<ShellDialect, string>> = Object.freeze({
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
		+ "no `sed`/`awk`/`grep`, use `rg` or the file tools instead.",
});

const CONSOLE_ENCODING_NOTE = "Output is decoded as UTF-8; never run `chcp` or set console encodings.";

/** Model-visible hint describing how to write commands for the active shell. */
export function shellDialectGuidance(dialect: ShellDialect): string {
	return dialect === "posix-sh"
		? DIALECT_NOTES[dialect]
		: `${DIALECT_NOTES[dialect]} ${CONSOLE_ENCODING_NOTE}`;
}

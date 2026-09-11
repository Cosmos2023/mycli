import { parseArgs, type ParseArgsConfig } from "node:util";
import { parse } from "shell-quote";
import type { MycliShellBash } from "../model.ts";
import { terminalContent } from "./terminal-content.ts";
import { visibleWidth } from "../tui-core/utils.ts";

export interface ShellSearchPreview {
	readonly kind: "search" | "list";
	readonly queries: readonly string[];
	readonly paths: readonly string[];
}

const shellPreviews = new WeakMap<MycliShellBash, {
	readonly command: string;
	readonly shellKind: string | undefined;
	readonly preview: ShellSearchPreview | undefined;
}>();

export function cachedShellSearchPreview(shell: MycliShellBash): ShellSearchPreview | undefined {
	const { command, shellKind } = shell;
	const cached = shellPreviews.get(shell);
	if (cached && cached.command === command && cached.shellKind === shellKind) return cached.preview;
	const preview = shellSearchPreview(command, shellKind);
	shellPreviews.set(shell, { command, shellKind, preview });
	return preview;
}

const COMMON_OPTIONS = {
	regexp: { type: "string", short: "e", multiple: true },
	"ignore-case": { type: "boolean", short: "i" },
	"fixed-strings": { type: "boolean", short: "F" },
	"word-regexp": { type: "boolean", short: "w" },
	"line-regexp": { type: "boolean", short: "x" },
	"line-number": { type: "boolean", short: "n" },
	"with-filename": { type: "boolean", short: "H" },
	"files-with-matches": { type: "boolean", short: "l" },
	"invert-match": { type: "boolean", short: "v" },
	count: { type: "boolean", short: "c" },
	quiet: { type: "boolean", short: "q" },
	context: { type: "string", short: "C" },
	"before-context": { type: "string", short: "B" },
	"after-context": { type: "string", short: "A" },
	"max-count": { type: "string", short: "m" },
	color: { type: "string" },
} satisfies NonNullable<ParseArgsConfig["options"]>;

const RG_OPTIONS = {
	...COMMON_OPTIONS,
	files: { type: "boolean" },
	glob: { type: "string", short: "g", multiple: true },
	iglob: { type: "string", multiple: true },
	type: { type: "string", short: "t", multiple: true },
	"type-not": { type: "string", short: "T", multiple: true },
	"smart-case": { type: "boolean", short: "S" },
	"case-sensitive": { type: "boolean", short: "s" },
	"no-heading": { type: "boolean" },
	heading: { type: "boolean" },
	"no-filename": { type: "boolean", short: "I" },
	"no-line-number": { type: "boolean", short: "N" },
	"no-messages": { type: "boolean" },
	"count-matches": { type: "boolean" },
	hidden: { type: "boolean" },
	"no-ignore": { type: "boolean" },
	"no-ignore-vcs": { type: "boolean" },
	follow: { type: "boolean", short: "L" },
	multiline: { type: "boolean", short: "U" },
	"multiline-dotall": { type: "boolean" },
	pcre2: { type: "boolean", short: "P" },
	crlf: { type: "boolean" },
	null: { type: "boolean", short: "0" },
	"max-columns": { type: "string", short: "M" },
	"max-columns-preview": { type: "boolean" },
	"max-depth": { type: "string" },
	encoding: { type: "string", short: "E" },
	sort: { type: "string" },
	sortr: { type: "string" },
} satisfies NonNullable<ParseArgsConfig["options"]>;

const GREP_OPTIONS = {
	...COMMON_OPTIONS,
	recursive: { type: "boolean", short: "r" },
	"dereference-recursive": { type: "boolean", short: "R" },
	"extended-regexp": { type: "boolean", short: "E" },
	"basic-regexp": { type: "boolean", short: "G" },
	"perl-regexp": { type: "boolean", short: "P" },
	"no-filename": { type: "boolean", short: "h" },
	"files-without-match": { type: "boolean", short: "L" },
	include: { type: "string", multiple: true },
	exclude: { type: "string", multiple: true },
	"exclude-dir": { type: "string", multiple: true },
} satisfies NonNullable<ParseArgsConfig["options"]>;

/** Display-only parsing. Shell execution, permissions, and stored results remain authoritative. */
export function shellSearchPreview(command: string, shellKind?: string): ShellSearchPreview | undefined {
	if (shellKind && shellKind !== "posix") return undefined;
	if (command.length > 8_192 || /[\p{Cc}\p{Cf}`]/u.test(command)) return undefined;
	try {
		let expanded = false;
		const tokens = parse(command, () => { expanded = true; return ""; });
		if (expanded || !tokens.every((token): token is string => typeof token === "string")) return undefined;
		const executable = tokens[0]?.split("/").at(-1);
		if (executable !== "rg" && executable !== "grep") return undefined;
		const options: NonNullable<ParseArgsConfig["options"]> = executable === "rg" ? RG_OPTIONS : GREP_OPTIONS;
		const { values, positionals } = parseArgs({
			args: tokens.slice(1), allowPositionals: true, strict: true,
			options,
		});
		const queries = strings(values.regexp);
		const paths = [...positionals];
		const kind = values.files === true ? "list" : "search";
		if (kind === "list" && queries.length > 0) return undefined;
		if (kind === "search" && queries.length === 0) {
			const query = paths.shift();
			if (query === undefined) return undefined;
			queries.push(query);
		}
		return { kind, queries, paths };
	} catch {
		return undefined;
	}
}

function strings(value: string | boolean | (string | boolean)[] | undefined): string[] {
	return typeof value === "string" ? [value] : Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string") : [];
}

export function shellSearchHasNoMatches(shell: MycliShellBash, search: ShellSearchPreview | undefined): boolean {
	return search !== undefined && shell.status !== "running" && shell.status !== "cancelled"
		&& shell.exitCode === 1 && visibleWidth(terminalContent(shell.outputPreview ?? "").replace(/\s/gu, "")) === 0
		&& (shell.outputChars ?? 0) === 0 && (shell.omittedOutputChars ?? 0) === 0
		&& (shell.hiddenLineCount ?? 0) === 0
		&& (!shell.terminalState || shell.terminalState === "completed" || shell.terminalState === "failed");
}

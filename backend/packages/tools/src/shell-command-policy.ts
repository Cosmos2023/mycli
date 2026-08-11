import { posix, win32 } from "node:path";

const POSIX_OPERATORS = new Set(["&&", "||", ";", "|"]);
const SHELL_KEYWORDS = new Set([
	"case", "do", "done", "elif", "else", "esac", "fi", "for", "function",
	"if", "in", "select", "then", "time", "until", "while",
]);
const POSIX_DIRECT_SAFE = new Set([
	"cat", "cd", "cut", "echo", "expr", "false", "grep", "head", "id", "ls",
	"nl", "paste", "pwd", "rev", "seq", "stat", "tail", "tr", "true", "uname",
	"uniq", "wc", "which", "whoami",
]);
const POWERSHELL_DIRECT_SAFE = new Set([
	"cat", "dir", "echo", "findstr", "gc", "gci", "get-childitem", "get-command",
	"get-content", "get-date", "get-item", "get-location", "gl", "ls", "measure",
	"measure-object", "pwd", "resolve-path", "rvpa", "select", "select-object",
	"select-string", "sls", "test-path", "tp", "type", "write-host",
	"write-output",
]);
const POWERSHELL_PIPELINE_SAFE = new Set(["sort-object"]);
const CMD_DIRECT_SAFE = new Set(["cd", "dir", "echo", "find", "findstr", "type", "where"]);
const POWERSHELL_SIDE_EFFECTING = new Set([
	"add-content", "copy-item", "move-item", "new-item", "out-file", "remove-item",
	"rename-item", "set-content", "start-process", "stop-process",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SED_PRINT = /^[0-9]+(?:,[0-9]+)?p$/u;

export type ShellCommandKind = "posix" | "powershell" | "cmd";

export interface ShellSegment {
	readonly words: readonly string[];
	readonly operatorBefore: string | null;
	readonly effectiveCwd: string | null;
}

export type ShellParseResult =
	| { readonly kind: "plain"; readonly segments: readonly ShellSegment[]; readonly reason?: undefined }
	| { readonly kind: "complex"; readonly reason: string; readonly segments?: undefined }
	| { readonly kind: "invalid"; readonly reason: string; readonly segments?: undefined };

export interface ShellCommandClassification {
	readonly decision: "safe" | "dangerous" | "unknown" | "complex" | "invalid";
	readonly reason: string;
	readonly segments: readonly ShellSegment[];
	readonly commandPattern?: readonly string[];
}

interface ShellToken {
	readonly value: string;
	readonly operator: boolean;
	readonly quoted: boolean;
}

export function parseShellCommand(
	command: string,
	options: { readonly shellKind: ShellCommandKind },
): ShellParseResult {
	return options.shellKind === "posix"
		? parsePosix(command, true)
		: parseWindows(command, options.shellKind);
}

export function parseShellArgv(
	args: readonly string[],
	options: { readonly shellKind: ShellCommandKind },
): ShellParseResult {
	void options;
	if (args.length === 0 || !args[0]) return invalid("empty command");
	return plain([segment(args, null, null)]);
}

export function classifyShellCommand(
	command: string,
	options: {
		readonly shellKind: ShellCommandKind;
		readonly platform?: NodeJS.Platform;
		readonly workspaceRoot?: string;
	},
): ShellCommandClassification {
	return classifyParsed(parseShellCommand(command, options), options);
}

export function classifyShellArgv(
	args: readonly string[],
	options: {
		readonly shellKind: ShellCommandKind;
		readonly platform?: NodeJS.Platform;
		readonly workspaceRoot?: string;
	},
): ShellCommandClassification {
	return classifyParsed(parseShellArgv(args, options), options);
}

export function isKnownSafeShellSegment(
	value: ShellSegment,
	options: {
		readonly shellKind: ShellCommandKind;
		readonly platform?: NodeJS.Platform;
		readonly workspaceRoot?: string;
	},
): boolean {
	if (value.words.length === 0) return false;
	if (options.shellKind !== "posix") return isKnownSafeWindowsSegment(value, options.shellKind);
	const executable = posix.basename(value.words[0]!);
	if (POSIX_DIRECT_SAFE.has(executable)) return true;
	if ((options.platform ?? process.platform) === "linux" && (executable === "numfmt" || executable === "tac")) {
		return true;
	}
	if (executable === "base64") return safeBase64(value.words);
	if (executable === "find") return safeFind(value.words);
	if (executable === "git") return safeGit(value.words, value, options);
	if (executable === "rg") return safeRg(value.words);
	if (executable === "sed") return safeSed(value.words);
	return false;
}

export function isKnownDangerousShellSegment(
	value: ShellSegment,
	options: { readonly shellKind: ShellCommandKind },
): boolean {
	if (value.words.length === 0) return false;
	if (options.shellKind === "powershell") return dangerousPowerShell(value.words);
	if (options.shellKind === "cmd") return dangerousCmd(value.words);
	return dangerousPosix(value.words);
}

function classifyParsed(
	parsed: ShellParseResult,
	options: {
		readonly shellKind: ShellCommandKind;
		readonly platform?: NodeJS.Platform;
		readonly workspaceRoot?: string;
	},
): ShellCommandClassification {
	if (parsed.kind !== "plain") {
		return Object.freeze({
			decision: parsed.kind,
			reason: parsed.reason,
			segments: Object.freeze([]),
		});
	}
	for (const current of parsed.segments) {
		if (isKnownDangerousShellSegment(current, options)) {
			return Object.freeze({
				decision: "dangerous" as const,
				reason: `Dangerous command ${current.words[0] ?? "command"} requires approval`,
				segments: parsed.segments,
				commandPattern: Object.freeze(current.words.slice(0, 3)),
			});
		}
		if (!isKnownSafeShellSegment(current, options)) {
			return Object.freeze({
				decision: "unknown" as const,
				reason: `Unknown command ${current.words[0] ?? "command"} requires approval`,
				segments: parsed.segments,
				commandPattern: Object.freeze(current.words.slice(0, 3)),
			});
		}
	}
	return Object.freeze({
		decision: "safe" as const,
		reason: "Command allowed",
		segments: parsed.segments,
	});
}

function isKnownSafeWindowsSegment(value: ShellSegment, shellKind: "powershell" | "cmd"): boolean {
	const executable = windowsExecutable(value.words[0]!);
	if (executable === "git") return safeGit(["git", ...value.words.slice(1)]);
	if (executable === "rg") return safeRg(["rg", ...value.words.slice(1)]);
	if (shellKind === "powershell") {
		return !containsSideEffectingPowerShellToken(value.words)
			&& (POWERSHELL_DIRECT_SAFE.has(executable)
				|| (POWERSHELL_PIPELINE_SAFE.has(executable) && value.operatorBefore === "|"));
	}
	return CMD_DIRECT_SAFE.has(executable);
}

function safeBase64(words: readonly string[]): boolean {
	return !words.slice(1).some((word) => word === "-o"
		|| word === "--output"
		|| word.startsWith("--output=")
		|| word.startsWith("-o"));
}

function safeFind(words: readonly string[]): boolean {
	const forbidden = new Set([
		"-delete", "-exec", "-execdir", "-fls", "-fprint", "-fprint0", "-fprintf",
		"-ok", "-okdir",
	]);
	return !words.slice(1).some((word) => forbidden.has(word));
}

function safeRg(words: readonly string[]): boolean {
	return !words.slice(1).some((word) => word === "--search-zip"
		|| word === "-z"
		|| word === "--hostname-bin"
		|| word.startsWith("--hostname-bin=")
		|| word === "--pre"
		|| word.startsWith("--pre="));
}

function safeSed(words: readonly string[]): boolean {
	return words.length >= 3 && words.length <= 4 && words[1] === "-n" && SED_PRINT.test(words[2]!);
}

function safeGit(
	words: readonly string[],
	segment?: ShellSegment,
	options?: {
		readonly shellKind: ShellCommandKind;
		readonly workspaceRoot?: string;
	},
): boolean {
	let index = 1;
	let gitCwd: string | undefined;
	while (index < words.length) {
		if (words[index] === "-C" && index + 1 < words.length) {
			gitCwd = workspaceGitCwd(
				options?.workspaceRoot,
				gitCwd,
				segment?.effectiveCwd,
				words[index + 1]!,
				options?.shellKind,
			);
			if (!gitCwd) return false;
			index += 2;
			continue;
		}
		if (words[index] === "--no-pager") {
			index += 1;
			continue;
		}
		if (words[index]!.startsWith("-")) return false;
		break;
	}
	if (index >= words.length) return false;
	const subcommand = words[index]!.toLowerCase();
	const args = words.slice(index + 1);
	if (args.some((arg) => arg === "--ext-diff"
		|| arg === "--exec"
		|| arg === "--output"
		|| arg === "--textconv"
		|| arg.startsWith("--exec=")
		|| arg.startsWith("--output="))) return false;
	if (["status", "log", "diff", "show"].includes(subcommand)) return true;
	if (subcommand !== "branch") return false;
	if (args.length === 0) return true;
	let sawList = false;
	for (const arg of args) {
		if (["--all", "--list", "--remotes", "--show-current", "--verbose", "-a", "-l", "-r", "-v", "-vv"].includes(arg)
			|| arg.startsWith("--format=")) {
			sawList = true;
			continue;
		}
		if (sawList && !arg.startsWith("-")) continue;
		return false;
	}
	return sawList;
}

function workspaceGitCwd(
	workspaceRoot: string | undefined,
	currentCwd: string | undefined,
	effectiveCwd: string | null | undefined,
	rawCwd: string,
	shellKind: ShellCommandKind | undefined,
): string | undefined {
	if (!workspaceRoot || !rawCwd || rawCwd.includes("\0")) return undefined;
	const paths = shellKind === "posix" ? posix : win32;
	const root = paths.resolve(workspaceRoot);
	const base = currentCwd ?? (effectiveCwd ? paths.resolve(root, effectiveCwd) : root);
	if (!isPathWithin(root, base, paths)) return undefined;
	const candidate = paths.resolve(base, rawCwd);
	return isPathWithin(root, candidate, paths) ? candidate : undefined;
}

function dangerousPosix(words: readonly string[]): boolean {
	const executable = posix.basename(words[0] ?? "");
	if (executable === "sudo") return dangerousPosix(words.slice(1));
	return executable === "rm" && (words[1] === "-f" || words[1] === "-rf");
}

function dangerousPowerShell(words: readonly string[]): boolean {
	const normalized = words.map(normalizePowerShellToken);
	const hasUrl = normalized.some(looksLikeUrl);
	if (hasUrl && normalized.some((word) => [
		"ii", "invoke-item", "saps", "start", "start-process",
	].includes(word) || word.includes("shell.application") || word.includes("shellexecute"))) {
		return true;
	}
	const first = windowsExecutable(normalized[0] ?? "");
	if (hasUrl && (first === "explorer" || first === "mshta" || isBrowserExecutable(first)
		|| (first === "rundll32" && normalized.some((word) => word.includes("url.dll,fileprotocolhandler"))))) {
		return true;
	}
	const hasForce = normalized.some((word) => word === "-force" || word.startsWith("-force:"));
	return hasForce && normalized.some((word) => [
		"del", "erase", "rd", "remove-item", "ri", "rm", "rmdir",
	].includes(word));
}

function dangerousCmd(words: readonly string[]): boolean {
	const normalized = words.map((word) => word.toLowerCase());
	const executable = windowsExecutable(normalized[0] ?? "");
	if (normalized.some(looksLikeUrl) && (
		executable === "start"
		|| executable === "explorer"
		|| executable === "mshta"
		|| isBrowserExecutable(executable)
		|| (executable === "rundll32"
			&& normalized.some((word) => word.includes("url.dll,fileprotocolhandler")))
	)) return true;
	if ((executable === "del" || executable === "erase") && normalized.includes("/f")) return true;
	return (executable === "rd" || executable === "rmdir")
		&& normalized.includes("/s")
		&& normalized.includes("/q");
}

function containsSideEffectingPowerShellToken(words: readonly string[]): boolean {
	return words.some((word) => POWERSHELL_SIDE_EFFECTING.has(
		normalizePowerShellToken(word).replace(/^-+/u, ""),
	));
}

function normalizePowerShellToken(value: string): string {
	return value
		.trim()
		.replace(/^['"({[]+/u, "")
		.replace(/[)'"}\],;]+$/u, "")
		.toLowerCase();
}

function looksLikeUrl(value: string): boolean {
	return value.includes("https://") || value.includes("http://");
}

function isBrowserExecutable(value: string): boolean {
	return ["chrome", "firefox", "iexplore", "msedge"].includes(value.replace(/\.exe$/u, ""));
}

function isPathWithin(
	root: string,
	candidate: string,
	paths: typeof posix | typeof win32,
): boolean {
	const relativePath = paths.relative(root, candidate);
	return relativePath !== ".."
		&& !relativePath.startsWith(`..${paths.sep}`)
		&& !paths.isAbsolute(relativePath);
}

function parsePosix(command: string, allowWrapper: boolean): ShellParseResult {
	const tokenized = tokenizePosix(command);
	if ("error" in tokenized) return tokenized.error;
	if (tokenized.tokens.length === 0) return invalid("empty command");
	const parsed = buildSegments(tokenized.tokens, "posix");
	if (parsed.kind !== "plain" || !allowWrapper || parsed.segments.length !== 1) return parsed;
	const words = parsed.segments[0]!.words;
	if (words.length === 3
		&& ["bash", "sh", "zsh"].includes(posix.basename(words[0]!))
		&& words[1] === "-lc") {
		return parsePosix(words[2]!, false);
	}
	return parsed;
}

function parseWindows(command: string, shellKind: "powershell" | "cmd"): ShellParseResult {
	const tokenized = tokenizeWindows(command, shellKind);
	if ("error" in tokenized) return tokenized.error;
	if (tokenized.tokens.length === 0) return invalid("empty command");
	return buildSegments(tokenized.tokens, shellKind);
}

function buildSegments(tokens: readonly ShellToken[], shellKind: ShellCommandKind): ShellParseResult {
	const allowed = shellKind === "posix"
		? POSIX_OPERATORS
		: new Set(shellKind === "powershell" ? ["&&", "||", "|", ";"] : ["&&", "||", "|", "&"]);
	const segments: ShellSegment[] = [];
	let words: string[] = [];
	let operatorBefore: string | null = null;
	let effectiveCwd: string | null = null;
	let leadingCdChain = true;
	for (const token of tokens) {
		if (!token.operator) {
			if (shellKind === "posix" && words.length === 0 && ASSIGNMENT.test(token.value)) {
				return complex("assignment");
			}
			if (shellKind === "posix" && !token.quoted && /[*?[\]]/u.test(token.value)) {
				return complex("wildcard");
			}
			words.push(token.value);
			continue;
		}
		if (!allowed.has(token.value)) return complex("unsupported operator");
		if (words.length === 0) return invalid("empty command segment");
		if (shellKind === "posix" && SHELL_KEYWORDS.has(words[0]!)) return complex("shell keyword");
		const current = segment(words, operatorBefore, effectiveCwd);
		segments.push(current);
		if (leadingCdChain && token.value === "&&" && literalCd(words)) {
			effectiveCwd = shellKind === "posix"
				? posix.normalize(effectiveCwd === null ? words[1]! : posix.join(effectiveCwd, words[1]!))
				: win32.normalize(effectiveCwd === null ? words[1]! : win32.join(effectiveCwd, words[1]!));
		} else {
			leadingCdChain = false;
		}
		words = [];
		operatorBefore = token.value;
	}
	if (words.length === 0) return invalid("empty command segment");
	if (shellKind === "posix" && SHELL_KEYWORDS.has(words[0]!)) return complex("shell keyword");
	segments.push(segment(words, operatorBefore, effectiveCwd));
	return plain(segments);
}

function tokenizePosix(command: string): { readonly tokens: readonly ShellToken[] } | { readonly error: ShellParseResult } {
	const stripped = command.trim();
	if (!stripped) return { error: invalid("empty command") };
	const first = /^([A-Za-z]+)\b/u.exec(stripped)?.[1];
	if (first && SHELL_KEYWORDS.has(first)) return { error: complex("shell keyword") };
	const tokens: ShellToken[] = [];
	let current = "";
	let started = false;
	let quoted = false;
	let quote: "'" | '"' | null = null;
	let escaped = false;
	const flush = (): void => {
		if (!started) return;
		tokens.push({ value: current, operator: false, quoted });
		current = "";
		started = false;
		quoted = false;
	};
	for (let index = 0; index < stripped.length; index += 1) {
		const char = stripped[index]!;
		if (escaped) {
			current += char;
			started = true;
			quoted = true;
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (char === "'") quote = null;
			else {
				current += char;
				started = true;
				quoted = true;
			}
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			else if (char === "\\") escaped = true;
			else if (char === "$" || char === "`") return { error: complex("expansion") };
			else {
				current += char;
				started = true;
				quoted = true;
			}
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			quoted = true;
			continue;
		}
		if (char === "$" || char === "`") return { error: complex("expansion") };
		if (/\s/u.test(char)) {
			flush();
			continue;
		}
		if (char === "&" || char === "|") {
			flush();
			const doubled = stripped[index + 1] === char;
			const value = doubled ? `${char}${char}` : char;
			if (value === "&") return { error: complex("background") };
			tokens.push({ value, operator: true, quoted: false });
			if (doubled) index += 1;
			continue;
		}
		if (char === "<" || char === ">") {
			return { error: complex(stripped[index + 1] === "(" ? "grouping" : "redirection") };
		}
		if (char === "(" || char === ")" || char === "{" || char === "}") return { error: complex("grouping") };
		if (char === ";") {
			flush();
			tokens.push({ value: char, operator: true, quoted: false });
			continue;
		}
		current += char;
		started = true;
	}
	if (quote !== null || escaped) return { error: invalid("malformed quoting") };
	flush();
	return { tokens: Object.freeze(tokens) };
}

function tokenizeWindows(
	command: string,
	shellKind: "powershell" | "cmd",
): { readonly tokens: readonly ShellToken[] } | { readonly error: ShellParseResult } {
	const stripped = command.trim();
	if (!stripped) return { error: invalid("empty command") };
	const tokens: ShellToken[] = [];
	let current = "";
	let started = false;
	let quoted = false;
	let quote: "'" | '"' | null = null;
	let escaped = false;
	const escapeChar = shellKind === "powershell" ? "`" : "^";
	const flush = (): void => {
		if (!started) return;
		tokens.push({ value: current, operator: false, quoted });
		current = "";
		started = false;
		quoted = false;
	};
	for (let index = 0; index < stripped.length; index += 1) {
		const char = stripped[index]!;
		if (escaped) {
			current += char;
			started = true;
			quoted = true;
			escaped = false;
			continue;
		}
		if (char === escapeChar) {
			escaped = true;
			continue;
		}
		if (quote !== null) {
			if (char === quote) quote = null;
			else if (shellKind === "powershell" && quote === '"' && char === "$") return { error: complex("expansion") };
			else if (shellKind === "cmd" && (char === "%" || char === "!")) return { error: complex("expansion") };
			else {
				current += char;
				started = true;
				quoted = true;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			quoted = true;
			continue;
		}
		if (shellKind === "powershell" && (char === "$" || char === "@")) return { error: complex("expansion") };
		if (shellKind === "cmd" && (char === "%" || char === "!")) return { error: complex("expansion") };
		if (/\s/u.test(char)) {
			flush();
			continue;
		}
		if (char === "<" || char === ">") return { error: complex("redirection") };
		if (char === "(" || char === ")" || char === "{" || char === "}") return { error: complex("grouping") };
		if (char === "&" || char === "|") {
			flush();
			const doubled = stripped[index + 1] === char;
			const value = doubled ? `${char}${char}` : char;
			if (shellKind === "powershell" && value === "&") return { error: complex("invocation") };
			tokens.push({ value, operator: true, quoted: false });
			if (doubled) index += 1;
			continue;
		}
		if (char === ";" && shellKind === "powershell") {
			flush();
			tokens.push({ value: char, operator: true, quoted: false });
			continue;
		}
		current += char;
		started = true;
	}
	if (quote !== null || escaped) return { error: invalid("malformed quoting") };
	flush();
	return { tokens: Object.freeze(tokens) };
}

function windowsExecutable(value: string): string {
	const name = win32.basename(value).toLowerCase();
	for (const suffix of [".exe", ".cmd", ".bat", ".com"]) {
		if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
	}
	return name;
}

function literalCd(words: readonly string[]): boolean {
	return words.length === 2 && words[0] === "cd" && Boolean(words[1]);
}

function segment(words: readonly string[], operatorBefore: string | null, effectiveCwd: string | null): ShellSegment {
	return Object.freeze({
		words: Object.freeze([...words]),
		operatorBefore,
		effectiveCwd,
	});
}

function plain(segments: readonly ShellSegment[]): ShellParseResult {
	return Object.freeze({ kind: "plain" as const, segments: Object.freeze([...segments]) });
}

function complex(reason: string): ShellParseResult {
	return Object.freeze({ kind: "complex" as const, reason });
}

function invalid(reason: string): ShellParseResult {
	return Object.freeze({ kind: "invalid" as const, reason });
}

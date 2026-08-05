import { posix, win32 } from "node:path";
import type { ExecPolicyRule } from "@mycli/core";
import {
	isKnownSafeShellSegment,
	parseShellArgv,
	parseShellCommand,
	type ShellCommandKind,
} from "./shell-command-policy.ts";

const MAX_PATTERN_TOKENS = 16;
const MAX_PATTERN_TOKEN_CHARS = 256;
const MAX_PATTERN_TOTAL_CHARS = 512;
const SENSITIVE_NAME = /(auth|credential|key|password|secret|token)/iu;
const SENSITIVE_FLAG = /^--?(?:api[-_]?key|auth|credential|key|password|secret|token)(?:=|$)/iu;
const REDACTED_VALUE = /^<?(?:redacted|hidden|masked)>?$/iu;
const PYTHON_EXECUTABLE = /^python(?:\d+(?:\.\d+)*)?$/u;

export type {
	ExecPolicyDecision,
	ExecPolicyRule,
	ExecPolicySource,
} from "@mycli/core";

export interface ExecPolicyProposalInput {
	readonly toolName: string;
	readonly argumentsValue: Readonly<Record<string, unknown>>;
	readonly shellKind: ShellCommandKind;
	readonly rules: readonly ExecPolicyRule[];
	readonly approvalPolicy: string;
}

export interface ExecPolicyProposalValidation {
	readonly pattern?: readonly string[];
	readonly rejectionReason?: string;
}

export function validateExecPolicyProposal(
	input: ExecPolicyProposalInput,
): ExecPolicyProposalValidation {
	if (input.toolName !== "Shell") return reject("legacy shell call");
	if (input.approvalPolicy !== "shell_command_analysis") {
		return reject("approval source is not eligible");
	}
	const pattern = proposedPattern(input.argumentsValue.prefix_rule);
	if (!pattern) return reject("invalid prefix proposal");
	if (containsSensitiveValues(pattern)) return reject("sensitive prefix proposal");
	if (isBroadPattern(pattern, input.shellKind)) return reject("broad prefix proposal");
	if (isDestructivePattern(pattern, input.shellKind)) {
		return reject("destructive prefix proposal");
	}

	const parsed = parseArguments(input.argumentsValue, input.shellKind);
	if (parsed.kind !== "plain") return reject("command is not plain shell syntax");
	for (const segment of parsed.segments) {
		if (!isExactPrefix(pattern, segment.words)) continue;
		const match = matchExecPolicyRule(segment.words, input.rules);
		if (match?.decision === "ask" || match?.decision === "deny") {
			return reject("explicit policy blocks persistence");
		}
		if (!match && !isKnownSafeShellSegment(segment, { shellKind: input.shellKind })) {
			return Object.freeze({ pattern });
		}
	}
	return reject("prefix does not match the segment awaiting approval");
}

function proposedPattern(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATTERN_TOKENS) {
		return undefined;
	}
	if (!value.every((token) => typeof token === "string" && token.trim()
		&& token.length <= MAX_PATTERN_TOKEN_CHARS)) {
		return undefined;
	}
	const pattern = value as string[];
	if (pattern.reduce((total, token) => total + token.length, 0) > MAX_PATTERN_TOTAL_CHARS) {
		return undefined;
	}
	return Object.freeze([...pattern]);
}

function parseArguments(
	argumentsValue: Readonly<Record<string, unknown>>,
	shellKind: ShellCommandKind,
) {
	const args = argumentsValue.args;
	if (Array.isArray(args) && args.length > 0 && args.every((item) => typeof item === "string")) {
		return parseShellArgv(args as string[], { shellKind });
	}
	const command = argumentsValue.command;
	return typeof command === "string" && command
		? parseShellCommand(command, { shellKind })
		: { kind: "invalid" as const, reason: "empty command" };
}

export function matchExecPolicyRule(
	words: readonly string[],
	rules: readonly ExecPolicyRule[],
): ExecPolicyRule | undefined {
	let best: ExecPolicyRule | undefined;
	for (const rule of rules) {
		if (!isExactPrefix(rule.pattern, words)) continue;
		if (!best || rulePrecedence(rule) > rulePrecedence(best)
			|| (rulePrecedence(rule) === rulePrecedence(best)
				&& (rule.pattern.length > best.pattern.length
					|| (rule.pattern.length === best.pattern.length && rule.index >= best.index)))) {
			best = rule;
		}
	}
	return best;
}

function rulePrecedence(rule: ExecPolicyRule): number {
	return { user: 0, project: 1, session: 2 }[rule.source];
}

function isExactPrefix(pattern: readonly string[], words: readonly string[]): boolean {
	return pattern.length <= words.length
		&& pattern.every((token, index) => token === words[index]);
}

function containsSensitiveValues(pattern: readonly string[]): boolean {
	for (let index = 0; index < pattern.length; index += 1) {
		const token = pattern[index]!;
		if (REDACTED_VALUE.test(token)) return true;
		if (SENSITIVE_FLAG.test(token)) {
			if (token.includes("=") || index + 1 < pattern.length) return true;
		}
		const assignment = /^([^=]+)=(.*)$/u.exec(token);
		if (assignment && SENSITIVE_NAME.test(assignment[1]!)) return true;
	}
	return false;
}

function isBroadPattern(pattern: readonly string[], shellKind: ShellCommandKind): boolean {
	const executable = normalize(executableName(pattern[0]!, shellKind), shellKind);
	const comparable = pattern.map((token) => normalize(token, shellKind));
	if (["env", "sudo", "osascript"].includes(executable)) return true;
	if (executable === "py" || PYTHON_EXECUTABLE.test(executable)) {
		return pattern.length === 1 || comparable[1] === "-c";
	}
	if (executable === "node") return pattern.length === 1 || comparable[1] === "-e";
	if (["bash", "sh", "zsh"].includes(executable)) {
		return pattern.length === 1 || comparable[1] === "-c" || comparable[1] === "-lc";
	}
	if (["pwsh", "powershell"].includes(executable)) {
		return pattern.length === 1 || comparable[1] === "-command";
	}
	return false;
}

function isDestructivePattern(pattern: readonly string[], shellKind: ShellCommandKind): boolean {
	const executable = normalize(executableName(pattern[0]!, shellKind), shellKind);
	const comparable = pattern.map((token) => normalize(token, shellKind));
	if ([
		"rm", "rmdir", "del", "erase", "remove-item", "dd", "mkfs", "diskpart",
		"format", "clear-disk", "shutdown", "reboot", "halt", "poweroff",
	].includes(executable)) return true;
	if (executable === "git" && comparable.length >= 2) {
		if (comparable[1] === "clean") return true;
		if (comparable[1] === "reset" && comparable[2] === "--hard") return true;
		if (comparable[1] === "push" && comparable.slice(2).some((token) => [
			"--force", "-f", "--force-with-lease",
		].includes(token))) return true;
	}
	return ["chmod", "chown"].includes(executable)
		&& comparable.slice(1).some((token) => ["-R", "-r", "--recursive"].includes(token));
}

function executableName(value: string, shellKind: ShellCommandKind): string {
	const name = shellKind === "posix" ? posix.basename(value) : win32.basename(value);
	return shellKind !== "posix" && name.toLowerCase().endsWith(".exe")
		? name.slice(0, -4)
		: name;
}

function normalize(value: string, shellKind: ShellCommandKind): string {
	return shellKind === "posix" ? value : value.toLowerCase();
}

function reject(rejectionReason: string): ExecPolicyProposalValidation {
	return Object.freeze({ rejectionReason });
}

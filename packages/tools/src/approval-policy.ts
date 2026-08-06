import {
	isAbsolute,
	posix,
	relative,
	resolve,
	sep,
	win32,
} from "node:path";
import type { ApprovalChoice, CanonicalToolCall } from "@mycli/core";
import {
	matchExecPolicyRule,
	validateExecPolicyProposal,
	type ExecPolicyRule,
} from "./exec-policy-proposal.ts";
import {
	isKnownSafeShellSegment,
	parseShellCommand,
	type ShellCommandKind,
} from "./shell-command-policy.ts";
import { builtinToolManifest } from "./manifest.ts";

const MAX_PREVIEW_CHARS = 512;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
const APPROVAL_OPTIONS = Object.freeze(["approve_once", "reject"] as const);
const SHELL_APPROVAL_OPTIONS = Object.freeze([
	"approve_once",
	"reject",
	"allow_session",
] as const);

export type ApprovalPolicyDecision =
	| ApprovalPolicyAllow
	| ApprovalPolicyRequest
	| ApprovalPolicyDeny;

interface ApprovalPolicyDecisionBase {
	readonly callId: string;
	readonly toolName: string;
	readonly preview: string;
	readonly reason: string;
}

export interface ApprovalPolicyAllow extends ApprovalPolicyDecisionBase {
	readonly kind: "allow";
}

export interface ApprovalPolicyRequest extends ApprovalPolicyDecisionBase {
	readonly kind: "request";
	readonly options: readonly ApprovalChoice[];
	readonly commandPattern?: readonly string[];
	readonly proposedExecPolicyPattern?: readonly string[];
}

export interface ApprovalPolicyDeny extends ApprovalPolicyDecisionBase {
	readonly kind: "deny";
}

export interface ApprovalPolicyOptions {
	readonly workspaceRoot: string;
	readonly autoApproveMedium?: boolean;
	readonly shellKind?: ShellCommandKind;
	readonly platform?: NodeJS.Platform;
	readonly execPolicyRules?: readonly ExecPolicyRule[];
	readonly extensionTools?: readonly ExtensionToolApprovalPolicy[];
}

export interface ExtensionToolApprovalPolicy {
	readonly name: string;
	readonly approvalPolicy: "auto_allow" | "request";
}

export class ApprovalPolicy {
	readonly #workspaceRoot: string;
	readonly #autoApproveMedium: boolean;
	readonly #shellKind: ShellCommandKind;
	readonly #platform: NodeJS.Platform;
	readonly #extensionTools: ReadonlyMap<string, ExtensionToolApprovalPolicy>;
	#execPolicyRules: readonly ExecPolicyRule[];
	#sessionRules: readonly ExecPolicyRule[] = Object.freeze([]);

	constructor(options: ApprovalPolicyOptions) {
		if (!options.workspaceRoot.trim()) {
			throw new TypeError("workspaceRoot must be a non-empty string");
		}
		this.#workspaceRoot = resolve(options.workspaceRoot);
		this.#autoApproveMedium = options.autoApproveMedium ?? true;
		this.#shellKind = options.shellKind ?? (process.platform === "win32" ? "cmd" : "posix");
		this.#platform = options.platform ?? process.platform;
		this.#execPolicyRules = freezeRules(options.execPolicyRules ?? []);
		this.#extensionTools = extensionToolPolicies(options.extensionTools ?? []);
	}

	replaceExecPolicyRules(rules: readonly ExecPolicyRule[]): void {
		this.#execPolicyRules = freezeRules(rules.filter((rule) => rule.source !== "session"));
	}

	allowSession(pattern: readonly string[]): void {
		const normalized = freezePattern(pattern);
		if (this.#sessionRules.some((rule) => equalTokens(rule.pattern, normalized))) return;
		this.#sessionRules = Object.freeze([...this.#sessionRules, Object.freeze({
			source: "session" as const,
			index: this.#sessionRules.length,
			pattern: normalized,
			decision: "allow" as const,
		})]);
	}

	evaluate(call: CanonicalToolCall): ApprovalPolicyDecision {
		const manifest = builtinToolManifest().tools.find((tool) => tool.name === call.name);
		const argumentsValue = parseArguments(call.argumentsJson);
		if (!argumentsValue) {
			return deny(call, "Tool call is not valid for the active policy.");
		}
		if (!manifest) return this.#evaluateExtension(call);
		if (call.name === "Shell" || call.name === "Bash") {
			return this.#evaluateShell(call, argumentsValue, manifest.approval_policy);
		}
		if (manifest.risk_level === "low" && manifest.approval_policy === "auto_allow") {
			return allow(call, `${manifest.name} workspace input`);
		}
		if (manifest.risk_level !== "medium" || manifest.effects.filesystem !== "write") {
			return deny(call, "Tool is not supported by the active approval policy.");
		}

		const path = mutationPath(argumentsValue);
		const projected = path ? this.#projectWorkspacePath(path) : undefined;
		if (!projected) {
			return deny(call, "Mutation target is outside the workspace.");
		}
		const preview = bounded(`${manifest.name} ${projected}`);
		if (this.#autoApproveMedium) {
			return allow(call, preview);
		}
		return Object.freeze({
			kind: "request" as const,
			callId: call.callId,
			toolName: call.name,
			preview,
			reason: "Workspace mutation requires one-time approval.",
			options: APPROVAL_OPTIONS,
		});
	}

	#evaluateExtension(call: CanonicalToolCall): ApprovalPolicyDecision {
		const policy = this.#extensionTools.get(call.name);
		if (!policy) return deny(call, "Tool call is not valid for the active policy.");
		if (policy.approvalPolicy === "auto_allow") {
			return allow(call, `${call.name} local integration`);
		}
		return Object.freeze({
			kind: "request" as const,
			callId: call.callId,
			toolName: call.name,
			preview: bounded(`${call.name} integration request`),
			reason: "External integration requires one-time approval.",
			options: APPROVAL_OPTIONS,
		});
	}

	#evaluateShell(
		call: CanonicalToolCall,
		argumentsValue: Readonly<Record<string, unknown>>,
		approvalPolicy: string,
	): ApprovalPolicyDecision {
		const command = argumentsValue.command;
		if (typeof command !== "string" || !command.trim()) {
			return deny(call, "Shell command is not valid for the active policy.");
		}
		const parsed = parseShellCommand(command, { shellKind: this.#shellKind });
		if (parsed.kind !== "plain") {
			return shellRequest(call, undefined, undefined, parsed.reason, APPROVAL_OPTIONS);
		}
		const rules = Object.freeze([...this.#execPolicyRules, ...this.#sessionRules]);
		for (const segment of parsed.segments) {
			const match = matchExecPolicyRule(segment.words, rules);
			if (match?.decision === "deny") {
				return deny(call, "Shell command is denied by an explicit execution rule.");
			}
			if (match?.decision === "ask") {
				return shellRequest(
					call,
					undefined,
					undefined,
					"Shell command requires approval by an explicit execution rule.",
					APPROVAL_OPTIONS,
				);
			}
			if (match?.decision === "allow" || isKnownSafeShellSegment(segment, {
				shellKind: this.#shellKind,
				platform: this.#platform,
			})) continue;

			const commandPattern = boundedPattern(segment.words.slice(0, 3));
			const proposal = validateExecPolicyProposal({
				toolName: call.name,
				argumentsValue,
				shellKind: this.#shellKind,
				rules,
				approvalPolicy,
			});
			const proposed = proposal.pattern;
			return shellRequest(
				call,
				commandPattern,
				proposed,
				"Unknown Shell command requires approval.",
				proposed
					? Object.freeze([...SHELL_APPROVAL_OPTIONS, "always_allow"] as const)
					: SHELL_APPROVAL_OPTIONS,
			);
		}
		return allow(call, `${call.name} command allowed`);
	}

	#projectWorkspacePath(rawPath: string): string | undefined {
		const normalized = rawPath.trim();
		if (!normalized || normalized.includes("\0") || WINDOWS_ABSOLUTE_PATH.test(normalized)) {
			return undefined;
		}
		const candidate = resolve(this.#workspaceRoot, normalized);
		const projected = relative(this.#workspaceRoot, candidate);
		if (!projected || projected === ".." || projected.startsWith(`..${sep}`) || isAbsolute(projected)) {
			return undefined;
		}
		return projected.split(sep).join("/");
	}
}

function shellRequest(
	call: CanonicalToolCall,
	commandPattern: readonly string[] | undefined,
	proposedExecPolicyPattern: readonly string[] | undefined,
	reason: string,
	options: readonly ApprovalChoice[],
): ApprovalPolicyRequest {
	const executable = commandPattern?.[0] ?? proposedExecPolicyPattern?.[0];
	const name = executable
		? (process.platform === "win32" ? win32.basename(executable) : posix.basename(executable))
		: "command";
	return Object.freeze({
		kind: "request" as const,
		callId: call.callId,
		toolName: call.name,
		preview: bounded(`${call.name} ${name} requires approval`),
		reason,
		options,
		...(commandPattern ? { commandPattern } : {}),
		...(proposedExecPolicyPattern ? { proposedExecPolicyPattern } : {}),
	});
}

function freezeRules(rules: readonly ExecPolicyRule[]): readonly ExecPolicyRule[] {
	return Object.freeze(rules.map((rule) => Object.freeze({
		...rule,
		pattern: freezePattern(rule.pattern),
	})));
}

function extensionToolPolicies(
	policies: readonly ExtensionToolApprovalPolicy[],
): ReadonlyMap<string, ExtensionToolApprovalPolicy> {
	const result = new Map<string, ExtensionToolApprovalPolicy>();
	for (const policy of policies) {
		if (!/^[A-Za-z0-9_]{1,128}$/u.test(policy.name)
			|| (policy.approvalPolicy !== "auto_allow" && policy.approvalPolicy !== "request")) {
			throw new TypeError("invalid extension tool approval policy");
		}
		if (result.has(policy.name)) throw new TypeError("duplicate extension tool approval policy");
		result.set(policy.name, Object.freeze({ ...policy }));
	}
	return result;
}

function freezePattern(pattern: readonly string[]): readonly string[] {
	if (pattern.length === 0 || pattern.length > 16
		|| pattern.some((token) => typeof token !== "string" || !token.trim() || token.length > 256)
		|| pattern.reduce((total, token) => total + token.length, 0) > 512) {
		throw new TypeError("exec policy pattern must be a bounded non-empty string array");
	}
	return Object.freeze([...pattern]);
}

function boundedPattern(pattern: readonly string[]): readonly string[] | undefined {
	try {
		return freezePattern(pattern);
	} catch {
		return undefined;
	}
}

function equalTokens(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((token, index) => token === right[index]);
}

function parseArguments(value: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const parsed = JSON.parse(value) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? parsed as Readonly<Record<string, unknown>>
			: undefined;
	} catch {
		return undefined;
	}
}

function mutationPath(argumentsValue: Readonly<Record<string, unknown>>): string | undefined {
	const value = argumentsValue.file_path ?? argumentsValue.path ?? argumentsValue.target;
	return typeof value === "string" ? value : undefined;
}

function allow(call: CanonicalToolCall, preview: string): ApprovalPolicyAllow {
	return Object.freeze({
		kind: "allow" as const,
		callId: call.callId,
		toolName: call.name,
		preview: bounded(preview),
		reason: "Tool is allowed by the active policy.",
	});
}

function deny(call: CanonicalToolCall, reason: string): ApprovalPolicyDeny {
	return Object.freeze({
		kind: "deny" as const,
		callId: call.callId,
		toolName: call.name.slice(0, 128) || "Tool",
		preview: bounded(`${call.name.slice(0, 128) || "Tool"} denied`),
		reason,
	});
}

function bounded(value: string): string {
	return value.slice(0, MAX_PREVIEW_CHARS);
}

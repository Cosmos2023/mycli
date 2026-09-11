import {
	isAbsolute,
	posix,
	relative,
	resolve,
	sep,
	win32,
} from "node:path";
import type {
	ApprovalChoice,
	ApprovalPreviewDetails,
	CanonicalToolCall,
	PermissionRequestProfile,
} from "@mycli/core";
import {
	matchExecPolicyRule,
	validateExecPolicyProposal,
	type ExecPolicyRule,
} from "./exec-policy-proposal.ts";
import {
	isKnownDangerousShellSegment,
	isKnownSafeShellSegment,
	parseShellCommand,
	type ShellCommandKind,
} from "./shell-command-policy.ts";
import {
	hasUnrestrictedFilesystem,
	type ExecutionPolicy,
	type PermissionProfile,
} from "./execution-policy.ts";
import {
	mutationSandboxRetryFingerprint,
	parseFileSandboxRequest,
} from "../files/file-sandbox-permissions.ts";
import { builtinToolManifest } from "../registry/manifest.ts";
import {
	isValidShellJustification,
	parseShellSandboxPermissions,
	SHELL_JUSTIFICATION_MAX_CHARS,
} from "../shell/shell-sandbox-permissions.ts";
import {
	parsePermissionRequest,
	pathWithinRoot,
	permissionRequestPreview,
	permissionRequestSatisfied,
	REQUEST_PERMISSIONS_TOOL_NAME,
} from "./permission-grants.ts";
import type { ToolExecutionResult } from "../types.ts";

const MAX_PREVIEW_CHARS = 512;
const MAX_APPROVAL_DETAIL_CHARS = 12_000;
const MAX_APPROVAL_DIFF_SIDE_CHARS = 5_800;
const MAX_APPROVAL_DIFF_SIDE_LINES = 5;
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
	readonly sandboxOverrideApproved?: boolean;
}

export interface ApprovalPolicyRequest extends ApprovalPolicyDecisionBase {
	readonly kind: "request";
	readonly options: readonly ApprovalChoice[];
	readonly commandPattern?: readonly string[];
	readonly proposedExecPolicyPattern?: readonly string[];
	readonly permissionRequest?: PermissionRequestProfile;
}

export interface ApprovalPolicyDeny extends ApprovalPolicyDecisionBase {
	readonly kind: "deny";
	readonly errorKind?: string;
}

export interface ApprovalPolicyOptions {
	readonly workspaceRoot: string;
	readonly autoApproveMedium?: boolean;
	readonly permissionProfile?: PermissionProfile;
	readonly shellKind?: ShellCommandKind;
	readonly platform?: NodeJS.Platform;
	readonly execPolicyRules?: readonly ExecPolicyRule[];
	readonly extensionTools?: readonly ExtensionToolApprovalPolicy[];
}

export interface ExtensionToolApprovalPolicy {
	readonly name: string;
	readonly approvalPolicy: "auto_allow" | "request";
}

export function fileMutationApprovalPreview(
	call: CanonicalToolCall,
): ApprovalPreviewDetails {
	const argumentsValue = parseArguments(call.argumentsJson);
	if (!argumentsValue) return Object.freeze({});
	const normalizedName = call.name.trim().toLowerCase().replaceAll("_", "").replaceAll("-", "");
	if (normalizedName === "write" || normalizedName === "writefile") {
		const content = argumentsValue.content ?? argumentsValue.new_content;
		if (typeof content !== "string") return Object.freeze({});
		const boundedContent = boundedApprovalDetail(content);
		return Object.freeze({
			contentPreview: boundedContent.value,
			contentLineCount: approvalLineCount(content),
			contentChars: content.length,
			contentTruncated: boundedContent.truncated,
		});
	}
	if (!["edit", "editfile", "patch", "patchfile"].includes(normalizedName)) {
		return Object.freeze({});
	}
	const oldString = argumentsValue.old_string;
	const newString = argumentsValue.new_string;
	if (typeof oldString !== "string" || typeof newString !== "string") {
		return Object.freeze({});
	}
	const proposed = proposedReplacementDiff(oldString, newString);
	if (!proposed.value) return Object.freeze({});
	return Object.freeze({
		diff: proposed.value,
		diffChars: proposed.chars,
		diffTruncated: proposed.truncated,
	});
}

export class ApprovalPolicy {
	readonly #workspaceRoot: string;
	readonly #autoApproveMedium: boolean;
	readonly #shellKind: ShellCommandKind;
	readonly #platform: NodeJS.Platform;
	#extensionTools: ReadonlyMap<string, ExtensionToolApprovalPolicy>;
	readonly #turnExtensionTools = new Map<string, ReadonlyMap<string, ExtensionToolApprovalPolicy>>();
	readonly #mutationSandboxRetries = new Map<string, Set<string>>();
	#permissionProfile: PermissionProfile;
	#execPolicyRules: readonly ExecPolicyRule[];
	#sessionRules: readonly ExecPolicyRule[] = Object.freeze([]);

	constructor(options: ApprovalPolicyOptions) {
		if (!options.workspaceRoot.trim()) {
			throw new TypeError("workspaceRoot must be a non-empty string");
		}
		this.#workspaceRoot = resolve(options.workspaceRoot);
		this.#autoApproveMedium = options.autoApproveMedium ?? true;
		this.#permissionProfile = options.permissionProfile ?? "workspace";
		this.#shellKind = options.shellKind ?? (process.platform === "win32" ? "cmd" : "posix");
		this.#platform = options.platform ?? process.platform;
		this.#execPolicyRules = freezeRules(options.execPolicyRules ?? []);
		this.#extensionTools = extensionToolPolicies(options.extensionTools ?? []);
	}

	configurePermissionProfile(profile: PermissionProfile): void {
		this.#permissionProfile = profile;
	}

	beginTurn(turnId: string): void {
		if (!this.#turnExtensionTools.has(turnId)) {
			this.#turnExtensionTools.set(turnId, this.#extensionTools);
		}
		if (!this.#mutationSandboxRetries.has(turnId)) {
			this.#mutationSandboxRetries.set(turnId, new Set());
		}
	}

	finishTurn(turnId: string): void {
		this.#turnExtensionTools.delete(turnId);
		this.#mutationSandboxRetries.delete(turnId);
	}

	replaceExtensionTools(tools: readonly ExtensionToolApprovalPolicy[]): void {
		this.#extensionTools = extensionToolPolicies(tools);
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

	listSessionAllowances(): readonly (readonly string[])[] {
		return Object.freeze(this.#sessionRules.map((rule) => Object.freeze([...rule.pattern])));
	}

	removeSessionAllowance(pattern: readonly string[]): boolean {
		const normalized = freezePattern(pattern);
		const filtered = this.#sessionRules.filter((rule) => !equalTokens(rule.pattern, normalized));
		if (filtered.length === this.#sessionRules.length) return false;
		this.#sessionRules = Object.freeze(filtered.map((rule, index) => Object.freeze({
			...rule,
			index,
		})));
		return true;
	}

	clearSessionAllowances(): number {
		const count = this.#sessionRules.length;
		this.#sessionRules = Object.freeze([]);
		return count;
	}

	evaluate(
		call: CanonicalToolCall,
		executionPolicy?: ExecutionPolicy,
		turnId?: string,
	): ApprovalPolicyDecision {
		const fullAccess = executionPolicy === undefined
			? this.#permissionProfile === "full-access"
			: hasUnrestrictedFilesystem(executionPolicy);
		const manifest = builtinToolManifest().tools.find((tool) => tool.name === call.name);
		const argumentsValue = parseArguments(call.argumentsJson);
		if (!argumentsValue) {
			return deny(call, "Tool call is not valid for the active policy.");
		}
		if (!manifest) return this.#evaluateExtension(call, fullAccess, turnId);
		if (call.name === REQUEST_PERMISSIONS_TOOL_NAME) {
			const request = parsePermissionRequest(argumentsValue, this.#workspaceRoot);
			if (!request.ok) {
				return deny(
					call,
					"Permission request is not valid for the active policy.",
					request.errorKind,
				);
			}
			if (permissionRequestSatisfied(request.permissions, executionPolicy)) {
				return allow(call, "Requested permissions are already available");
			}
			return Object.freeze({
				kind: "request" as const,
				callId: call.callId,
				toolName: call.name,
				preview: permissionRequestPreview(request.permissions),
				reason: request.reason ?? "The agent requested additional permissions.",
				options: SHELL_APPROVAL_OPTIONS,
				permissionRequest: request.permissions,
			});
		}
		if (call.name === "Shell" || call.name === "Bash") {
			return this.#evaluateShell(call, argumentsValue, manifest.approval_policy, fullAccess);
		}
		if (manifest.risk_level === "low" && manifest.approval_policy === "auto_allow") {
			return allow(call, `${manifest.name} workspace input`);
		}
		if (manifest.risk_level !== "medium" || manifest.effects.filesystem !== "write") {
			return deny(call, "Tool is not supported by the active approval policy.");
		}

		const sandbox = parseFileSandboxRequest(argumentsValue);
		if (!sandbox.ok) {
			return deny(call, sandbox.errorKind === "invalid_sandbox_permissions"
				? "File sandbox permissions are not valid for the active policy."
				: "File sandbox justification is not valid for the active policy.", sandbox.errorKind);
		}
		const paths = mutationPaths(argumentsValue);
		const projected = paths.map((path) => this.#projectWorkspacePath(path));
		const permittedByRoots = executionPolicy !== undefined
			&& paths.every((path) => this.#pathAllowedByPolicy(path, executionPolicy));
		const previewTarget = mutationPreviewTarget(
			manifest.name,
			paths,
			projected,
			fullAccess || permittedByRoots,
		);
		if (sandbox.permissions === "danger-full-access") {
			const escalationTarget = mutationPreviewTarget(manifest.name, paths, projected, true);
			if (!escalationTarget) {
				return deny(call, "Mutation target is not valid for sandbox escalation.", "workspace_escape");
			}
			if (fullAccess) return allow(call, bounded(escalationTarget));
			if (!this.#consumeMutationSandboxRetry(call, turnId)) {
				return deny(
					call,
					"Full access is only valid as a one-time retry after workspace confinement denied the same operation.",
					"sandbox_override_not_approved",
				);
			}
			return Object.freeze({
				kind: "request" as const,
				callId: call.callId,
				toolName: call.name,
				preview: bounded(escalationTarget),
				reason: bounded(sandbox.justification),
				options: APPROVAL_OPTIONS,
			});
		}
		if (!previewTarget) {
			this.#rememberMutationSandboxDenial(call, turnId);
			return deny(call, "Mutation target is outside the workspace.", "workspace_escape");
		}
		const preview = bounded(previewTarget);
		if (fullAccess || this.#autoApproveMedium) {
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

	recordResult(
		call: CanonicalToolCall,
		result: ToolExecutionResult,
		executionPolicy?: ExecutionPolicy,
		turnId?: string,
	): void {
		if (result.errorKind !== "workspace_escape"
			|| (executionPolicy === undefined
				? this.#permissionProfile === "full-access"
				: hasUnrestrictedFilesystem(executionPolicy))) return;
		const argumentsValue = parseArguments(call.argumentsJson);
		if (!argumentsValue) return;
		const sandbox = parseFileSandboxRequest(argumentsValue);
		if (!sandbox.ok || sandbox.permissions !== "workspace-write") return;
		this.#rememberMutationSandboxDenial(call, turnId);
	}

	#evaluateExtension(
		call: CanonicalToolCall,
		fullAccess: boolean,
		turnId?: string,
	): ApprovalPolicyDecision {
		const policies = turnId ? this.#turnExtensionTools.get(turnId) ?? this.#extensionTools : this.#extensionTools;
		const policy = policies.get(call.name);
		if (!policy) return deny(call, "Tool call is not valid for the active policy.");
		if (policy.approvalPolicy === "auto_allow" || fullAccess) {
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
		fullAccess: boolean,
	): ApprovalPolicyDecision {
		const command = argumentsValue.command;
		if (typeof command !== "string" || !command.trim()) {
			return deny(call, "Shell command is not valid for the active policy.");
		}
		if (call.name === "Shell" && argumentsValue.justification !== undefined
			&& !isValidShellJustification(argumentsValue.justification)) {
			return deny(call,
				`Shell justification must be a non-empty string of at most ${SHELL_JUSTIFICATION_MAX_CHARS} characters.`,
				"invalid_arguments");
		}
		const sandboxPermissions = call.name === "Shell"
			? parseShellSandboxPermissions(argumentsValue.sandbox_permissions)
			: "use_default";
		if (!sandboxPermissions) {
			return deny(
				call,
				"Shell sandbox permissions are not valid for the active policy.",
				"invalid_sandbox_permissions",
			);
		}
		const requestsSandboxOverride = sandboxPermissions === "require_escalated";
		const parsed = parseShellCommand(command, { shellKind: this.#shellKind });
		const rules = Object.freeze([...this.#execPolicyRules, ...this.#sessionRules]);
		if (parsed.kind === "invalid") {
			return deny(call, `Shell command is invalid: ${parsed.reason}.`);
		}
		if (parsed.kind === "complex") {
			if (fullAccess) {
				const hasRestrictiveRule = rules.some((rule) => rule.decision !== "allow");
				return hasRestrictiveRule
					? deny(call, "Complex Shell command cannot be checked against an explicit execution rule.")
					: allow(call, `${call.name} full-access command`);
			}
			return shellRequest(
				call,
				undefined,
				undefined,
				"This command uses shell syntax that requires manual review.",
				APPROVAL_OPTIONS,
			);
		}
		for (const segment of parsed.segments) {
			const match = matchExecPolicyRule(segment.words, rules);
			if (match?.decision === "deny") {
				return deny(call, "Shell command is denied by an explicit execution rule.");
			}
			if (match?.decision === "ask") {
				if (fullAccess) {
					return deny(call, "Shell command is blocked because full access does not surface approval prompts.");
				}
				return shellRequest(
					call,
					undefined,
					undefined,
					"An execution rule requires your approval for this command.",
					APPROVAL_OPTIONS,
				);
			}
			if (match?.decision === "allow") continue;
			if (requestsSandboxOverride && !fullAccess) {
				return this.#shellApprovalRequest(
					call,
					argumentsValue,
					approvalPolicy,
					rules,
					segment.words,
					"This command requests broader permissions than currently allowed.",
				);
			}
			if (isKnownSafeShellSegment(segment, {
				shellKind: this.#shellKind,
				platform: this.#platform,
				workspaceRoot: this.#workspaceRoot,
			})) continue;
			if (fullAccess) continue;
			const dangerous = isKnownDangerousShellSegment(segment, {
				shellKind: this.#shellKind,
			});
			if (call.name === "Shell" && !dangerous) continue;
			return this.#shellApprovalRequest(
				call,
				argumentsValue,
				approvalPolicy,
				rules,
				segment.words,
				dangerous
					? "This command was flagged as potentially risky."
					: "This command could not be verified as safe to run automatically.",
			);
		}
		return allow(call, `${call.name} command allowed`, requestsSandboxOverride);
	}

	#shellApprovalRequest(
		call: CanonicalToolCall,
		argumentsValue: Readonly<Record<string, unknown>>,
		approvalPolicy: string,
		rules: readonly ExecPolicyRule[],
		words: readonly string[],
		reason: string,
	): ApprovalPolicyRequest {
		const commandPattern = boundedPattern(words.slice(0, 3));
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
			reason,
			proposed
				? Object.freeze([...SHELL_APPROVAL_OPTIONS, "always_allow"] as const)
				: SHELL_APPROVAL_OPTIONS,
		);
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

	#pathAllowedByPolicy(rawPath: string, policy: ExecutionPolicy): boolean {
		const normalized = rawPath.trim();
		if (!normalized || normalized.includes("\0") || WINDOWS_ABSOLUTE_PATH.test(normalized)) {
			return false;
		}
		const candidate = isAbsolute(normalized)
			? resolve(normalized)
			: resolve(this.#workspaceRoot, normalized);
		return policy.writableRoots.some((root) => pathWithinRoot(root, candidate));
	}

	#rememberMutationSandboxDenial(call: CanonicalToolCall, turnId: string | undefined): void {
		if (!turnId) return;
		const retries = this.#mutationSandboxRetries.get(turnId);
		const fingerprint = mutationSandboxRetryFingerprint(call);
		if (retries && fingerprint) retries.add(fingerprint);
	}

	#consumeMutationSandboxRetry(call: CanonicalToolCall, turnId: string | undefined): boolean {
		if (!turnId) return false;
		const retries = this.#mutationSandboxRetries.get(turnId);
		const fingerprint = mutationSandboxRetryFingerprint(call);
		return retries !== undefined && fingerprint !== undefined && retries.delete(fingerprint);
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

function boundedApprovalDetail(value: string): { readonly value: string; readonly truncated: boolean } {
	return {
		value: value.slice(0, MAX_APPROVAL_DETAIL_CHARS),
		truncated: value.length > MAX_APPROVAL_DETAIL_CHARS,
	};
}

function approvalLineCount(value: string): number {
	if (!value) return 0;
	const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	return normalized.split("\n").length - (normalized.endsWith("\n") ? 1 : 0);
}

function proposedReplacementDiff(
	oldString: string,
	newString: string,
): { readonly value: string; readonly chars: number; readonly truncated: boolean } {
	const removedLines = approvalPreviewLines(oldString);
	const addedLines = approvalPreviewLines(newString);
	const removed = proposedDiffSide(removedLines, "-", "removed");
	const added = proposedDiffSide(addedLines, "+", "added");
	const combined = [removed.value, added.value].filter(Boolean).join("\n");
	const value = combined.slice(0, MAX_APPROVAL_DETAIL_CHARS);
	const lineCount = removedLines.length + addedLines.length;
	const chars = [...removedLines, ...addedLines]
		.reduce((total, line) => total + line.length + 1, Math.max(0, lineCount - 1));
	return {
		value,
		chars,
		truncated: removed.truncated || added.truncated || combined.length > MAX_APPROVAL_DETAIL_CHARS,
	};
}

function approvalPreviewLines(value: string): readonly string[] {
	const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	if (!normalized) return [];
	const lines = normalized.split("\n");
	if (normalized.endsWith("\n")) lines.pop();
	return lines;
}

function proposedDiffSide(
	lines: readonly string[],
	prefix: "-" | "+",
	label: "removed" | "added",
): { readonly value: string; readonly truncated: boolean } {
	if (lines.length === 0) return { value: "", truncated: false };
	const selected = lines.slice(0, MAX_APPROVAL_DIFF_SIDE_LINES);
	const rendered = selected.map((line) => `${prefix}${line}`).join("\n");
	const truncated = lines.length > selected.length || rendered.length > MAX_APPROVAL_DIFF_SIDE_CHARS;
	if (!truncated) return { value: rendered, truncated: false };
	const omittedLines = Math.max(0, lines.length - selected.length);
	const marker = omittedLines > 0
		? `... ${omittedLines} ${label} ${omittedLines === 1 ? "line" : "lines"} omitted ...`
		: `... ${label} content truncated ...`;
	const retainedChars = Math.max(0, MAX_APPROVAL_DIFF_SIDE_CHARS - marker.length - 1);
	return {
		value: `${rendered.slice(0, retainedChars)}\n${marker}`,
		truncated: true,
	};
}

function mutationPaths(argumentsValue: Readonly<Record<string, unknown>>): readonly string[] {
	const value = argumentsValue.file_path ?? argumentsValue.path ?? argumentsValue.target;
	if (typeof value === "string") return Object.freeze([value]);
	if (!Array.isArray(argumentsValue.operations)) return Object.freeze([]);
	const paths: string[] = [];
	for (const operationValue of argumentsValue.operations) {
		if (!isRecord(operationValue)) return Object.freeze([]);
		if (operationValue.type === "move") {
			if (typeof operationValue.from_path !== "string"
				|| typeof operationValue.to_path !== "string") return Object.freeze([]);
			paths.push(operationValue.from_path, operationValue.to_path);
			continue;
		}
		if (typeof operationValue.file_path !== "string") return Object.freeze([]);
		paths.push(operationValue.file_path);
	}
	return Object.freeze(paths);
}

function mutationPreviewTarget(
	toolName: string,
	paths: readonly string[],
	projected: readonly (string | undefined)[],
	allowBasename: boolean,
): string | undefined {
	if (paths.length === 0 || projected.length !== paths.length) return undefined;
	const displayPaths = paths.map((path, index) => projected[index]
		?? (allowBasename ? mutationPreviewPath(path) : undefined));
	if (displayPaths.some((path) => !path)) return undefined;
	const unique = new Set(displayPaths);
	return unique.size === 1
		? `${toolName} ${displayPaths[0]}`
		: `${toolName} ${unique.size} files`;
}

function mutationPreviewPath(rawPath: string): string | undefined {
	const normalized = rawPath.trim();
	if (!normalized || normalized.includes("\0")) return undefined;
	return posix.basename(normalized.replaceAll("\\", "/")) || "file";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allow(
	call: CanonicalToolCall,
	preview: string,
	sandboxOverrideApproved = false,
): ApprovalPolicyAllow {
	return Object.freeze({
		kind: "allow" as const,
		callId: call.callId,
		toolName: call.name,
		preview: bounded(preview),
		reason: "Tool is allowed by the active policy.",
		...(sandboxOverrideApproved ? { sandboxOverrideApproved: true } : {}),
	});
}

function deny(
	call: CanonicalToolCall,
	reason: string,
	errorKind?: string,
): ApprovalPolicyDeny {
	return Object.freeze({
		kind: "deny" as const,
		callId: call.callId,
		toolName: call.name.slice(0, 128) || "Tool",
		preview: bounded(`${call.name.slice(0, 128) || "Tool"} denied`),
		reason,
		...(errorKind ? { errorKind } : {}),
	});
}

function bounded(value: string): string {
	return value.slice(0, MAX_PREVIEW_CHARS);
}

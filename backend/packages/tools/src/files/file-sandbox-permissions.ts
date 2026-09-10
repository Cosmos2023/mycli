import {
	modelInputSha256,
	type CanonicalToolCall,
} from "@mycli/core";
import {
	hasUnrestrictedFilesystem,
	type ExecutionPolicy,
} from "../policy/execution-policy.ts";

export const FILE_SANDBOX_JUSTIFICATION_MAX_CHARS = 512;

export type FileSandboxArgumentErrorKind =
	| "invalid_sandbox_permissions"
	| "invalid_justification"
	| "sandbox_override_not_approved";

export type FileSandboxRequest =
	| {
		readonly ok: true;
		readonly permissions: "workspace-write";
	}
	| {
		readonly ok: true;
		readonly permissions: "danger-full-access";
		readonly justification: string;
	}
	| {
		readonly ok: false;
		readonly errorKind: Exclude<FileSandboxArgumentErrorKind, "sandbox_override_not_approved">;
	};

export type FileSandboxAccess =
	| {
		readonly ok: true;
		readonly allowOutsideWorkspace: boolean;
		readonly allowedWritableRoots: readonly string[];
	}
	| {
		readonly ok: false;
		readonly errorKind: FileSandboxArgumentErrorKind;
	};

const FILE_MUTATION_TOOLS = new Set(["Write", "Edit", "Patch"]);

export function parseFileSandboxRequest(
	argumentsValue: Readonly<Record<string, unknown>>,
): FileSandboxRequest {
	const permissions = argumentsValue.sandbox_permissions ?? "workspace-write";
	if (permissions !== "workspace-write" && permissions !== "danger-full-access") {
		return { ok: false, errorKind: "invalid_sandbox_permissions" };
	}
	const justification = argumentsValue.justification;
	if (permissions === "workspace-write") {
		return { ok: true, permissions };
	}
	if (typeof justification !== "string"
		|| !justification.trim()
		|| justification.length > FILE_SANDBOX_JUSTIFICATION_MAX_CHARS) {
		return { ok: false, errorKind: "invalid_justification" };
	}
	return {
		ok: true,
		permissions,
		justification: justification.trim(),
	};
}

export function resolveFileSandboxAccess(
	argumentsValue: Readonly<Record<string, unknown>>,
	options: Readonly<{
		readonly executionPolicy?: ExecutionPolicy;
		readonly sandboxOverrideApproved?: boolean;
		readonly sandboxOverridePolicy?: ExecutionPolicy;
	}>,
): FileSandboxAccess {
	const request = parseFileSandboxRequest(argumentsValue);
	if (!request.ok) return request;
	const unrestricted = hasUnrestrictedFilesystem(options.executionPolicy);
	if (request.permissions === "danger-full-access"
		&& !unrestricted
		&& (options.executionPolicy === undefined || options.sandboxOverrideApproved !== true)) {
		return { ok: false, errorKind: "sandbox_override_not_approved" };
	}
	const effectivePolicy = request.permissions === "danger-full-access"
		&& options.sandboxOverrideApproved === true
		&& options.sandboxOverridePolicy
		? options.sandboxOverridePolicy
		: options.executionPolicy;
	return {
		ok: true,
		allowOutsideWorkspace: hasUnrestrictedFilesystem(effectivePolicy)
			|| (request.permissions === "danger-full-access"
				&& options.sandboxOverrideApproved === true
				&& options.sandboxOverridePolicy === undefined),
		allowedWritableRoots: Object.freeze([...(effectivePolicy?.writableRoots ?? [])]),
	};
}

export function mutationCallRequestsSandboxOverride(call: CanonicalToolCall): boolean {
	if (!FILE_MUTATION_TOOLS.has(call.name)) return false;
	const argumentsValue = parseArguments(call.argumentsJson);
	if (!argumentsValue) return false;
	const request = parseFileSandboxRequest(argumentsValue);
	return request.ok && request.permissions === "danger-full-access";
}

export function mutationSandboxRetryFingerprint(
	call: CanonicalToolCall,
): string | undefined {
	if (!FILE_MUTATION_TOOLS.has(call.name)) return undefined;
	const argumentsValue = parseArguments(call.argumentsJson);
	if (!argumentsValue || !parseFileSandboxRequest(argumentsValue).ok) return undefined;
	const operationArguments = Object.fromEntries(Object.entries(argumentsValue).filter(
		([name]) => name !== "sandbox_permissions" && name !== "justification",
	));
	return `sha256:${modelInputSha256({
		tool_name: call.name,
		arguments: operationArguments,
	})}`;
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

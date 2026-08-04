import {
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";
import type { CanonicalToolCall } from "@mycli/core";
import { builtinToolManifest } from "./manifest.ts";

const MAX_PREVIEW_CHARS = 512;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
const APPROVAL_OPTIONS = Object.freeze(["approve_once", "reject"] as const);

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
	readonly options: readonly ["approve_once", "reject"];
}

export interface ApprovalPolicyDeny extends ApprovalPolicyDecisionBase {
	readonly kind: "deny";
}

export interface ApprovalPolicyOptions {
	readonly workspaceRoot: string;
	readonly autoApproveMedium?: boolean;
}

export class ApprovalPolicy {
	readonly #workspaceRoot: string;
	readonly #autoApproveMedium: boolean;

	constructor(options: ApprovalPolicyOptions) {
		if (!options.workspaceRoot.trim()) {
			throw new TypeError("workspaceRoot must be a non-empty string");
		}
		this.#workspaceRoot = resolve(options.workspaceRoot);
		this.#autoApproveMedium = options.autoApproveMedium ?? true;
	}

	evaluate(call: CanonicalToolCall): ApprovalPolicyDecision {
		const manifest = builtinToolManifest().tools.find((tool) => tool.name === call.name);
		const argumentsValue = parseArguments(call.argumentsJson);
		if (!manifest || !argumentsValue) {
			return deny(call, "Tool call is not valid for the active policy.");
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

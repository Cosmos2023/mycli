import {
	parsePermissionRequest,
	permissionRequestJson,
	permissionRequestSatisfied,
} from "./permission-grants.ts";
import { REQUEST_PERMISSIONS_TOOL_DEFINITION } from "../registry/manifest.ts";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "../types.ts";

export interface RequestPermissionsToolOptions {
	readonly workspaceRoot: string;
}

export class RequestPermissionsTool implements ToolAdapter {
	readonly definition = REQUEST_PERMISSIONS_TOOL_DEFINITION;
	readonly #workspaceRoot: string;

	constructor(options: RequestPermissionsToolOptions) {
		if (!options.workspaceRoot.trim()) throw new TypeError("workspaceRoot must be non-empty");
		this.#workspaceRoot = options.workspaceRoot;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		const parsed = parsePermissionRequest(argumentsValue, this.#workspaceRoot);
		if (!parsed.ok) return failure(parsed.errorKind);
		const grant = options.permissionGrant;
		if (!grant) {
			if (!permissionRequestSatisfied(parsed.permissions, options.executionPolicy, this.#workspaceRoot)) {
				return failure("permission_grant_not_approved");
			}
			return success(parsed.permissions, "turn", false, true);
		}
		return success(grant.permissions, grant.scope, grant.constrained, false);
	}
}

function success(
	permissions: Parameters<typeof permissionRequestJson>[0],
	scope: "turn" | "session",
	constrained: boolean,
	alreadyGranted: boolean,
): ToolAdapterResult {
	const response = Object.freeze({
		permissions: permissionRequestJson(permissions),
		scope,
		...(constrained ? { constrained: true } : {}),
		...(alreadyGranted ? { already_granted: true } : {}),
	});
	return {
		success: true,
		modelOutput: JSON.stringify(response),
		summary: alreadyGranted
			? "Permissions already available"
			: `Permissions granted for ${scope}`,
		metadata: response,
	};
}

function failure(errorKind: string): ToolAdapterResult {
	return {
		success: false,
		modelOutput: `request_permissions failed\nError kind: ${errorKind}`,
		summary: "Permission request failed",
		errorKind,
		metadata: Object.freeze({}),
	};
}

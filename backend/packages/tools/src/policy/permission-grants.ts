import { deniedReadPath, hasDeniedReads } from "./denied-read-policy.ts";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
	PermissionGrantScope,
	PermissionRequestProfile,
} from "@mycli/core";
import type { ExecutionPolicy } from "./execution-policy.ts";

export const REQUEST_PERMISSIONS_TOOL_NAME = "request_permissions";
export const PERMISSION_REASON_MAX_CHARS = 512;
export const PERMISSION_PATH_MAX_CHARS = 4_096;
export const PERMISSION_PATH_MAX_ITEMS = 32;

export interface PermissionGrant {
	readonly scope: PermissionGrantScope;
	readonly permissions: PermissionRequestProfile;
	readonly constrained: boolean;
}

export type PermissionRequestParseResult =
	| {
		readonly ok: true;
		readonly reason?: string;
		readonly permissions: PermissionRequestProfile;
	}
	| {
		readonly ok: false;
		readonly errorKind: "invalid_arguments" | "permission_path_unavailable";
	};

export function parsePermissionRequest(
	argumentsValue: Readonly<Record<string, unknown>>,
	workspaceRoot: string,
): PermissionRequestParseResult {
	if (!exactKeys(argumentsValue, ["permissions", "reason"])) return invalidArguments();
	const reason = optionalBoundedString(argumentsValue.reason, PERMISSION_REASON_MAX_CHARS);
	if (argumentsValue.reason !== undefined && reason === undefined) return invalidArguments();
	const rawPermissions = recordValue(argumentsValue.permissions);
	if (!rawPermissions || !exactKeys(rawPermissions, ["network", "file_system"])) {
		return invalidArguments();
	}

	let network: PermissionRequestProfile["network"];
	if (rawPermissions.network !== undefined) {
		const rawNetwork = recordValue(rawPermissions.network);
		if (!rawNetwork
			|| !exactKeys(rawNetwork, ["enabled"])
			|| typeof rawNetwork.enabled !== "boolean") return invalidArguments();
		if (rawNetwork.enabled) network = Object.freeze({ enabled: true as const });
	}

	let fileSystem: PermissionRequestProfile["fileSystem"];
	if (rawPermissions.file_system !== undefined) {
		const rawFileSystem = recordValue(rawPermissions.file_system);
		if (!rawFileSystem || !exactKeys(rawFileSystem, ["read", "write"])) {
			return invalidArguments();
		}
		const read = permissionPaths(rawFileSystem.read, workspaceRoot);
		const write = permissionPaths(rawFileSystem.write, workspaceRoot);
		if (!read.ok) return read;
		if (!write.ok) return write;
		if (read.paths.length > 0 || write.paths.length > 0) {
			fileSystem = Object.freeze({ read: read.paths, write: write.paths });
		}
	}
	if (!network && !fileSystem) return invalidArguments();
	return Object.freeze({
		ok: true as const,
		...(reason ? { reason } : {}),
		permissions: freezePermissionRequest({
			...(network ? { network } : {}),
			...(fileSystem ? { fileSystem } : {}),
		}),
	});
}

export function permissionRequestSatisfied(
	permissions: PermissionRequestProfile,
	policy: ExecutionPolicy | undefined,
	workspaceRoot?: string,
): boolean {
	if (!policy) return false;
	if ((permissions.fileSystem?.write ?? []).some((path) =>
		(policy.readOnlyRoots ?? []).some((root) => pathWithinRoot(root, path)))) return false;
	if (permissions.network?.enabled && policy.network !== "enabled") return false;
	const paths = [...(permissions.fileSystem?.read ?? []), ...(permissions.fileSystem?.write ?? [])];
	if (paths.length > 0 && hasDeniedReads(policy)
		&& (!workspaceRoot || paths.some((path) => deniedReadPath(workspaceRoot, path, policy)))) return false;
	if (policy.filesystem === "unrestricted") return true;
	const readableRoots = [
		...(policy.readableRoots ?? []),
		...policy.writableRoots,
	];
	if (!(permissions.fileSystem?.read ?? []).every((path) => (
		readableRoots.some((root) => pathWithinRoot(root, path))
	))) return false;
	return (permissions.fileSystem?.write ?? []).every((path) => (
		policy.writableRoots.some((root) => pathWithinRoot(root, path))
	));
}

export function permissionRequestPreview(permissions: PermissionRequestProfile): string {
	const parts: string[] = [];
	if (permissions.network?.enabled) parts.push("network access");
	const read = permissions.fileSystem?.read ?? [];
	const write = permissions.fileSystem?.write ?? [];
	if (read.length > 0) parts.push(pathPreview("read", read));
	if (write.length > 0) parts.push(pathPreview("write", write));
	return `Request ${parts.join("; ")}`.slice(0, 512);
}

export function permissionRequestJson(
	permissions: PermissionRequestProfile,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		...(permissions.network ? {
			network: Object.freeze({ enabled: permissions.network.enabled }),
		} : {}),
		...(permissions.fileSystem ? {
			file_system: Object.freeze({
				read: Object.freeze([...permissions.fileSystem.read]),
				write: Object.freeze([...permissions.fileSystem.write]),
			}),
		} : {}),
	});
}

export function permissionRequestFromJson(value: unknown): PermissionRequestProfile | undefined {
	const permissions = recordValue(value);
	if (!permissions || !exactKeys(permissions, ["network", "file_system"])) return undefined;
	let network: PermissionRequestProfile["network"];
	if (permissions.network !== undefined) {
		const rawNetwork = recordValue(permissions.network);
		if (!rawNetwork || !exactKeys(rawNetwork, ["enabled"]) || rawNetwork.enabled !== true) {
			return undefined;
		}
		network = Object.freeze({ enabled: true as const });
	}
	let fileSystem: PermissionRequestProfile["fileSystem"];
	if (permissions.file_system !== undefined) {
		const rawFileSystem = recordValue(permissions.file_system);
		if (!rawFileSystem || !exactKeys(rawFileSystem, ["read", "write"])) return undefined;
		const read = storedPermissionPaths(rawFileSystem.read);
		const write = storedPermissionPaths(rawFileSystem.write);
		if (!read || !write) return undefined;
		if (read.length > 0 || write.length > 0) {
			fileSystem = Object.freeze({ read, write });
		}
	}
	if (!network && !fileSystem) return undefined;
	return freezePermissionRequest({
		...(network ? { network } : {}),
		...(fileSystem ? { fileSystem } : {}),
	});
}

export function freezePermissionRequest(
	permissions: PermissionRequestProfile,
): PermissionRequestProfile {
	return Object.freeze({
		...(permissions.network?.enabled ? {
			network: Object.freeze({ enabled: true as const }),
		} : {}),
		...(permissions.fileSystem ? {
			fileSystem: Object.freeze({
				read: Object.freeze([...permissions.fileSystem.read]),
				write: Object.freeze([...permissions.fileSystem.write]),
			}),
		} : {}),
	});
}

export function pathWithinRoot(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === ""
		|| (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function permissionPaths(
	value: unknown,
	workspaceRoot: string,
): { readonly ok: true; readonly paths: readonly string[] }
	| Extract<PermissionRequestParseResult, { readonly ok: false }> {
	if (value === undefined) return { ok: true, paths: Object.freeze([]) };
	if (!Array.isArray(value) || value.length > PERMISSION_PATH_MAX_ITEMS) {
		return invalidArguments();
	}
	const paths: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return invalidArguments();
		const normalized = item.trim();
		if (!normalized || normalized.length > PERMISSION_PATH_MAX_CHARS || normalized.includes("\0")) {
			return invalidArguments();
		}
		try {
			const absolute = realpathSync(isAbsolute(normalized)
				? resolve(normalized)
				: resolve(workspaceRoot, normalized));
			if (!paths.includes(absolute)) paths.push(absolute);
		} catch {
			return { ok: false, errorKind: "permission_path_unavailable" };
		}
	}
	return { ok: true, paths: Object.freeze(paths) };
}

function storedPermissionPaths(value: unknown): readonly string[] | undefined {
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value) || value.length > PERMISSION_PATH_MAX_ITEMS) return undefined;
	const paths: string[] = [];
	for (const item of value) {
		if (typeof item !== "string"
			|| !isAbsolute(item)
			|| !item.trim()
			|| item.length > PERMISSION_PATH_MAX_CHARS
			|| item.includes("\0")) return undefined;
		if (!paths.includes(item)) paths.push(item);
	}
	return Object.freeze(paths);
}

function pathPreview(action: string, paths: readonly string[]): string {
	const visible = paths.slice(0, 3).join(", ");
	const omitted = paths.length - Math.min(paths.length, 3);
	return `${action} ${visible}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

function invalidArguments(): Extract<PermissionRequestParseResult, { readonly ok: false }> {
	return { ok: false, errorKind: "invalid_arguments" };
}

function optionalBoundedString(value: unknown, limit: number): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return typeof value === "string" && value.trim() && value.trim().length <= limit
		? value.trim()
		: undefined;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: undefined;
}

function exactKeys(
	value: Readonly<Record<string, unknown>>,
	allowed: readonly string[],
): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

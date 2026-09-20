import { isAbsolute, normalize } from "node:path";
import type { WorkspaceTrustState } from "@mycli/config";
import type {
	PermissionGrantScope,
	PermissionRequestProfile,
} from "@mycli/core";
import {
	executionPolicy,
	freezeNetworkEgress,
	validateDeniedReadGlobs,
	deniedReadPath,
	freezePermissionRequest,
	normalizeNetworkDomains,
	pathWithinRoot,
	type PermissionGrant,
	type ExecutionPolicy,
	type NetworkEgressPolicy,
	type PermissionProfile,
} from "@mycli/tools";

export interface ExecutionPolicyConfiguration {
	readonly trust: WorkspaceTrustState;
	readonly permission: PermissionProfile;
	readonly source?: "default" | "user" | "project" | "session" | "managed";
}

export interface ExecutionPolicyConstraints {
	readonly source: "managed" | "runtime";
	readonly network?: "enabled" | "disabled";
	readonly networkDomains?: readonly string[];
	readonly networkEgress?: NetworkEgressPolicy;
	readonly readableRoots?: readonly string[];
	readonly readOnlyRoots?: readonly string[];
	readonly allowLocalBinding?: boolean;
	readonly writableTemp?: boolean;
	readonly deniedReadRoots?: readonly string[];
	readonly deniedReadGlobs?: readonly string[];
	readonly writableRoots?: readonly string[];
}

export interface PermissionGrantInput {
	readonly turnId: string;
	readonly scope: PermissionGrantScope;
	readonly permissions: PermissionRequestProfile;
}

export interface ExecutionPolicySnapshot {
	readonly trusted: boolean;
	readonly valid: boolean;
	readonly profile: ExecutionPolicy;
	readonly resolution?: {
		readonly configurationSource: NonNullable<ExecutionPolicyConfiguration["source"]>;
		readonly constraintsSource?: ExecutionPolicyConstraints["source"];
		readonly activeTurnId?: string;
		readonly sessionGrant?: PermissionRequestProfile;
		readonly turnGrant?: PermissionRequestProfile;
	};
}

export interface TurnExecutionPolicy {
	readonly toolsEnabled: boolean;
	readonly profile: ExecutionPolicy;
}

export interface ExecutionPolicyCoordinatorOptions {
	readonly workspaceRoot: string;
	readonly constraints?: ExecutionPolicyConstraints;
}

interface ActivePolicy {
	readonly turnId: string;
	readonly baseProfile: ExecutionPolicy;
	readonly policy: TurnExecutionPolicy;
}

export class ExecutionPolicyCoordinator {
	readonly #workspaceRoot: string;
	readonly #fallback: ExecutionPolicy;
	readonly #constraints: ExecutionPolicyConstraints | undefined;
	#configuration: ExecutionPolicyConfiguration | undefined;
	#profile: ExecutionPolicy | undefined;
	#active: ActivePolicy | undefined;
	#sessionGrant: PermissionRequestProfile | undefined;
	readonly #turnGrants = new Map<string, PermissionRequestProfile>();

	constructor(options: ExecutionPolicyCoordinatorOptions) {
		this.#workspaceRoot = options.workspaceRoot;
		this.#constraints = normalizeConstraints(options.constraints);
		this.#fallback = this.#applyConstraints(executionPolicy("read-only", options.workspaceRoot));
	}

	configure(input: ExecutionPolicyConfiguration): void {
		if (!isWorkspaceTrustState(input.trust) || !isPermissionProfile(input.permission)) {
			this.#configuration = undefined;
			this.#profile = undefined;
			return;
		}
		this.#configuration = Object.freeze({
			...input,
			source: input.source ?? "session",
		});
		this.#profile = this.#applyConstraints(executionPolicy(input.permission, this.#workspaceRoot));
	}

	snapshot(): ExecutionPolicySnapshot {
		const activeTurnId = this.#active?.turnId;
		const turnGrant = activeTurnId ? this.#turnGrants.get(activeTurnId) : undefined;
		return Object.freeze({
			trusted: this.#configuration?.trust === "trusted",
			valid: this.#configuration !== undefined && this.#profile !== undefined,
			profile: this.#active?.policy.profile
				?? this.#effectiveProfile(undefined),
			resolution: Object.freeze({
				configurationSource: this.#configuration?.source ?? "default",
				...(this.#constraints ? { constraintsSource: this.#constraints.source } : {}),
				...(activeTurnId ? { activeTurnId } : {}),
				...(this.#sessionGrant ? { sessionGrant: this.#sessionGrant } : {}),
				...(turnGrant ? { turnGrant } : {}),
			}),
		});
	}

	beginTurn(turnId: string): TurnExecutionPolicy {
		if (!turnId.trim()) throw new TypeError("turnId must be non-empty");
		if (this.#active) {
			if (this.#active.turnId !== turnId) {
				throw new Error("execution_policy_turn_conflict");
			}
			return this.#active.policy;
		}
		const snapshot = this.snapshot();
		const baseProfile = this.#effectiveProfile(turnId);
		const policy = Object.freeze({
			toolsEnabled: snapshot.trusted && snapshot.valid,
			profile: baseProfile,
		});
		this.#active = Object.freeze({ turnId, baseProfile, policy });
		return policy;
	}

	restoreTurn(turnId: string, policy: TurnExecutionPolicy): TurnExecutionPolicy {
		if (!turnId.trim()) throw new TypeError("turnId must be non-empty");
		if (this.#active) {
			if (this.#active.turnId !== turnId) {
				throw new Error("execution_policy_turn_conflict");
			}
			return this.#active.policy;
		}
		const restored = Object.freeze({
			toolsEnabled: policy.toolsEnabled,
			profile: this.#applyConstraints(copyExecutionPolicy(policy.profile)),
		});
		this.#active = Object.freeze({
			turnId,
			baseProfile: restored.profile,
			policy: restored,
		});
		return restored;
	}

	sandboxOverrideProfile(): ExecutionPolicy {
		return this.#applyConstraints(executionPolicy("full-access", this.#workspaceRoot));
	}

	finishTurn(turnId: string): void {
		this.#turnGrants.delete(turnId);
		if (this.#active?.turnId === turnId) this.#active = undefined;
	}

	grant(input: PermissionGrantInput): PermissionGrant {
		if (!input.turnId.trim()) throw new TypeError("turnId must be non-empty");
		if (input.scope !== "turn" && input.scope !== "session") {
			throw new TypeError("permission grant scope is invalid");
		}
		const active = this.#active?.turnId === input.turnId ? this.#active : undefined;
		if (active ? !active.policy.toolsEnabled : this.#configuration?.trust !== "trusted" || !this.#profile) {
			throw new Error("permission_grant_not_allowed");
		}
		const constrained = this.#constrainGrant(input.permissions);
		if (input.scope === "session") {
			this.#sessionGrant = mergePermissionRequests(this.#sessionGrant, constrained.permissions);
		} else {
			this.#turnGrants.set(
				input.turnId,
				mergePermissionRequests(this.#turnGrants.get(input.turnId), constrained.permissions),
			);
		}
		if (active) {
			this.#active = Object.freeze({
				turnId: input.turnId,
				baseProfile: active.baseProfile,
				policy: Object.freeze({
					toolsEnabled: active.policy.toolsEnabled,
					profile: this.#effectiveProfile(input.turnId, active.baseProfile),
				}),
			});
		}
		return Object.freeze({
			scope: input.scope,
			permissions: constrained.permissions,
			constrained: constrained.constrained,
		});
	}

	#effectiveProfile(
		turnId: string | undefined,
		base: ExecutionPolicy = this.#profile ?? this.#fallback,
	): ExecutionPolicy {
		const grant = mergePermissionRequests(
			this.#sessionGrant,
			turnId ? this.#turnGrants.get(turnId) : undefined,
		);
		if (!hasPermissions(grant) || base.filesystem === "unrestricted") {
			return grant.network?.enabled && base.network === "disabled"
				? immutablePolicy(base, base.writableRoots, "enabled")
				: base;
		}
		const roots = uniqueStrings([
			...base.writableRoots,
			...(grant.fileSystem?.write ?? []),
		]);
		const grantedReadRoots = grant.fileSystem?.read ?? [];
		const readableRoots = base.readableRoots === undefined && grantedReadRoots.length === 0
			? undefined
			: uniqueStrings([
				...(base.readableRoots ?? []),
				...grantedReadRoots,
			]);
		return immutablePolicy(
			base,
			roots,
			grant.network?.enabled ? "enabled" : base.network,
			false,
			base.networkDomains,
			readableRoots,
		);
	}

	#applyConstraints(policy: ExecutionPolicy): ExecutionPolicy {
		if (!this.#constraints) return policy;
		const constrainedRoots = this.#constraints.writableRoots;
		const roots = constrainedRoots === undefined
			? policy.writableRoots
			: policy.filesystem === "unrestricted"
				? constrainedRoots
				: intersectRoots(policy.writableRoots, constrainedRoots);
		const network = this.#constraints.network === "disabled"
			? "disabled"
			: policy.network;
		const networkDomains = this.#constraints.networkDomains ?? policy.networkDomains;
		const networkEgress = this.#constraints.networkEgress ?? policy.networkEgress;
		const readableRoots = this.#constraints.readableRoots ?? policy.readableRoots;
		const readOnlyRoots = uniqueStrings([...(policy.readOnlyRoots ?? []), ...(this.#constraints.readOnlyRoots ?? [])]);
		const allowLocalBinding = this.#constraints.allowLocalBinding ?? policy.allowLocalBinding;
		const writableTemp = this.#constraints.writableTemp ?? policy.writableTemp;
		const deniedReadRoots = uniqueStrings([...(policy.deniedReadRoots ?? []), ...(this.#constraints.deniedReadRoots ?? [])]);
		const deniedReadGlobs = uniqueStrings([...(policy.deniedReadGlobs ?? []), ...(this.#constraints.deniedReadGlobs ?? [])]);
		const hasDenies = deniedReadRoots.length > 0 || deniedReadGlobs.length > 0;
		if (!hasDenies && readOnlyRoots.length === 0 && allowLocalBinding === policy.allowLocalBinding
			&& writableTemp === policy.writableTemp && constrainedRoots === undefined
			&& network === policy.network
			&& networkDomains === policy.networkDomains
			&& networkEgress === policy.networkEgress
			&& readableRoots === policy.readableRoots) return policy;
		return immutablePolicy(
			{ ...policy, ...(hasDenies ? { deniedReadRoots, deniedReadGlobs } : {}),
				...(readOnlyRoots.length ? { readOnlyRoots } : {}),
				...(allowLocalBinding === undefined ? {} : { allowLocalBinding }),
				...(writableTemp === undefined ? {} : { writableTemp }) },
			roots,
			network,
			constrainedRoots !== undefined || this.#constraints.readableRoots !== undefined || hasDenies,
			networkDomains,
			readableRoots,
			networkEgress,
		);
	}

	#constrainGrant(permissions: PermissionRequestProfile): {
		readonly permissions: PermissionRequestProfile;
		readonly constrained: boolean;
	} {
		const allowedReadRoots = this.#constraints?.readableRoots;
		const requestedRead = permissions.fileSystem?.read ?? [];
		const read = requestedRead.filter((path) =>
			(allowedReadRoots === undefined || allowedReadRoots.some((root) => pathWithinRoot(root, path)))
			&& !deniedReadPath(this.#workspaceRoot, path, this.#constraints ?? {}));
		const allowedRoots = this.#constraints?.writableRoots;
		const requestedWrite = permissions.fileSystem?.write ?? [];
		const write = requestedWrite.filter((path) =>
			(allowedRoots === undefined || allowedRoots.some((root) => pathWithinRoot(root, path)))
			&& !(this.#constraints?.readOnlyRoots ?? []).some((root) => pathWithinRoot(root, path))
			&& !deniedReadPath(this.#workspaceRoot, path, this.#constraints ?? {}));
		const constrainedDomains = this.#constraints?.networkDomains;
		const networkAllowed = this.#constraints?.network !== "disabled"
			&& (constrainedDomains === undefined || constrainedDomains.length > 0);
		const granted = freezePermissionRequest({
			...(permissions.network?.enabled && networkAllowed
				? { network: { enabled: true } }
				: {}),
			...(permissions.fileSystem ? {
				fileSystem: {
					read,
					write,
				},
			} : {}),
		});
		return {
			permissions: granted,
			constrained: permissions.network?.enabled === true
				&& (!networkAllowed || constrainedDomains !== undefined)
				|| read.length !== requestedRead.length
				|| write.length !== requestedWrite.length,
		};
	}
}

function normalizeConstraints(
	constraints: ExecutionPolicyConstraints | undefined,
): ExecutionPolicyConstraints | undefined {
	if (!constraints) return undefined;
	if (constraints.source !== "managed" && constraints.source !== "runtime") {
		throw new TypeError("execution policy constraint source is invalid");
	}
	if (constraints.network !== undefined
		&& constraints.network !== "enabled"
		&& constraints.network !== "disabled") {
		throw new TypeError("execution policy network constraint is invalid");
	}
	for (const value of [constraints.allowLocalBinding, constraints.writableTemp]) {
		if (value !== undefined && typeof value !== "boolean") throw new TypeError("execution policy option must be boolean");
	}
	return Object.freeze({
		source: constraints.source,
		...(constraints.networkEgress === undefined
			? {}
			: { networkEgress: freezeNetworkEgress(constraints.networkEgress) }),
		...(constraints.readOnlyRoots === undefined ? {} : { readOnlyRoots: Object.freeze(constraints.readOnlyRoots.map(executionPolicyRoot)) }),
		...(constraints.allowLocalBinding === undefined ? {} : { allowLocalBinding: constraints.allowLocalBinding }),
		...(constraints.writableTemp === undefined ? {} : { writableTemp: constraints.writableTemp }),
		...(constraints.deniedReadRoots === undefined ? {} : {
			deniedReadRoots: uniqueStrings(constraints.deniedReadRoots.map((root) => {
				if (!isAbsolute(root) || /[\0\r\n]/u.test(root)) throw new TypeError("denied-read roots must be absolute paths");
				return normalize(root);
			})),
		}),
		...(constraints.deniedReadGlobs === undefined ? {} : { deniedReadGlobs: validateDeniedReadGlobs(constraints.deniedReadGlobs) }),
		...(constraints.network ? { network: constraints.network } : {}),
		...(constraints.networkDomains ? {
			networkDomains: normalizeNetworkDomains(constraints.networkDomains),
		} : {}),
		...(constraints.readableRoots ? {
			readableRoots: Object.freeze(uniqueStrings(
				constraints.readableRoots.map((root) => executionPolicyRoot(root)),
			)),
		} : {}),
		...(constraints.writableRoots ? {
			writableRoots: Object.freeze(uniqueStrings(
				constraints.writableRoots.map((root) => executionPolicyRoot(root)),
			)),
		} : {}),
	});
}

function executionPolicyRoot(root: string): string {
	if (!root.trim()) throw new TypeError("execution policy writable root is invalid");
	return executionPolicy("workspace", root).writableRoots[0]!;
}

function mergePermissionRequests(
	left: PermissionRequestProfile | undefined,
	right: PermissionRequestProfile | undefined,
): PermissionRequestProfile {
	return freezePermissionRequest({
		...(left?.network?.enabled || right?.network?.enabled
			? { network: { enabled: true } }
			: {}),
		...(left?.fileSystem || right?.fileSystem ? {
			fileSystem: {
				read: uniqueStrings([
					...(left?.fileSystem?.read ?? []),
					...(right?.fileSystem?.read ?? []),
				]),
				write: uniqueStrings([
					...(left?.fileSystem?.write ?? []),
					...(right?.fileSystem?.write ?? []),
				]),
			},
		} : {}),
	});
}

function hasPermissions(permissions: PermissionRequestProfile): boolean {
	return permissions.network?.enabled === true
		|| (permissions.fileSystem?.read.length ?? 0) > 0
		|| (permissions.fileSystem?.write.length ?? 0) > 0;
}

function immutablePolicy(
	base: ExecutionPolicy,
	writableRoots: readonly string[],
	network: ExecutionPolicy["network"],
	forceRestricted = false,
	networkDomains: readonly string[] | undefined = base.networkDomains,
	readableRoots: readonly string[] | undefined = base.readableRoots,
	networkEgress: NetworkEgressPolicy | undefined = base.networkEgress,
): ExecutionPolicy {
	const unrestricted = base.filesystem === "unrestricted" && !forceRestricted;
	const hasWritableRoots = writableRoots.length > 0;
	return Object.freeze({
		mode: unrestricted
			? "danger-full-access"
			: hasWritableRoots ? "workspace-write" : "read-only",
		filesystem: unrestricted
			? "unrestricted"
			: hasWritableRoots ? "workspace_write" : "read_only",
		network,
		...(networkEgress === undefined ? {} : { networkEgress }),
		...(base.deniedReadRoots === undefined ? {} : { deniedReadRoots: Object.freeze([...base.deniedReadRoots]) }),
		...(base.readOnlyRoots === undefined ? {} : { readOnlyRoots: Object.freeze([...base.readOnlyRoots]) }),
		...(base.allowLocalBinding === undefined ? {} : { allowLocalBinding: base.allowLocalBinding }),
		...(base.writableTemp === undefined ? {} : { writableTemp: base.writableTemp }),
		...(base.deniedReadGlobs === undefined ? {} : { deniedReadGlobs: Object.freeze([...base.deniedReadGlobs]) }),
		...(networkDomains === undefined ? {} : {
			networkDomains: Object.freeze([...networkDomains]),
		}),
		...(readableRoots === undefined ? {} : {
			readableRoots: Object.freeze([...readableRoots]),
		}),
		writableRoots: Object.freeze([...writableRoots]),
	});
}

function copyExecutionPolicy(policy: ExecutionPolicy): ExecutionPolicy {
	return Object.freeze({
		mode: policy.mode,
		filesystem: policy.filesystem,
		network: policy.network,
		...(policy.deniedReadRoots === undefined ? {} : { deniedReadRoots: Object.freeze([...policy.deniedReadRoots]) }),
		...(policy.readOnlyRoots === undefined ? {} : { readOnlyRoots: Object.freeze([...policy.readOnlyRoots]) }),
		...(policy.allowLocalBinding === undefined ? {} : { allowLocalBinding: policy.allowLocalBinding }),
		...(policy.writableTemp === undefined ? {} : { writableTemp: policy.writableTemp }),
		...(policy.deniedReadGlobs === undefined ? {} : { deniedReadGlobs: Object.freeze([...policy.deniedReadGlobs]) }),
		...(policy.networkDomains === undefined ? {} : {
			networkDomains: Object.freeze([...policy.networkDomains]),
		}),
		...(policy.readableRoots === undefined ? {} : {
			readableRoots: Object.freeze([...policy.readableRoots]),
		}),
		writableRoots: Object.freeze([...policy.writableRoots]),
	});
}

function uniqueStrings(values: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(values)]);
}

function intersectRoots(
	policyRoots: readonly string[],
	constraintRoots: readonly string[],
): readonly string[] {
	return uniqueStrings(policyRoots.flatMap((policyRoot) => (
		constraintRoots.flatMap((constraintRoot) => {
			if (pathWithinRoot(policyRoot, constraintRoot)) return [constraintRoot];
			if (pathWithinRoot(constraintRoot, policyRoot)) return [policyRoot];
			return [];
		})
	)));
}

function isWorkspaceTrustState(value: unknown): value is WorkspaceTrustState {
	return value === "trusted" || value === "untrusted" || value === "unknown";
}

function isPermissionProfile(value: unknown): value is PermissionProfile {
	return value === "read-only" || value === "workspace" || value === "full-access";
}

import type { WorkspaceTrustState } from "@mycli/config";
import {
	executionPolicy,
	type ExecutionPolicy,
	type PermissionProfile,
} from "@mycli/tools";

export interface ExecutionPolicyConfiguration {
	readonly trust: WorkspaceTrustState;
	readonly permission: PermissionProfile;
}

export interface ExecutionPolicySnapshot {
	readonly trusted: boolean;
	readonly valid: boolean;
	readonly profile: ExecutionPolicy;
}

export interface TurnExecutionPolicy {
	readonly toolsEnabled: boolean;
	readonly profile: ExecutionPolicy;
}

export interface ExecutionPolicyCoordinatorOptions {
	readonly workspaceRoot: string;
}

interface ActivePolicy {
	readonly turnId: string;
	readonly policy: TurnExecutionPolicy;
}

export class ExecutionPolicyCoordinator {
	readonly #workspaceRoot: string;
	readonly #fallback: ExecutionPolicy;
	#configuration: ExecutionPolicyConfiguration | undefined;
	#profile: ExecutionPolicy | undefined;
	#active: ActivePolicy | undefined;

	constructor(options: ExecutionPolicyCoordinatorOptions) {
		this.#workspaceRoot = options.workspaceRoot;
		this.#fallback = executionPolicy("read-only", options.workspaceRoot);
	}

	configure(input: ExecutionPolicyConfiguration): void {
		if (!isWorkspaceTrustState(input.trust) || !isPermissionProfile(input.permission)) {
			this.#configuration = undefined;
			this.#profile = undefined;
			return;
		}
		this.#configuration = Object.freeze({ ...input });
		this.#profile = executionPolicy(input.permission, this.#workspaceRoot);
	}

	snapshot(): ExecutionPolicySnapshot {
		return Object.freeze({
			trusted: this.#configuration?.trust === "trusted",
			valid: this.#configuration !== undefined && this.#profile !== undefined,
			profile: this.#profile ?? this.#fallback,
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
		const policy = Object.freeze({
			toolsEnabled: snapshot.trusted && snapshot.valid,
			profile: snapshot.profile,
		});
		this.#active = Object.freeze({ turnId, policy });
		return policy;
	}

	finishTurn(turnId: string): void {
		if (this.#active?.turnId === turnId) this.#active = undefined;
	}
}

function isWorkspaceTrustState(value: unknown): value is WorkspaceTrustState {
	return value === "trusted" || value === "untrusted" || value === "unknown";
}

function isPermissionProfile(value: unknown): value is PermissionProfile {
	return value === "read-only" || value === "workspace" || value === "full-access";
}

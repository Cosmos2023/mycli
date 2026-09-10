import {
	stableModelInputJson,
	type ToolDefinition,
} from "@mycli/core";
import type { ExecutionPolicyConfiguration, TurnExecutionPolicy } from "./execution-policy-coordinator.ts";
import {
	createRunExecutionSnapshot,
	parseRunExecutionSnapshot,
	replaceRunPolicySnapshot,
	type RunExecutionSnapshot,
	type RunToolCatalogInput,
} from "./run-execution-snapshot.ts";

export interface RunExecutionPolicyCoordinator {
	beginTurn(turnId: string): TurnExecutionPolicy;
	restoreTurn?(turnId: string, policy: TurnExecutionPolicy): TurnExecutionPolicy;
	finishTurn(turnId: string): void;
}

export interface RunExecutionCapabilities {
	readonly turnId: string;
	readonly shell: boolean;
	readonly collaborationMode: string;
}

export interface RunExecutionCoordinatorOptions {
	readonly executionPolicyCoordinator?: RunExecutionPolicyCoordinator;
	readonly resolveToolCatalog?: (capabilities: RunExecutionCapabilities) => RunToolCatalogInput;
	readonly planTools?: (capabilities: Omit<RunExecutionCapabilities, "turnId">) => readonly ToolDefinition[];
	readonly deferredTools?: readonly ToolDefinition[] | ((turnId: string) => readonly ToolDefinition[]);
}

export class RunExecutionCoordinator {
	readonly #options: RunExecutionCoordinatorOptions;
	#collaborationMode = "default";
	readonly #collaborationModeByTurn = new Map<string, string>();
	#policyConfiguration: ExecutionPolicyConfiguration | undefined;
	readonly #snapshots = new Map<string, RunExecutionSnapshot>();

	constructor(options: RunExecutionCoordinatorOptions = {}) {
		this.#options = options;
	}

	configureCollaborationMode(input: {
		readonly collaborationMode: string;
		readonly turnId?: string;
	}): void {
		const mode = boundedIdentity(input.collaborationMode, "collaboration mode", 64);
		if (input.turnId !== undefined) {
			const turnId = boundedIdentity(input.turnId, "turn id", 256);
			this.#collaborationModeByTurn.set(turnId, mode);
			return;
		}
		this.#collaborationMode = mode;
	}

	configurePolicy(input: ExecutionPolicyConfiguration): void {
		this.#policyConfiguration = Object.freeze({ ...input });
	}

	snapshot(turnId: string): RunExecutionSnapshot | undefined {
		return this.#snapshots.get(turnId);
	}

	resolve(
		turnId: string,
		restoredSnapshot?: RunExecutionSnapshot,
	): RunExecutionSnapshot {
		const existing = this.#snapshots.get(turnId);
		if (existing) {
			if (restoredSnapshot !== undefined) {
				const restored = parseRunExecutionSnapshot(restoredSnapshot, turnId);
				if (stableModelInputJson(existing) !== stableModelInputJson(restored)) {
					throw new TypeError("run execution snapshot does not match active run");
				}
			}
			return existing;
		}

		if (restoredSnapshot !== undefined) {
			const parsed = parseRunExecutionSnapshot(restoredSnapshot, turnId);
			const restoredPolicy = parsed.policy
				? this.#options.executionPolicyCoordinator?.restoreTurn?.(turnId, parsed.policy)
					?? parsed.policy
				: this.#options.executionPolicyCoordinator?.beginTurn(turnId);
			const snapshot = restoredPolicy
				? replaceRunPolicySnapshot(parsed, restoredPolicy)
				: parsed;
			this.#snapshots.set(turnId, snapshot);
			return snapshot;
		}

		const collaborationMode = this.#collaborationModeByTurn.get(turnId)
			?? this.#collaborationMode;
		const policy = this.#options.executionPolicyCoordinator?.beginTurn(turnId);
		const capabilities = Object.freeze({
			turnId,
			shell: policy?.toolsEnabled ?? false,
			collaborationMode,
		});
		const catalog = this.#options.resolveToolCatalog?.(capabilities)
			?? {
				catalogVersion: 0,
				directTools: this.#options.planTools?.(capabilities) ?? [],
				deferredTools: typeof this.#options.deferredTools === "function"
					? this.#options.deferredTools(turnId)
					: this.#options.deferredTools ?? [],
			};
		const snapshot = createRunExecutionSnapshot({
			turnId,
			collaborationMode,
			...(policy ? { policy } : {}),
			...(this.#policyConfiguration ? {
				policyConfiguration: this.#policyConfiguration,
			} : {}),
			toolCatalog: catalog,
		});
		this.#snapshots.set(turnId, snapshot);
		return snapshot;
	}

	refreshPolicy(turnId: string): RunExecutionSnapshot {
		const snapshot = this.#snapshots.get(turnId);
		if (!snapshot) throw new Error("run_execution_snapshot_missing");
		const policy = this.#options.executionPolicyCoordinator?.beginTurn(turnId);
		if (!policy) return snapshot;
		const updated = replaceRunPolicySnapshot(snapshot, policy);
		this.#snapshots.set(turnId, updated);
		return updated;
	}

	finish(turnId: string): void {
		this.#options.executionPolicyCoordinator?.finishTurn(turnId);
		this.#collaborationModeByTurn.delete(turnId);
		this.#snapshots.delete(turnId);
	}
}

function boundedIdentity(value: string, label: string, limit: number): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > limit) throw new TypeError(`${label} is invalid`);
	return normalized;
}

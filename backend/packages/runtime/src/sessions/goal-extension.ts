import { GoalStateError, type GoalRef } from "@mycli/core";
import type { ExtensionDefinition } from "@mycli/extensions";
import { GoalTool } from "@mycli/tools";
import { goalContinuationMessage, sessionGoalContext } from "./session-goal-context.ts";
import type { SessionGoalService } from "./session-goal-service.ts";

export interface GoalExtensionOptions {
	readonly sessionId: string;
	readonly service: SessionGoalService;
}

/**
 * Goal as an extension. It decides when an idle session continues its objective, validates the
 * continuation before the runtime reserves the turn, and tracks every turn for usage accounting.
 *
 * The reference handed to the runtime is the goal reference itself: goal owns it, the runtime only
 * carries it back unchanged.
 */
export function createGoalExtension(options: GoalExtensionOptions): ExtensionDefinition {
	/**
	 * The goal a compaction is charged to: the one accounting for the turn, or the active goal when
	 * compaction runs outside a turn. Resolved once per compaction, like the runtime did.
	 */
	const chargedGoalId = (turnId: string | undefined): string | undefined => {
		if (turnId !== undefined) return options.service.accountingGoalId(turnId);
		const goal = options.service.get();
		return goal?.status === "active" ? goal.goal_id : undefined;
	};
	return {
		id: "goal",
		admission: {
			nextTurn: ({ toolNames }) => {
				const reference = options.service.continuation();
				if (!reference) return undefined;
				const goal = options.service.modelView() ?? options.service.get();
				if (!goal) return undefined;
				return {
					source: "goal",
					message: goalContinuationMessage(goal, { updatePlan: toolNames.includes("update_plan") }),
					reference,
				};
			},
			assertAdmission: ({ reference }) => {
				options.service.assertContinuation(goalReference(reference));
			},
			onAdmissionFailed: ({ reference, message }) => {
				options.service.failAdmission(goalReference(reference), message);
			},
		},
		turnLifecycle: {
			onTurnAdmitted: ({ turnId, source, admission }) => {
				options.service.beginTurn(turnId, source, admission ? goalReference(admission.reference) : undefined);
			},
			onTurnFinished: ({ turnId, status, errorCode }) => {
				options.service.finishTurn(turnId, status, errorCode);
			},
		},
		turnPolicy: {
			stopReason: ({ turnId }) => {
				const message = options.service.stopReason(turnId);
				return message === undefined ? undefined : {
					message,
					interruptionReason: options.service.interruptionReason(turnId),
				};
			},
			toolsStopReason: ({ turnId }) => {
				const message = options.service.toolsStopReason(turnId);
				return message === undefined ? undefined : {
					message,
					interruptionReason: options.service.interruptionReason(turnId),
				};
			},
			// A budgeted goal gets exactly one wrap-up step, and that step carries no tools.
			allowTools: ({ turnId }) => !options.service.beginWrapUpStep(turnId),
		},
		tokenUsage: {
			// One observation per provider step, so the goal counts every retry's spend exactly once.
			onTokenUsage: ({ turnId, requestId, usage }) => {
				options.service.observeUsage(turnId, requestId, usage);
			},
		},
		sessionLifecycle: {
			// A cold start never inherits permission to launch automatic work.
			onRestore: () => options.service.restore(),
			onInterrupt: () => options.service.interrupt(),
			onClose: () => options.service.close(),
		},
		tools: {
			// The goal tools are authority-gated by the service, so they belong to the feature.
			tools: () => (["create", "get", "update"] as const).map(
				(operation) => new GoalTool(operation, options.sessionId, options.service),
			),
		},
		compactionBudget: {
			compactionBudget: ({ turnId }) => {
				const goalId = chargedGoalId(turnId);
				if (!goalId) return undefined;
				return {
					remainingTokenBudget: () => options.service.remainingTokenBudget(goalId, turnId),
					observeUsage: (requestId, usage) => {
						options.service.observeAttributedUsage(goalId, requestId, usage);
					},
				};
			},
		},
		conversationContext: {
			// The goal state the model needs, plus steering while a running turn is being redirected.
			conversationContext: ({ turnId }) => sessionGoalContext(
				options.service.modelView(),
				options.service.steeringFor(turnId),
			),
		},
		delegation: {
			// Work delegated from this turn inherits the goal this turn is accounting for.
			captureDelegatedWork: ({ turnId }) => {
				const ref = options.service.usageReference(turnId);
				return ref ? { service: options.service, ref } : undefined;
			},
		},
		failure: {
			// A goal state error is a goal outcome, so it keeps its message instead of becoming internal.
			normalizeFailure: ({ error }) => error instanceof GoalStateError
				? { code: "interrupted", message: error.message, retryable: false }
				: undefined,
		},
	};
}

/** The runtime treats the reference as opaque, so the shape is re-checked before goal interprets it. */
function goalReference(reference: unknown): GoalRef {
	if (typeof reference !== "object" || reference === null) {
		throw new TypeError("goal admission is missing its reference");
	}
	const { goalId, revision } = reference as Partial<GoalRef>;
	if (typeof goalId !== "string" || typeof revision !== "number") {
		throw new TypeError("goal admission reference is malformed");
	}
	return { goalId, revision };
}

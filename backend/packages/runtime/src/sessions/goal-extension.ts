import type { GoalRef } from "@mycli/core";
import type { ExtensionDefinition } from "@mycli/extensions";
import { goalContinuationMessage } from "./session-goal-context.ts";
import type { SessionGoalService } from "./session-goal-service.ts";

export interface GoalExtensionOptions {
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

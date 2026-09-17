import type { SessionGoal } from "@mycli/contracts";
import { GoalStateError, type ToolDefinition } from "@mycli/core";
import {
	CREATE_GOAL_TOOL_DEFINITION, GET_GOAL_TOOL_DEFINITION, UPDATE_GOAL_TOOL_DEFINITION,
} from "../registry/goal-manifest.ts";
import type { ToolAdapter, ToolAdapterResult, ToolExecutionOptions } from "../types.ts";

export interface GoalToolService {
	inspect(): SessionGoal | null;
	create(input: { readonly objective: string; readonly tokenBudget?: number }, turnId: string): SessionGoal;
	updateFromTool(status: "complete" | "blocked" | "paused", turnId: string): SessionGoal;
}

/** Tool adapters know the service contract, not its runtime or storage implementation. */
export class GoalTool implements ToolAdapter {
	readonly definition: ToolDefinition;

	constructor(
		readonly operation: "create" | "get" | "update",
		private readonly sessionId: string,
		private readonly service: GoalToolService,
	) {
		this.definition = operation === "create" ? CREATE_GOAL_TOOL_DEFINITION
			: operation === "get" ? GET_GOAL_TOOL_DEFINITION : UPDATE_GOAL_TOOL_DEFINITION;
	}

	async execute(args: Readonly<Record<string, unknown>>, options?: ToolExecutionOptions): Promise<ToolAdapterResult> {
		try {
			if (!options?.ownerTurnId || options.ownerSessionId !== this.sessionId || options.signal?.aborted) {
				throw new GoalStateError("goal_authority_required", "Goal tools require the current live root turn.");
			}
			let goal: SessionGoal | null;
			if (this.operation === "create") {
				if (typeof args.objective !== "string" || (args.token_budget !== undefined && typeof args.token_budget !== "number")) throw invalidArguments();
				goal = this.service.create({ objective: args.objective, tokenBudget: args.token_budget as number | undefined }, options.ownerTurnId);
			} else if (this.operation === "update") {
				if (args.status !== "complete" && args.status !== "blocked" && args.status !== "paused") throw invalidArguments();
				goal = this.service.updateFromTool(args.status, options.ownerTurnId);
			} else goal = this.service.inspect();
			return {
				success: true, modelOutput: JSON.stringify({ goal }), summary: goal ? `Goal ${goal.status}` : "No goal",
				metadata: Object.freeze({}),
			};
		} catch (error) {
			if (!(error instanceof GoalStateError)) throw error;
			return {
				success: false, modelOutput: error.message, summary: error.message,
				errorKind: error.code === "goal_changed" || error.code === "goal_runtime_closed" ? "interrupted" : "invalid_arguments",
				metadata: Object.freeze({ goal_error_code: error.code }),
			};
		}
	}
}

function invalidArguments(): GoalStateError {
	return new GoalStateError("invalid_arguments", "Invalid goal tool arguments.");
}

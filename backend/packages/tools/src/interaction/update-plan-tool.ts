import { UPDATE_PLAN_TOOL_DEFINITION } from "../registry/manifest.ts";
import type { ToolAdapter, ToolAdapterResult } from "../types.ts";

type PlanStatus = "pending" | "in_progress" | "completed";

export class UpdatePlanTool implements ToolAdapter {
	readonly definition = UPDATE_PLAN_TOOL_DEFINITION;

	async execute(argumentsValue: Readonly<Record<string, unknown>>): Promise<ToolAdapterResult> {
		const plan = argumentsValue.plan;
		if (!Array.isArray(plan)) return invalidResult("Plan must be an array.");
		const items: Array<{ id: string; text: string; status: PlanStatus }> = [];
		let inProgress = 0;
		for (const [index, value] of plan.entries()) {
			if (!isRecord(value)) return invalidResult("Every plan item must be an object.");
			const step = boundedStep(value.step);
			const status = planStatus(value.status);
			if (!step || !status) return invalidResult("Every plan item requires a valid step and status.");
			if (status === "in_progress") inProgress += 1;
			items.push({ id: `step-${index + 1}`, text: step, status });
		}
		if (inProgress > 1) return invalidResult("At most one plan item can be in_progress.");
		const explanation = boundedExplanation(argumentsValue.explanation);
		if (argumentsValue.explanation !== undefined && explanation === undefined) {
			return invalidResult("Explanation must be a bounded string.");
		}
		const frozenItems = Object.freeze(items.map((item) => Object.freeze(item)));
		return {
			success: true,
			modelOutput: "Plan updated.",
			summary: items.length === 0 ? "Cleared plan" : `Updated plan with ${items.length} steps`,
			metadata: Object.freeze({
				completed: items.filter((item) => item.status === "completed").length,
				total: items.length,
			}),
			planUpdate: Object.freeze({
				...(explanation ? { explanation } : {}),
				items: frozenItems,
			}),
		};
	}
}

function invalidResult(message: string): ToolAdapterResult {
	return {
		success: false,
		modelOutput: `update_plan failed\nError kind: invalid_plan\nError: ${message}`,
		summary: "update_plan failed",
		errorKind: "invalid_plan",
		metadata: Object.freeze({}),
	};
}

function boundedStep(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const step = value.trim();
	return step.length > 0 && step.length <= 4_096 ? step : undefined;
}

function boundedExplanation(value: unknown): string | undefined {
	if (value === undefined || value === "") return "";
	if (typeof value !== "string") return undefined;
	const explanation = value.trim();
	return explanation.length <= 4_096 ? explanation : undefined;
}

function planStatus(value: unknown): PlanStatus | undefined {
	return value === "pending" || value === "in_progress" || value === "completed"
		? value
		: undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

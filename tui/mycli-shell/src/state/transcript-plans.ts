import type { MycliShellPlanStep, MycliShellPlanUpdate } from "../model.ts";
import { recordValue, stringArrayValue, stringValue } from "./payload-values.ts";
import type { RuntimeTranscriptItem } from "./runtime-state-model.ts";

export function planStatus(metadata: unknown): "proposed" | "accepted" | "stale" {
	const status = stringValue(recordValue(metadata).status);
	return status === "accepted" || status === "stale" ? status : "proposed";
}

function planStepsFromPayload(value: unknown): MycliShellPlanStep[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item, index) => planStepFromString(String(item), index))
		.filter((item): item is MycliShellPlanStep => item !== null);
}

export function planUpdateFromPayload(
	payload: Record<string, unknown>,
	id: string,
	text = "Updated Plan",
): RuntimeTranscriptItem | null {
	const plan = recordValue(payload.plan);
	const rawItems = Array.isArray(plan.items)
		? plan.items
		: Array.isArray(payload.items)
			? payload.items
			: null;
	const steps = rawItems !== null
		? rawItems
				.map((item, index) => planStepFromRecord(recordValue(item), index))
				.filter((item): item is MycliShellPlanStep => item !== null)
		: Array.isArray(payload.plan_steps)
			? planStepsFromPayload(payload.plan_steps)
			: null;
	if (steps === null || (rawItems !== null && steps.length !== rawItems.length)) {
		return null;
	}
	const completed = steps.filter((step) => step.status === "completed").length;
	return {
		id,
		type: "plan_update",
		text: text.trim() || "Updated Plan",
		folded: false,
		metadata: {
			source: stringValue(payload.source) ?? "Plan",
			...(stringValue(payload.explanation)
				? { explanation: stringValue(payload.explanation) }
				: {}),
			completed,
			total: steps.length,
			items: steps,
		},
	};
}

export function planUpdateFromTranscriptItem(item: RuntimeTranscriptItem): MycliShellPlanUpdate | null {
	const metadata = recordValue(item.metadata);
	const rawItems = metadata.items;
	if (!Array.isArray(rawItems)) return null;
	const steps = rawItems
		.map((entry, index) => planStepFromRecord(recordValue(entry), index))
		.filter((step): step is MycliShellPlanStep => step !== null);
	if (steps.length !== rawItems.length) return null;
	return {
		id: item.id,
		title: item.text.trim() || "Updated Plan",
		source: stringValue(metadata.source) ?? undefined,
		explanation: stringValue(metadata.explanation) ?? undefined,
		steps,
		completed: steps.filter((step) => step.status === "completed").length,
		total: steps.length,
	};
}

export function taskProgressFromPlanUpdate(
	item: RuntimeTranscriptItem,
): { completed: number; total: number } | null {
	const update = planUpdateFromTranscriptItem(item);
	if (!update || update.total === 0) return null;
	return { completed: update.completed, total: update.total };
}

function planStepFromRecord(record: Record<string, unknown>, index: number): MycliShellPlanStep | null {
	const text = stringValue(record.text) ?? stringValue(record.content) ?? stringValue(record.step);
	if (!text) return null;
	const evidence = stringArrayValue(record.evidence);
	return {
		id: stringValue(record.id) ?? `step-${index + 1}`,
		status: planStepStatus(stringValue(record.status) ?? undefined),
		text,
		...(evidence.length > 0 ? { evidence } : {}),
	};
}

function planStepFromString(value: string, index: number): MycliShellPlanStep | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const match = /^(pending|in_progress|completed)\s*:\s*(.+)$/i.exec(trimmed);
	const status = planStepStatus(match?.[1]);
	const text = (match?.[2] ?? trimmed).trim();
	if (!text) return null;
	return {
		id: `step-${index + 1}`,
		status,
		text,
	};
}

function planStepStatus(value: string | undefined): MycliShellPlanStep["status"] {
	if (value === "completed" || value === "in_progress") return value;
	return "pending";
}

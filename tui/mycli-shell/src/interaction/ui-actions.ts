import { parseSkillReferences, type SkillReference, type ReviewSelection } from "@mycli/contracts";
import type {
	MycliShellLocalImageAttachment,
	MycliShellPendingApproval,
	MycliShellPendingClarification,
	MycliShellVisualSettings,
} from "../model.ts";

export type MycliUiQueuedInput = Readonly<{
	text: string;
	localImages?: MycliShellLocalImageAttachment[];
	skillReferences?: readonly SkillReference[];
}>;

export type MycliUiAction =
	| Readonly<{
		type: "submit" | "follow_up";
		text: string;
		collaborationMode?: "default" | "plan";
		review?: ReviewSelection;
		signal?: AbortSignal;
		localImages?: MycliShellLocalImageAttachment[];
	skillReferences?: readonly SkillReference[];
	}>
	| Readonly<{ type: "command"; command: string }>
	| Readonly<{ type: "view.set"; mode: NonNullable<MycliShellVisualSettings["viewMode"]> }>
	| Readonly<{ type: "interrupt"; rollbackUserInput: boolean }>
	| Readonly<{ type: "dequeue_queued_input" }>
	| Readonly<{
		type: "approval.respond";
		approval: MycliShellPendingApproval;
		choice: string;
	}>
	| Readonly<{
		type: "clarification.respond";
		clarification: MycliShellPendingClarification;
		response: string;
	}>
	| Readonly<{ type: "exit"; reason: "normal" | "interrupt" }>;

export interface MycliUiActionDispatcher {
	dispatch(action: MycliUiAction): Promise<unknown>;
}

export function createMycliUiActionDispatcher(
	handler: (action: MycliUiAction) => unknown | Promise<unknown>,
): MycliUiActionDispatcher {
	return {
		dispatch: async (action) => handler(action),
	};
}

export function isMycliUiQueuedInput(value: unknown): value is MycliUiQueuedInput | string | null {
	if (value === null || typeof value === "string") return true;
	if (typeof value !== "object" || Array.isArray(value)) return false;
	const input = value as { text?: unknown; localImages?: unknown; skillReferences?: unknown };
	if (typeof input.text !== "string") return false;
	try { parseSkillReferences(input.skillReferences); } catch { return false; }
	if (input.localImages === undefined) return true;
	return Array.isArray(input.localImages) && input.localImages.every((image) => {
		if (typeof image !== "object" || image === null || Array.isArray(image)) return false;
		const attachment = image as { path?: unknown; placeholder?: unknown };
		return typeof attachment.path === "string" && typeof attachment.placeholder === "string";
	});
}

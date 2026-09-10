import { createHash } from "node:crypto";
import type { CanonicalConversationItem } from "../types.ts";

export const TURN_ABORTED_CONTEXT_TEXT = [
	"<turn_aborted>",
	"The previous turn was interrupted on purpose. Any running shell processes may still be running in the background. If any tools or commands were aborted, they may have partially executed.",
	"</turn_aborted>",
].join("\n");

export interface TurnAbortedContextItem {
	readonly itemId: string;
	readonly item: Extract<CanonicalConversationItem, { readonly type: "context" }>;
}

export function turnAbortedContextItem(turnId: string): TurnAbortedContextItem {
	const identity = createHash("sha256").update(turnId).digest("hex");
	const contentSha256 = createHash("sha256").update(TURN_ABORTED_CONTEXT_TEXT).digest("hex");
	return Object.freeze({
		itemId: `turn-aborted:${identity}`,
		item: Object.freeze({
			type: "context",
			text: TURN_ABORTED_CONTEXT_TEXT,
			metadata: Object.freeze({
				kind: "turn_aborted",
				role: "developer",
				cacheClass: "dynamic",
				durability: "persistent",
				scope: "transcript",
				sourceId: `turn-aborted:${identity}`,
				contentSha256,
				contentLength: TURN_ABORTED_CONTEXT_TEXT.length,
			}),
		}),
	});
}

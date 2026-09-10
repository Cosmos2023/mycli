import type { TranscriptEventEnvelope } from "../transcript/transcript-events.ts";
import { StorageFailure } from "../sessions/session-store.ts";

export interface TranscriptSearchDocument {
	readonly messageIndex: number;
	readonly role: "user" | "assistant" | "tool" | "context";
	readonly text: string;
}

export function projectTranscriptEventToSearchDocument(
	event: TranscriptEventEnvelope,
): TranscriptSearchDocument | undefined {
	if (!event.modelVisible || event.providerIndex === undefined) return undefined;
	if ("readableProjection" in event.payload
		&& event.payload.readableProjection?.searchVisible === false) return undefined;
	switch (event.eventType) {
		case "user_input":
			return document(event.providerIndex, "user", event.payload.text);
		case "assistant_output":
		case "assistant_tool_call_batch":
			return document(event.providerIndex, "assistant", event.payload.text);
		case "tool_result":
			return document(event.providerIndex, "tool", event.payload.result.output);
		case "context":
			return document(event.providerIndex, "context", event.payload.text);
		case "opaque_legacy":
			if (event.payload.sourceKind === "conversation_messages") {
				throw new StorageFailure("opaque legacy search event is not projectable", {
					legacy_error_code: event.payload.errorCode,
				});
			}
			return undefined;
		default:
			return undefined;
	}
}

function document(
	messageIndex: number,
	role: TranscriptSearchDocument["role"],
	text: string,
): TranscriptSearchDocument {
	return Object.freeze({ messageIndex, role, text });
}

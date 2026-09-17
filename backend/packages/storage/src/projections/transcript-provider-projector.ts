import type { CanonicalConversationItem } from "@mycli/core";
import { parseToolDiscoveries } from "@mycli/core";
import { repairTerminalToolProtocol } from "./legacy-provider-projection.ts";
import { StorageFailure } from "../sessions/session-store.ts";
import type { TranscriptEventEnvelope } from "../transcript/transcript-events.ts";

export interface TranscriptProviderProjectionOptions {
	readonly replacement?: readonly CanonicalConversationItem[];
	readonly activeToolCallIds?: ReadonlySet<string>;
}

export function projectTranscriptEventsToProviderItems(
	events: readonly TranscriptEventEnvelope[],
	options: TranscriptProviderProjectionOptions = {},
): readonly CanonicalConversationItem[] {
	assertEventOrder(events);
	const projected: CanonicalConversationItem[] = [...(options.replacement ?? [])];
	for (const event of events) {
		if (!event.modelVisible) continue;
		switch (event.eventType) {
			case "user_input":
				projected.push(Object.freeze({
					type: "user",
					text: event.payload.text,
					...(event.payload.images && event.payload.images.length > 0
						? { images: event.payload.images }
						: {}),
				}));
				break;
			case "assistant_output":
				projected.push(Object.freeze({
					type: "assistant",
					text: event.payload.text,
					...(event.payload.providerState ? { providerState: event.payload.providerState } : {}),
				}));
				break;
			case "assistant_tool_call_batch":
				projected.push(Object.freeze({
					type: "assistant_tool_calls",
					text: event.payload.text,
					calls: event.payload.calls,
					...(event.payload.responseId ? { responseId: event.payload.responseId } : {}),
					...(event.payload.providerState ? { providerState: event.payload.providerState } : {}),
				}));
				break;
			case "tool_result": {
				const discoveries = event.payload.result.success && event.payload.result.toolName === "tool_search"
					? parseToolDiscoveries(event.payload.metadata?.tool_discovery) : [];
				projected.push(Object.freeze({
					type: "tool_result",
					...event.payload.result,
					...(discoveries.length ? { toolDiscoveries: discoveries } : {}),
				}));
				break;
			}
			case "context":
				projected.push(Object.freeze({
					type: "context",
					text: event.payload.text,
					metadata: event.payload.metadata,
				}));
				break;
			case "opaque_legacy":
				throw new StorageFailure("opaque legacy provider event is not projectable", {
					legacy_error_code: event.payload.errorCode,
				});
			default:
				throw new StorageFailure("model-visible transcript event type is not projectable");
		}
	}
	return repairTerminalToolProtocol(
		projected,
		options.activeToolCallIds ?? new Set<string>(),
	);
}

function assertEventOrder(events: readonly TranscriptEventEnvelope[]): void {
	let previousSequence = 0;
	let previousProviderIndex = -1;
	for (const event of events) {
		if (event.sequenceNo <= previousSequence) {
			throw new StorageFailure("transcript events are not in sequence order");
		}
		previousSequence = event.sequenceNo;
		if (!event.modelVisible) continue;
		if (event.providerIndex === undefined || event.providerIndex <= previousProviderIndex) {
			throw new StorageFailure("provider transcript events are not in provider order");
		}
		previousProviderIndex = event.providerIndex;
	}
}

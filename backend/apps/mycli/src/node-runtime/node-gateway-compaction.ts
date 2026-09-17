import type { RuntimeEvent } from "@mycli/core";
import type { RuntimeGatewayEventMethod } from "./node-gateway-event-projector.ts";

export type GatewayCompactionEvent = Extract<RuntimeEvent, {
	readonly type: "compaction_started" | "compaction_progress" | "compaction_completed";
}>;

export function publishCompactionEvent(
	event: GatewayCompactionEvent,
	publish: (method: RuntimeGatewayEventMethod, params: Record<string, unknown>) => void,
): void {
	const identity = { client_turn_id: event.clientTurnId, checkpoint_id: event.operationId };
	if (event.type === "compaction_progress") {
		publish("status.update", { ...identity, state: "running", kind: "compaction",
			text: `Compacting context: ${event.text}` });
		return;
	}
	const tokens = { source: event.source, before_tokens: event.beforeTokens, max_tokens: event.maxTokens };
	if (event.type === "compaction_started") {
		publish("compaction.started", { ...identity, ...tokens });
		return;
	}
	publish("compaction.completed", { ...identity, ...tokens, status: event.status,
		after_tokens: event.afterTokens, duration_s: event.durationSeconds,
		...(event.failure ? { failure: event.failure } : {}),
		...(event.usage ? { usage: event.usage } : {}),
	});
}

import { parseGatewayResult, parseProviderAttemptRecord, type GatewayResult } from "@mycli/contracts";
import type { CreateNodeGatewayOptions } from "./node-gateway-types.ts";
import { GatewayFailure } from "./node-gateway-errors.ts";

type AttemptQuery = Parameters<NonNullable<CreateNodeGatewayOptions["loadProviderAttempts"]>>[0];

export function loadGatewayProviderAttempts(
	load: CreateNodeGatewayOptions["loadProviderAttempts"],
	input: AttemptQuery,
): GatewayResult<"provider.attempts.load"> {
	let limit = Math.min(500, input.limit ?? 200);
	for (;;) {
		const rows = (load?.({ ...input, limit: limit + 1 }) ?? []).map(parseProviderAttemptRecord);
		if (rows.some((record) => record.sessionId !== input.sessionId
			|| (input.turnId !== undefined && record.turnId !== input.turnId)
			|| (input.requestId !== undefined && record.requestId !== input.requestId)
			|| (input.afterSequence !== undefined && record.sequence <= input.afterSequence))) {
			throw new GatewayFailure("internal_error", "Provider attempt history ownership mismatch.");
		}
		const result = {
			session_id: input.sessionId,
			records: (input.requestId === undefined ? rows.slice(-limit) : rows.slice(0, limit))
				.map((record) => ({ ...record })),
			has_more: rows.length > limit,
			next_before_event_id: input.requestId === undefined && rows.length > limit
				? rows.at(-limit)?.eventId ?? null : null,
		};
		if (Buffer.byteLength(JSON.stringify(result), "utf8") <= 1_048_576) return parseGatewayResult("provider.attempts.load", result);
		if (limit === 1) throw new GatewayFailure("gateway_message_too_large", "Provider attempt exceeds the gateway page budget.");
		limit = Math.max(1, Math.floor(limit / 2));
	}
}

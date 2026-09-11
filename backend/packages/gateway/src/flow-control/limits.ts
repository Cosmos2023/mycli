export interface GatewayFlowControlLimits {
	readonly maxFrameBytes: number;
	readonly maxPendingRequests: number;
	readonly maxPendingRequestBytes: number;
	readonly controlReserveRequests: number;
	readonly controlReserveBytes: number;
	readonly maxQueuedMessages: number;
	readonly maxQueuedBytes: number;
	readonly writeStallTimeoutMs: number;
}

export const DEFAULT_GATEWAY_LIMITS: GatewayFlowControlLimits = Object.freeze({
	maxFrameBytes: 8 * 1024 * 1024,
	maxPendingRequests: 64,
	maxPendingRequestBytes: 16 * 1024 * 1024,
	controlReserveRequests: 8,
	controlReserveBytes: 256 * 1024,
	maxQueuedMessages: 256,
	maxQueuedBytes: 16 * 1024 * 1024,
	writeStallTimeoutMs: 15_000,
});

export class GatewayFlowControlError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "GatewayFlowControlError";
	}
}

export function gatewayLimits(
	options: Partial<GatewayFlowControlLimits> = {},
): GatewayFlowControlLimits {
	const limits = { ...DEFAULT_GATEWAY_LIMITS, ...options };
	for (const [key, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new RangeError(`Invalid gateway limit: ${key}.`);
		}
	}
	if (limits.writeStallTimeoutMs > 2_147_483_647) throw new RangeError("Invalid gateway write timeout.");
	return Object.freeze(limits);
}

export function isGatewayControlMethod(method: string): boolean {
	return ["turn.interrupt", "approval.respond", "clarify.respond", "shell.stop", "shell.stop_all", "shutdown"]
		.includes(method);
}

export function gatewayOverloaded(): GatewayFlowControlError {
	return new GatewayFlowControlError("gateway_overloaded", "Gateway capacity exceeded.");
}

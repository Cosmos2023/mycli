import { gatewayContractCatalog, type GatewayEventNotification } from "@mycli/contracts";

export type RuntimeEventParams = Readonly<Record<string, unknown>>;

const NON_RUNTIME_EVENT_METHODS = new Set<string>([
	"extension.updated",
	"runtime.event",
	"runtime.ready",
]);

export type RuntimeEventMethod = Exclude<
	GatewayEventNotification["method"],
	"extension.updated" | "runtime.event" | "runtime.ready"
>;

const runtimeEventMethods = new Set<string>(
	gatewayContractCatalog.eventStreams.filter((method) => !NON_RUNTIME_EVENT_METHODS.has(method)),
);

export type RuntimeEventOwnership = Readonly<{
	sessionId: string | null;
	generation: number | null;
	turnId: string | null;
	clientTurnId: string | null;
}>;

export type DecodedRuntimeEvent<Method extends string = RuntimeEventMethod> = Readonly<{
	method: Method;
	params: RuntimeEventParams;
	ownership: RuntimeEventOwnership;
	source: "direct" | "envelope" | "synthetic";
	sequence?: number;
}>;

export function decodeGatewayRuntimeEvent(
	event: GatewayEventNotification,
): DecodedRuntimeEvent | null {
	if (event.method === "runtime.event") {
		const method = stringValue(event.params.type);
		if (!method || !isRuntimeEventMethod(method)) return null;
		const params = recordValue(event.params.payload);
		return {
			method,
			params,
			ownership: ownershipFrom(params, recordValue(event.params)),
			source: "envelope",
			sequence: integerValue(event.params.sequence) ?? undefined,
		};
	}
	if (!isRuntimeEventMethod(event.method)) return null;
	const params = recordValue(event.params);
	return {
		method: event.method,
		params,
		ownership: ownershipFrom(params),
		source: "direct",
	};
}

/** Compatibility decoder for reducer tests and locally synthesized UI events. */
export function decodeRuntimeEventInput(
	method: string,
	input: object,
): DecodedRuntimeEvent<string> | null {
	const params = recordValue(input);
	if (method === "runtime.event") {
		const nestedMethod = stringValue(params.type);
		if (!nestedMethod) return null;
		const payload = recordValue(params.payload);
		return {
			method: nestedMethod,
			params: payload,
			ownership: ownershipFrom(payload, params),
			source: "synthetic",
			sequence: integerValue(params.sequence) ?? undefined,
		};
	}
	return {
		method,
		params,
		ownership: ownershipFrom(params),
		source: "synthetic",
	};
}

export function runtimeEventFingerprint(event: DecodedRuntimeEvent<string>): string {
	return stableStringify({
		method: event.method,
		ownership: event.ownership,
		params: event.params,
	});
}

export function isRuntimeEventMethod(value: string): value is RuntimeEventMethod {
	return runtimeEventMethods.has(value);
}

function ownershipFrom(
	params: RuntimeEventParams,
	envelope: RuntimeEventParams = params,
): RuntimeEventOwnership {
	return {
		sessionId: stringValue(envelope.session_id)
			?? stringValue(envelope.sessionId)
			?? stringValue(params.session_id)
			?? stringValue(params.sessionId),
		generation: integerValue(envelope.generation) ?? integerValue(params.generation),
		turnId: stringValue(envelope.turn_id)
			?? stringValue(envelope.turnId)
			?? stringValue(params.turn_id)
			?? stringValue(params.turnId),
		clientTurnId: stringValue(envelope.client_turn_id)
			?? stringValue(envelope.clientTurnId)
			?? stringValue(params.client_turn_id)
			?? stringValue(params.clientTurnId),
	};
}

function recordValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {};
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function integerValue(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

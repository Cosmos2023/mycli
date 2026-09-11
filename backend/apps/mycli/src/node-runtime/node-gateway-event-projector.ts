import {
	parseGatewayEvent,
	parseProviderAttemptRecord,
	gatewayToolLifecycleRecord,
	projectGatewayErrorPayload,
	type GatewayEventNotification,
} from "@mycli/contracts";

type JsonObject = Record<string, unknown>;

export type GatewayEventMethod = GatewayEventNotification["method"];
export type RuntimeGatewayEventMethod = Exclude<
	GatewayEventMethod,
	"extension.updated" | "runtime.event" | "runtime.ready"
>;

export interface GatewayEventOwnership {
	readonly sessionId: string;
	readonly generation: number;
	readonly turnId?: string;
}

interface NodeGatewayEventProjectorOptions {
	readonly errorContextVersion?: () => 1 | undefined;
	readonly clock: () => number;
	readonly currentOwnership: (
		method: RuntimeGatewayEventMethod,
		params: Readonly<JsonObject>,
	) => GatewayEventOwnership;
	readonly write: (notification: GatewayEventNotification) => void;
}

export class NodeGatewayEventProjector {
	readonly #options: NodeGatewayEventProjectorOptions;
	#sequence = 0;

	constructor(options: NodeGatewayEventProjectorOptions) {
		this.#options = options;
	}

	emitDirect(method: GatewayEventMethod, params: JsonObject): void {
		this.#write(method, toolRecordPayload(method, params));
	}

	emitRuntime(
		method: RuntimeGatewayEventMethod,
		params: JsonObject,
		ownership: GatewayEventOwnership = this.#options.currentOwnership(method, params),
	): void {
		const ownedParams = ownershipPayload(toolRecordPayload(method, params), ownership);
		this.#write(method, ownedParams);
		this.#sequence += 1;
		this.#write("runtime.event", {
			version: 1,
			sequence: this.#sequence,
			type: method,
			payload: ownedParams,
			timestamp: this.#options.clock(),
			session_id: ownership.sessionId,
			generation: ownership.generation,
			...(ownership.turnId ? { turn_id: ownership.turnId } : {}),
		});
	}

	#write(method: GatewayEventMethod, params: JsonObject): void {
		const projected = projectGatewayErrorPayload(method, params, this.#options.errorContextVersion?.() === 1 ? "read" : "legacy");
		const notification = parseGatewayEvent({ jsonrpc: "2.0", method, params: projected });
		this.#options.write(notification);
	}
}

function toolRecordPayload(method: GatewayEventMethod, params: JsonObject): JsonObject {
	if (method === "provider.attempt.updated") {
		const record = parseProviderAttemptRecord(params.record);
		if (record.sessionId !== params.session_id || record.turnId !== params.turn_id) {
			throw new Error("Provider attempt event ownership mismatch.");
		}
		return { ...params, record };
	}
	return method === "tool.start" || method === "tool.complete" || method === "tool.failed"
		? { ...params, tool_record: gatewayToolLifecycleRecord(method, params) }
		: params;
}

function ownershipPayload(
	params: JsonObject,
	ownership: GatewayEventOwnership,
): JsonObject {
	const explicitSessionId = typeof params.session_id === "string" && params.session_id
		? params.session_id
		: undefined;
	const sessionMatchesOwner = explicitSessionId === undefined
		|| explicitSessionId === ownership.sessionId;
	return {
		...params,
		session_id: explicitSessionId ?? ownership.sessionId,
		...(params.generation === undefined && sessionMatchesOwner
			? { generation: ownership.generation }
			: {}),
		...(ownership.turnId && params.turn_id === undefined
			? { turn_id: ownership.turnId }
			: {}),
	};
}

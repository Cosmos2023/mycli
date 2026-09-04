import {
	parseGatewayEvent,
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

export interface NodeGatewayEventProjectorOptions {
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
		this.#write(method, params);
	}

	emitRuntime(
		method: RuntimeGatewayEventMethod,
		params: JsonObject,
		ownership: GatewayEventOwnership = this.#options.currentOwnership(method, params),
	): void {
		const ownedParams = ownershipPayload(params, ownership);
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
		const notification = parseGatewayEvent({ jsonrpc: "2.0", method, params });
		this.#options.write(notification);
	}
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

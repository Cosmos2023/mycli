import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayEventDeduper } from "../../src/adapters/gateway-events.ts";
import type { GatewayEvent, RpcMessage } from "../../src/adapters/gateway-client.ts";
import { initialRuntimeState, reduceDecodedRuntimeEvent, type RuntimeShellState } from "../../src/adapters/runtime-state.ts";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export function loadGatewayReplay(name: string): GatewayEvent[] {
	const text = readFileSync(join(fixtureRoot, name), "utf8");
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as RpcMessage)
		.filter(isGatewayEvent);
}

export function replayGatewayEvents(events: GatewayEvent[]): RuntimeShellState {
	const deduper = new GatewayEventDeduper();
	let state = initialRuntimeState();
	for (const event of events) {
		const decoded = deduper.consume(event);
		if (decoded) state = reduceDecodedRuntimeEvent(state, decoded);
	}
	return state;
}

function isGatewayEvent(message: RpcMessage): message is GatewayEvent {
	return "method" in message && typeof message.method === "string" && !("id" in message);
}

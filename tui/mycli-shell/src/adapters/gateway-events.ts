import type { GatewayEvent } from "./gateway-client.ts";
import {
	decodeGatewayRuntimeEvent,
	runtimeEventFingerprint,
	type DecodedRuntimeEvent,
} from "./runtime-events.ts";

export class GatewayEventDeduper {
	private lastDirectFingerprint: string | null = null;

	consume(event: GatewayEvent): DecodedRuntimeEvent | null {
		const decoded = decodeGatewayRuntimeEvent(event);
		if (!decoded) return null;
		const fingerprint = runtimeEventFingerprint(decoded);
		if (decoded.source === "envelope") {
			const duplicate = this.lastDirectFingerprint === fingerprint;
			this.lastDirectFingerprint = null;
			return duplicate ? null : decoded;
		}
		this.lastDirectFingerprint = fingerprint;
		return decoded;
	}

	/** @deprecated Consume the decoded event so envelope ownership is not discarded. */
	shouldConsume(event: GatewayEvent): boolean {
		return this.consume(event) !== null;
	}
}

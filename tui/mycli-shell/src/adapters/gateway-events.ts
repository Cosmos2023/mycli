import type { GatewayEvent } from "./gateway-client.ts";

type DirectEventFingerprint = {
	type: string;
	payload: string;
};

export class GatewayEventDeduper {
	private lastDirect: DirectEventFingerprint | null = null;

	shouldConsume(event: GatewayEvent): boolean {
		const mirrored = mirroredEvent(event);
		if (mirrored) {
			const fingerprint = fingerprintEvent(mirrored.type, mirrored.payload);
			if (this.lastDirect?.type === fingerprint.type && this.lastDirect.payload === fingerprint.payload) {
				this.lastDirect = null;
				return false;
			}
			this.lastDirect = null;
			return true;
		}
		this.lastDirect = fingerprintEvent(event.method, event.params);
		return true;
	}
}

function mirroredEvent(event: GatewayEvent): { type: string; payload: Record<string, unknown> } | null {
	if (event.method !== "runtime.event") return null;
	const type = event.params.type;
	const payload = event.params.payload;
	if (typeof type !== "string" || typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return null;
	}
	return { type, payload: payload as Record<string, unknown> };
}

function fingerprintEvent(type: string, payload: unknown): DirectEventFingerprint {
	return { type, payload: stableStringify(payload) };
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

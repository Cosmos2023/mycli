import { isGatewayControlMethod, type GatewayFlowControlLimits } from "./limits.ts";

export class GatewayRequestBudget {
	#count = 0;
	#bytes = 0;

	constructor(private readonly limits: GatewayFlowControlLimits) {}

	acquire(method: string, bytes: number): (() => void) | undefined {
		const control = isGatewayControlMethod(method);
		const maxCount = this.limits.maxPendingRequests + (control ? this.limits.controlReserveRequests : 0);
		const maxBytes = this.limits.maxPendingRequestBytes + (control ? this.limits.controlReserveBytes : 0);
		if (this.#count >= maxCount || this.#bytes + bytes > maxBytes) return undefined;
		this.#count++;
		this.#bytes += bytes;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#count--;
			this.#bytes -= bytes;
		};
	}
}

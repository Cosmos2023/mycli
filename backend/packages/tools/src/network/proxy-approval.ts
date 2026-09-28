import type { NetworkAccessDetails } from "@mycli/contracts";
import type { Socket } from "node:net";
import type { NetworkProxyInteraction } from "./network-proxy.ts";
import { NetworkProxyError } from "./proxy-protocol.ts";

const APPROVAL_TIMEOUT_MS = 120_000;
const SETUP_TIMEOUT_MS = 10_000;

/** One bounded setup budget, paused only while the host is awaiting an explicit decision. */
export class ProxyRequestSetup {
	readonly #deadline = new AbortController();
	readonly signal: AbortSignal;
	details?: Omit<NetworkAccessDetails, "reason">;
	#timer: NodeJS.Timeout;
	#remaining = SETUP_TIMEOUT_MS;
	#started = performance.now();
	readonly #disconnected = new AbortController();
	readonly #onClose = (): void => this.#disconnected.abort();

	constructor(readonly client: Socket, shutdown: AbortSignal, readonly transport: Socket = client) {
		client.once("close", this.#onClose);
		if (client.destroyed) this.#disconnected.abort();
		this.signal = AbortSignal.any([shutdown, this.#disconnected.signal, this.#deadline.signal]);
		this.#timer = this.#arm();
	}

	async approve(interaction: NetworkProxyInteraction): Promise<void> {
		this.signal.throwIfAborted();
		if (!interaction.requestApproval) throw new NetworkProxyError(403, "Interactive network approval is unavailable.", "approval_unavailable");
		clearTimeout(this.#timer);
		this.#remaining = Math.max(0, this.#remaining - (performance.now() - this.#started));
		this.client.setTimeout(0);
		if (this.transport !== this.client) this.transport.setTimeout(0);
		const expired = new AbortController();
		const timeout = setTimeout(() => expired.abort(), APPROVAL_TIMEOUT_MS);
		timeout.unref();
		const signal = AbortSignal.any([this.signal, expired.signal]);
		const aborted = (): NetworkProxyError => new NetworkProxyError(403, "Network approval was cancelled.",
			expired.signal.aborted ? "approval_timeout" : "request_cancelled");
		let onAbort: () => void = () => undefined;
		try {
			const decision = await Promise.race([
				Promise.resolve().then(() => { signal.throwIfAborted(); return interaction.requestApproval!({ ...this.details, reason: "approval_required" }, signal); }),
				new Promise<never>((_resolve, reject) => {
					onAbort = (): void => reject(aborted());
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) onAbort();
				}),
			]);
			if (signal.aborted) throw aborted();
			if (decision !== "approve_once") throw new NetworkProxyError(403, "Network access was not approved.",
				decision === "reject" ? "approval_denied" : "approval_unavailable");
		} finally {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			this.client.setTimeout(30_000);
			if (this.transport !== this.client) this.transport.setTimeout(30_000);
			this.#started = performance.now();
			this.#timer = this.#arm();
		}
	}

	close(): void {
		clearTimeout(this.#timer);
		this.client.removeListener("close", this.#onClose);
	}

	#arm(): NodeJS.Timeout {
		const timer = setTimeout(() => this.#deadline.abort(), this.#remaining);
		timer.unref();
		return timer;
	}
}

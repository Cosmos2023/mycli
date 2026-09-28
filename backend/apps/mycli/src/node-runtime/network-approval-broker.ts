import { randomUUID } from "node:crypto";
import { networkAccessReasonText, networkAccessTargetText, parseGatewayParams, type NetworkAccessDetails } from "@mycli/contracts";
import type { NetworkProxyInteraction, NetworkProxyOwner } from "@mycli/tools";

interface Notification {
	readonly method: "approval.request" | "approval.respond" | "interactive.cancelled" | "network.blocked";
	readonly params: Record<string, unknown>;
}
interface Pending {
	readonly owner: NetworkProxyOwner;
	readonly params: Record<string, unknown>;
	finish(choice: "approve_once" | "reject" | "unavailable"): void;
}

/** Live, process-owned decisions. No continuation, command replay or persistent permission grant. */
export class NetworkApprovalBroker {
	readonly #listeners = new Set<(notification: Notification) => void>();
	readonly #pending = new Map<string, Pending>();
	#closed = false;
	#available = true;
	#epoch = 0;

	readonly interaction = (owner: NetworkProxyOwner): NetworkProxyInteraction => {
		const frozen = Object.freeze({ ...owner });
		const epoch = this.#epoch;
		let diagnostics = 0;
		return {
			requestApproval: (details, signal) => epoch === this.#epoch ? this.#request(frozen, details, signal) : Promise.resolve("unavailable"),
			onBlocked: (details) => {
				// Bound transcript traffic per process, including hostile clients in the sandbox.
				if (epoch === this.#epoch && diagnostics++ < 32) this.#notify({ method: "network.blocked", params: { ...ownership(frozen), details } });
			},
		};
	};

	hasPending(sessionId?: string): boolean {
		return [...this.#pending.values()].some((pending) => sessionId === undefined || pending.owner.sessionId === sessionId);
	}

	respond(raw: unknown): { readonly accepted: true } | undefined {
		if (!raw || typeof raw !== "object" || !("decision_id" in raw) || typeof raw.decision_id !== "string" || !raw.decision_id.startsWith("network:")) return undefined;
		const response = parseGatewayParams("approval.respond", raw);
		if (!response.decision_id?.startsWith("network:")) return undefined;
		const pending = this.#pending.get(response.decision_id);
		if (!pending || response.session_id !== pending.owner.sessionId) {
			throw Object.assign(new Error("This network request is no longer pending."), { code: "approval_not_pending" });
		}
		if (response.choice !== "approve_once" && response.choice !== "reject") {
			throw Object.assign(new Error("Network access supports only allow once or reject."), { code: "invalid_params" });
		}
		pending.finish(response.choice);
		return { accepted: true };
	}

	subscribe(listener: (notification: Notification) => void): () => void {
		this.#listeners.add(listener);
		for (const pending of this.#pending.values()) listener({ method: "approval.request", params: pending.params });
		return () => {
			this.#listeners.delete(listener);
			if (!this.#listeners.size) this.cancelAll();
		};
	}

	setAvailability(available: boolean): void {
		this.#available = available;
		if (!available) this.cancelAll();
	}

	cancelAll(): void { for (const pending of this.#pending.values()) pending.finish("unavailable"); }
	revoke(): void { this.#epoch += 1; this.cancelAll(); }
	close(): void { this.#closed = true; this.cancelAll(); this.#listeners.clear(); }

	async #request(owner: NetworkProxyOwner, details: NetworkAccessDetails, signal: AbortSignal): Promise<"approve_once" | "reject" | "unavailable"> {
		if (this.#closed || !this.#available || signal.aborted || !this.#listeners.size || this.#pending.size >= 32) return "unavailable";
		const id = `network:${randomUUID()}`;
		const params = { ...ownership(owner), decision_id: id, network_request: details, tool_name: "Network",
			preview: networkAccessTargetText(details), reason: networkAccessReasonText(details.reason),
			options: [{ choice: "approve_once", label: "Allow once / 仅允许本次" }, { choice: "reject", label: "Reject / 拒绝" }] };
		return new Promise((resolve) => {
			const finish = (choice: "approve_once" | "reject" | "unavailable"): void => {
				if (!this.#pending.delete(id)) return;
				signal.removeEventListener("abort", cancel);
				this.#notify({ method: choice === "unavailable" ? "interactive.cancelled" : "approval.respond",
					params: { ...ownership(owner), decision_id: id, ...(choice === "unavailable" ? { network_request: details } : { choice }) } });
				resolve(choice);
			};
			const cancel = (): void => finish("unavailable");
			this.#pending.set(id, { owner, params, finish });
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) cancel();
			else this.#notify({ method: "approval.request", params });
		});
	}

	#notify(notification: Notification): void {
		if (this.#closed) return;
		for (const listener of this.#listeners) {
			try { listener(notification); } catch { /* Disconnected UI never grants authority. */ }
		}
	}
}

function ownership(owner: NetworkProxyOwner): Record<string, unknown> {
	return { session_id: owner.sessionId, call_id: owner.callId, ...(owner.turnId ? { turn_id: owner.turnId } : {}) };
}

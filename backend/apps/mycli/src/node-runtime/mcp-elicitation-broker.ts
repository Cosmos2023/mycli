import { parseGatewayParams, type McpElicitationRequest } from "@mycli/contracts";
import type { McpElicitationHandler, McpElicitationPrompt } from "@mycli/integrations";

type ElicitationResult = Awaited<ReturnType<McpElicitationHandler>>;
type Notification = {
	readonly method: "mcp.elicitation.request" | "mcp.elicitation.respond";
	readonly params: Record<string, unknown>;
};
interface Pending {
	readonly prompt: McpElicitationPrompt;
	resolve(result: ElicitationResult): void;
}

/** Live responders only: credentials and form answers never enter the transcript or diagnostics. */
export class McpElicitationBroker {
	readonly #listeners = new Set<(notification: Notification) => void>();
	readonly #pending = new Map<string, Pending>();
	#closed = false;

	readonly request: McpElicitationHandler = async (prompt, signal) => {
		if (this.#closed || signal.aborted || !this.#listeners.size || this.#pending.size >= 32) return { action: "cancel" };
		const { request } = prompt;
		return new Promise<ElicitationResult>((resolve) => {
			const finish = (result: ElicitationResult): void => {
				if (!this.#pending.delete(request.request_id)) return;
				signal.removeEventListener("abort", cancel);
				this.#notify({ method: "mcp.elicitation.respond", params: {
					request_id: request.request_id, session_id: request.session_id,
					...(request.turn_id ? { turn_id: request.turn_id } : {}), action: result.action,
				} });
				resolve(result);
			};
			const cancel = (): void => finish({ action: "cancel" });
			this.#pending.set(request.request_id, { prompt, resolve: finish });
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) cancel();
			else this.#notify({ method: "mcp.elicitation.request", params: { ...request } });
		});
	};

	subscribe(listener: (notification: Notification) => void): () => void {
		this.#listeners.add(listener);
		for (const pending of this.#pending.values()) listener({ method: "mcp.elicitation.request", params: { ...pending.prompt.request } });
		return () => {
			this.#listeners.delete(listener);
			if (!this.#listeners.size) this.cancelAll();
		};
	}

	pending(): readonly McpElicitationRequest[] { return [...this.#pending.values()].map((entry) => entry.prompt.request); }

	respond(raw: unknown): { readonly accepted: true } {
		const response = parseGatewayParams("mcp.elicitation.respond", raw);
		const pending = this.#pending.get(response.request_id);
		if (!pending || pending.prompt.request.session_id !== response.session_id) throw requestError("clarification_not_pending", "This MCP request is no longer pending.");
		const result = { action: response.action, ...(response.content === undefined ? {} : { content: response.content }) };
		if (!pending.prompt.validate(result)) throw requestError("invalid_params", "The response does not match the MCP form. Check the field values.");
		pending.resolve(result);
		return { accepted: true };
	}

	cancelAll(): void { for (const pending of this.#pending.values()) pending.resolve({ action: "cancel" }); }
	close(): void { this.#closed = true; this.cancelAll(); this.#listeners.clear(); }

	#notify(notification: Notification): void {
		for (const listener of this.#listeners) {
			try { listener(notification); } catch { /* A disconnected UI cannot change MCP execution. */ }
		}
	}
}

function requestError(code: string, message: string): Error & { readonly code: string } {
	return Object.assign(new Error(message), { code });
}

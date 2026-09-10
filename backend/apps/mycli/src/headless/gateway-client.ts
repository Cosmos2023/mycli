import { createErrorContext, localConnectionReason, readErrorContext, type GatewayEventNotification, type GatewayMethod, type GatewayParams, type GatewayResult } from "@mycli/contracts";
import { bootstrapGateway, GatewayClient, GatewayRequestError } from "@mycli/gateway";
import type { NodeBackend } from "../node-runtime/node-backend.ts";
import { HeadlessError } from "./types.ts";

export class HeadlessGatewayClient {
	readonly ready: Promise<void>;
	readonly #client: GatewayClient;
	readonly #onFailure: (error: unknown) => void;
	#closed = false;

	constructor(backend: NodeBackend, signal: AbortSignal, onEvent: (event: GatewayEventNotification) => void, onFailure: (error: unknown) => void) {
		this.#onFailure = onFailure;
		const disconnected = (): HeadlessError => new HeadlessError("backend_exited", 1, createErrorContext({
			reason: localConnectionReason(backend.diagnostic() || backend.transport.diagnostic?.()), source: "gateway",
			scope: { kind: "connection", id: "headless" }, outcome: { state: "unknown", effects: "possible" },
		}));
		this.#client = new GatewayClient({
			...backend.transport,
			signal,
			log: onEvent,
			onClose: () => { this.#fail(signal.aborted ? headlessGatewayError(signal.reason) : disconnected()); },
		});
		this.ready = this.#client.waitForEvent("runtime.ready").then(() => undefined, (error: unknown) => {
			const failure = headlessGatewayError(error);
			this.#fail(failure);
			throw failure;
		});
		void this.ready.catch(() => undefined);
		this.#client.start();
		void backend.completion.then(
			() => { this.#fail(disconnected()); },
			() => { this.#fail(disconnected()); },
		);
	}

	async request<M extends GatewayMethod>(method: M, params: GatewayParams<M>): Promise<GatewayResult<M>> {
		if (this.#closed) throw new HeadlessError("gateway_closed");
		try { return await this.#client.request(method, params); }
		catch (error) { throw headlessGatewayError(error); }
	}

	async bootstrap(): Promise<GatewayResult<"session.bootstrap">> {
		try { return await bootstrapGateway((params) => this.#client.request("session.bootstrap", params)); }
		catch (error) { throw headlessGatewayError(error); }
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#client.stop();
	}

	#fail(error: HeadlessError): void {
		if (this.#closed) return;
		this.close();
		this.#onFailure(error);
	}
}

function headlessGatewayError(error: unknown): HeadlessError {
	if (error instanceof HeadlessError) return error;
	if (error instanceof GatewayRequestError && /^[a-z][a-z0-9_]{0,79}$/u.test(error.code)) {
		return new HeadlessError(error.code, 1, readErrorContext(error.data.error_context));
	}
	return new HeadlessError("gateway_protocol_error");
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

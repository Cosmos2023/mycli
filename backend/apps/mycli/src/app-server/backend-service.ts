import { setImmediate as nextImmediate } from "node:timers/promises";
import { GatewayRpcValidationError } from "@mycli/contracts";
import {
	GatewayClient, GatewayRequestError,
	type GatewayEvent, type GatewayFlowControlLimits, type GatewayTransport,
} from "@mycli/gateway";
import { gatewayLimits } from "@mycli/gateway/flow-control";
import type { NodeBackend, StartNodeBackendOptions } from "../node-runtime/node-backend.ts";
import { startSupervisedNodeBackend } from "../node-runtime/node-backend-supervisor.ts";
import {
	NodeGatewayRpcTransport,
	type NodeGatewayRpcFailure, type NodeGatewayRpcRequest,
} from "../node-runtime/node-gateway-rpc-transport.ts";
import { BackendServiceError, isObserverMethod, type BackendClientRole } from "./client-access.ts";

export interface BackendServiceOptions {
	readonly maxClients?: number;
}

export interface BackendClientOptions {
	readonly role?: BackendClientRole;
	readonly limits?: Partial<GatewayFlowControlLimits>;
}

export interface BackendClientAttachment {
	readonly id: string;
	readonly role: BackendClientRole;
	readonly transport: GatewayTransport;
	readonly completion: Promise<void>;
	close(): Promise<void>;
}

export interface BackendServiceSnapshot {
	readonly state: "running" | "closing" | "closed";
	readonly clients: readonly { readonly id: string; readonly role: BackendClientRole }[];
	readonly controller?: { readonly id: string; readonly detached: boolean; readonly pendingMutations: number };
}

interface ClientRecord {
	readonly id: string;
	readonly role: BackendClientRole;
	readonly rpc: NodeGatewayRpcTransport;
	readonly completion: Promise<void>;
	readonly resolveCompletion: () => void;
	detached: boolean;
	pendingMutations: number;
	closePromise?: Promise<void>;
}

export async function startBackendService(
	options: StartNodeBackendOptions,
	serviceOptions: BackendServiceOptions = {},
): Promise<BackendService> {
	const backend = await startSupervisedNodeBackend(options);
	try { return new BackendService(backend, serviceOptions); }
	catch (error) {
		try { await backend.close(); } catch { backend.kill(); }
		throw error;
	}
}

export class BackendService {
	readonly completion: Promise<number>;
	readonly #backend: NodeBackend;
	readonly #upstream: GatewayClient;
	readonly #maxClients: number;
	readonly #clients = new Map<string, ClientRecord>();
	readonly #detaching = new Set<Promise<void>>();
	#controller: ClientRecord | undefined;
	#ready: GatewayEvent | undefined;
	#nextClientId = 1;
	#state: BackendServiceSnapshot["state"] = "running";
	#failed = false;
	#closePromise?: Promise<void>;

	constructor(backend: NodeBackend, options: BackendServiceOptions = {}) {
		const maxClients = options.maxClients ?? 16;
		if (!Number.isSafeInteger(maxClients) || maxClients < 1 || maxClients > 64) {
			throw new RangeError("Backend service maxClients must be between 1 and 64.");
		}
		this.#backend = backend;
		this.#maxClients = maxClients;
		this.#upstream = new GatewayClient({
			...backend.transport,
			eventReplayLimit: 0,
			log: (event) => this.#broadcast(event),
			onClose: () => { this.#failed = true; void this.close().catch(() => undefined); },
		});
		this.completion = backend.completion.then((code) => this.#finish(code), () => this.#finish(1));
		this.#upstream.start();
	}

	attach(options: BackendClientOptions = {}): BackendClientAttachment {
		if (this.#state !== "running") throw new BackendServiceError("service_closed");
		if (this.#clients.size >= this.#maxClients) throw new BackendServiceError("client_limit_exceeded");
		const role = options.role ?? "observer";
		if (role !== "observer" && role !== "controller") throw new TypeError("Invalid backend client role.");
		if (role === "controller" && this.#controller) {
			throw new BackendServiceError(this.#controller.detached ? "controller_draining" : "controller_attached");
		}
		const limits = gatewayLimits(options.limits);
		let resolveCompletion!: () => void;
		const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
		const record: ClientRecord = {
			id: `client-${this.#nextClientId++}`, role, completion, resolveCompletion,
			detached: false, pendingMutations: 0,
			rpc: new NodeGatewayRpcTransport({
				limits,
				dispatch: (request) => this.#dispatch(record, request),
				mapFailure,
				close: () => this.#detach(record, false),
			}),
		};
		this.#clients.set(record.id, record);
		if (role === "controller") this.#controller = record;
		if (this.#ready) record.rpc.writeNotification(this.#ready);
		return Object.freeze({
			id: record.id, role, transport: record.rpc.transport, completion,
			close: () => this.#detach(record, false),
		});
	}

	snapshot(): BackendServiceSnapshot {
		return Object.freeze({
			state: this.#state,
			clients: Object.freeze([...this.#clients.values()].map(({ id, role }) => Object.freeze({ id, role }))),
			...(this.#controller ? { controller: Object.freeze({
				id: this.#controller.id, detached: this.#controller.detached,
				pendingMutations: this.#controller.pendingMutations,
			}) } : {}),
		});
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#state = "closing";
		this.#upstream.expectClose();
		this.#closePromise = Promise.resolve().then(() => this.#close());
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		try { await this.#backend.close(); }
		catch {
			this.#failed = true;
			this.#backend.kill();
			throw new Error("Backend service cleanup failed.");
		} finally {
			this.#upstream.stop();
			// Forward already settled RPC results before ending downstream writers.
			await nextImmediate();
			await Promise.all([...this.#clients.values()].map((record) => this.#detach(record, true)));
			await Promise.all([...this.#detaching]);
			this.#controller = undefined;
			this.#ready = undefined;
			this.#state = "closed";
		}
	}

	async #finish(code: number): Promise<number> {
		try { await this.close(); } catch { this.#failed = true; }
		return this.#failed && code === 0 ? 1 : code;
	}

	async #dispatch(record: ClientRecord, request: NodeGatewayRpcRequest): Promise<Record<string, unknown>> {
		if (record.detached) throw new BackendServiceError("client_detached");
		if (this.#state !== "running") throw new BackendServiceError("service_closed");
		const mutating = !isObserverMethod(request.method);
		if (mutating && (record.role !== "controller" || this.#controller !== record)) {
			throw new BackendServiceError("read_only_client");
		}
		if (request.method === "shutdown") {
			this.#state = "closing";
			// Enqueue the reply first, but honor shutdown even if its client disconnects.
			setImmediate(() => { void this.close().catch(() => undefined); });
			return { ok: true };
		}
		if (mutating) record.pendingMutations += 1;
		try { return await this.#upstream.send(request.method, request.params); }
		finally {
			if (mutating) record.pendingMutations -= 1;
			this.#releaseController(record);
		}
	}

	#broadcast(event: GatewayEvent): void {
		if (event.method === "runtime.ready") this.#ready = event;
		for (const record of [...this.#clients.values()]) record.rpc.writeNotification(event);
	}

	#releaseController(record: ClientRecord): void {
		if (this.#controller === record && record.detached && record.pendingMutations === 0) {
			this.#controller = undefined;
		}
	}

	#detach(record: ClientRecord, drain: boolean): Promise<void> {
		if (record.closePromise) return record.closePromise;
		record.detached = true;
		this.#clients.delete(record.id);
		this.#releaseController(record);
		record.closePromise = Promise.resolve().then(async () => {
			try {
				if (!drain) record.rpc.dispose();
				await record.rpc.close();
			} finally { record.resolveCompletion(); }
		});
		this.#detaching.add(record.closePromise);
		void record.closePromise.then(
			() => this.#detaching.delete(record.closePromise!),
			() => this.#detaching.delete(record.closePromise!),
		);
		return record.closePromise;
	}
}

function mapFailure(request: NodeGatewayRpcRequest | null, error: unknown): NodeGatewayRpcFailure {
	if (!request) return { code: "invalid_params", message: "Invalid JSON-RPC request." };
	if (error instanceof BackendServiceError) {
		return { code: error.code, message: error.message, data: { dispatched: false } };
	}
	if (error instanceof GatewayRpcValidationError) return { code: error.code, message: "Invalid gateway payload." };
	if (error instanceof GatewayRequestError) return { code: error.code, message: error.message, data: error.data };
	return { code: "internal_error", message: "Backend service request failed." };
}

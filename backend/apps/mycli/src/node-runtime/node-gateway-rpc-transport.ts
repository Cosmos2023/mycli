import { PassThrough } from "node:stream";
import {
	parseJsonRpcMessage,
	isGatewayMethod,
	parseGatewayParams,
	parseGatewayResult,
	type GatewayEventNotification,
} from "@mycli/contracts";
import type { GatewayTransport } from "@mycli/gateway";
import {
	GatewayFrameReader, GatewayRequestBudget, GatewayWriteQueue, GatewayFlowControlError,
	gatewayLimits, gatewayOverloaded, type GatewayFlowControlLimits, type GatewayWriteCoalescing,
} from "@mycli/gateway/flow-control";
import { shellOutputCoalescing } from "./node-gateway-shell-output.ts";

type JsonObject = Record<string, unknown>;
type RpcId = string | number | null;

export interface NodeGatewayRpcRequest {
	readonly id: string | number;
	readonly method: string;
	readonly params: JsonObject;
}

export interface NodeGatewayRpcFailure {
	readonly code: string;
	readonly message: string;
	readonly data?: JsonObject;
}

interface NodeGatewayRpcTransportOptions {
	readonly projectResult?: (method: string, result: JsonObject) => JsonObject;
	readonly limits?: Partial<GatewayFlowControlLimits>;
	readonly dispatch: (request: NodeGatewayRpcRequest) => JsonObject | Promise<JsonObject>;
	readonly mapFailure: (request: NodeGatewayRpcRequest | null, error: unknown) => NodeGatewayRpcFailure;
	readonly onRequestFailed?: (
		request: NodeGatewayRpcRequest,
		failure: NodeGatewayRpcFailure,
	) => void;
	readonly shouldCloseAfterResponse?: (
		request: NodeGatewayRpcRequest,
		result: JsonObject,
	) => boolean;
	readonly close: () => void | Promise<void>;
}

export class NodeGatewayRpcTransport {
	readonly transport: GatewayTransport;
	readonly #options: NodeGatewayRpcTransportOptions;
	readonly #clientInput = new PassThrough();
	readonly #clientOutput = new PassThrough();
	readonly #lines: GatewayFrameReader;
	readonly #writer: GatewayWriteQueue;
	readonly #budget: GatewayRequestBudget;
	readonly #activeRequests = new Map<string, () => void>();
	#closed = false;
	#failed = false;
	#diagnostic = "";
	#closePromise: Promise<boolean> | undefined;

	constructor(options: NodeGatewayRpcTransportOptions) {
		this.#options = options;
		const limits = gatewayLimits(options.limits);
		this.#budget = new GatewayRequestBudget(limits);
		this.#writer = new GatewayWriteQueue(this.#clientInput, limits, (error) => this.#failConnection(error));
		this.transport = {
			input: this.#clientInput,
			output: this.#clientOutput,
			close: options.close,
			diagnostic: () => this.diagnostic(),
		};
		this.#lines = new GatewayFrameReader({
			input: this.#clientOutput,
			maxFrameBytes: limits.maxFrameBytes,
			onLine: (line, bytes) => this.#handleLine(line, bytes),
			onError: (error) => this.#failConnection(error),
			onClose: () => { void options.close(); },
		});
	}

	writeNotification(notification: GatewayEventNotification): void {
		this.#write(notification, shellOutputCoalescing(notification), true);
	}

	dispose(): void {
		this.#failConnection();
	}

	diagnostic(): string {
		return this.#diagnostic;
	}

	close(): Promise<boolean> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#lines.stop();
		for (const release of this.#activeRequests.values()) release();
		this.#activeRequests.clear();
		this.#clientOutput.end();
		this.#closePromise = this.#writer.end();
		return this.#closePromise;
	}

	#handleLine(line: string, bytes: number): void {
		if (this.#closed) return;
		let request: NodeGatewayRpcRequest;
		try {
			const parsed = parseJsonRpcMessage(JSON.parse(line) as unknown);
			if (!("id" in parsed) || !("method" in parsed) || typeof parsed.method !== "string") {
				return;
			}
			request = {
				id: parsed.id as string | number,
				method: parsed.method,
				params: isObject(parsed.params) ? parsed.params : {},
			};
		} catch (error) {
			const failure = this.#options.mapFailure(null, error);
			this.#writeError(null, failure);
			return;
		}
		const key = rpcKey(request.id);
		if (this.#activeRequests.has(key)) {
			this.#failConnection(new GatewayFlowControlError("invalid_request", "Duplicate pending gateway request id."));
			return;
		}
		const release = this.#budget.acquire(request.method, bytes + 1);
		if (!release) {
			const error = gatewayOverloaded();
			const mapped = this.#options.mapFailure(request, {
				code: error.code, message: error.message, data: { dispatched: false },
			});
			this.#writeError(request.id, {
				code: error.code, message: mapped.code === error.code ? mapped.message : error.message,
				data: { ...(mapped.code === error.code ? mapped.data : {}), dispatched: false },
			});
			return;
		}
		this.#activeRequests.set(key, release);
		try {
			if (isGatewayMethod(request.method)) parseGatewayParams(request.method, request.params);
			const result = this.#options.dispatch(request);
			if (result instanceof Promise) {
				void result.then(
					(value) => { this.#completeRequest(request, value); this.#releaseRequest(request); },
					(error: unknown) => { this.#failRequest(request, error); this.#releaseRequest(request); },
				);
			} else {
				this.#completeRequest(request, result);
				this.#releaseRequest(request);
			}
		} catch (error) {
			this.#failRequest(request, error);
			this.#releaseRequest(request);
		}
	}

	#completeRequest(request: NodeGatewayRpcRequest, result: JsonObject): void {
		if (this.#closed) return;
		try {
			const projected = this.#options.projectResult?.(request.method, result) ?? result;
			if (isGatewayMethod(request.method)) parseGatewayResult(request.method, projected);
			this.#write({ jsonrpc: "2.0", id: request.id, result: projected });
		} catch (error) {
			this.#failRequest(request, error);
			return;
		}
		if (this.#options.shouldCloseAfterResponse?.(request, result) === true) {
			queueMicrotask(() => { void this.#options.close(); });
		}
	}

	#failRequest(request: NodeGatewayRpcRequest, error: unknown): void {
		if (this.#closed) return;
		const failure = this.#options.mapFailure(request, error);
		this.#writeError(request.id, failure);
		this.#options.onRequestFailed?.(request, failure);
	}

	#writeError(id: RpcId, failure: NodeGatewayRpcFailure): void {
		this.#write({
			jsonrpc: "2.0",
			id,
			error: {
				code: failure.code,
				message: failure.message,
				...(failure.data && Object.keys(failure.data).length > 0
					? { data: failure.data }
					: {}),
			},
		});
	}

	#write(message: object, coalesce?: GatewayWriteCoalescing, batch = false): void {
		if (this.#closed) return;
		try { this.#writer.enqueue(`${JSON.stringify(message)}\n`, coalesce ? { coalesce } : batch ? { batch: true } : {}); }
		catch (error) {
			if (!(error instanceof GatewayFlowControlError)) throw error;
			this.#failConnection(error);
		}
	}

	#releaseRequest(request: NodeGatewayRpcRequest): void {
		const key = rpcKey(request.id);
		this.#activeRequests.get(key)?.();
		this.#activeRequests.delete(key);
	}

	#failConnection(error?: Error): void {
		if (this.#failed) return;
		this.#failed = true;
		this.#diagnostic = error instanceof GatewayFlowControlError ? error.code : "node_backend_transport_failed";
		this.#writer.dispose();
		this.#clientInput.destroy();
		this.#clientOutput.destroy();
		void this.close();
		void this.#options.close();
	}
}

function rpcKey(id: RpcId): string {
	return `${typeof id}:${String(id)}`;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

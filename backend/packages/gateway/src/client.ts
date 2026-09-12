import {
	GatewayFrameReader, GatewayRequestBudget, GatewayWriteQueue, GatewayFlowControlError,
	gatewayLimits, gatewayOverloaded, isGatewayControlMethod, type GatewayFlowControlLimits,
} from "./flow-control/index.ts";
import {
	ContractValidationError,
	parseGatewayEvent,
	parseJsonRpcMessage,
	isGatewayMethod,
	parseGatewayParams,
	parseGatewayResult,
	projectGatewayErrorData,
	type GatewayMethod,
	type GatewayParams,
	type GatewayResult,
	type GatewayEventNotification,
	type JsonRpcMessage,
} from "@mycli/contracts";

export type JsonObject = Record<string, unknown>;

type RpcRequest = {
	jsonrpc: "2.0";
	id: string;
	method: string;
	params: JsonObject;
};

export type RpcMessage = JsonRpcMessage;

export type GatewayEvent = GatewayEventNotification;

type PendingRequest = {
	method: string;
	resolve: (value: JsonObject) => void;
	reject: (error: Error) => void;
	release: () => void;
	timer: NodeJS.Timeout;
};

type PendingEvent = {
	method: string;
	matches: (event: GatewayEvent) => boolean;
	resolve: (event: GatewayEvent) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

const DEFAULT_EVENT_REPLAY_LIMIT = 256;
const DEFAULT_EVENT_REPLAY_BYTES = 8 * 1024 * 1024;
const DEFAULT_EVENT_WAITER_LIMIT = 256;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function request(id: string, method: string, params: JsonObject = {}): RpcRequest {
	return { jsonrpc: "2.0", id, method, params };
}

function encodeMessage(message: RpcMessage): string {
	return `${JSON.stringify(message)}\n`;
}

function decodeMessage(line: string): RpcMessage {
	const value: unknown = JSON.parse(line);
	const message = parseJsonRpcMessage(value);
	if ("method" in message && !("id" in message)) {
		return parseGatewayEvent(message);
	}
	return message;
}

export class GatewayRequestError extends Error {
	readonly code: string;
	readonly method: string;
	readonly data: JsonObject;

	constructor({
		code,
		message,
		method,
		data = {},
	}: {
		code: string;
		message: string;
		method: string;
		data?: JsonObject;
	}) {
		super(message);
		this.name = "GatewayRequestError";
		this.code = code;
		this.method = method;
		this.data = projectGatewayErrorData(data, "read") as JsonObject;
	}
}

export class GatewayClient {
	private nextId = 1;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly pendingEvents: PendingEvent[] = [];
	private readonly events: { event: GatewayEvent; bytes: number }[] = [];
	private readonly eventReplayLimit: number;
	private readonly limits: GatewayFlowControlLimits;
	private readonly budget: GatewayRequestBudget;
	private readonly writer: GatewayWriteQueue;
	private readonly eventReplayBytes: number;
	private readonly eventWaiterLimit: number;
	private readonly requestTimeoutMs: number;
	private replayBytes = 0;
	private reader: GatewayFrameReader | null = null;
	private closed = false;
	private closeExpected = false;
	private readonly aborted = (): void => {
		const reason: unknown = this.options.signal?.reason;
		this.closeFromError(reason instanceof Error ? reason : new Error("Gateway aborted."));
	};

	constructor(
		private readonly options: {
			input: NodeJS.ReadableStream;
			output: NodeJS.WritableStream;
			log?: (event: GatewayEvent) => void;
			onClose?: (error: Error) => void;
			eventReplayLimit?: number;
			eventReplayBytes?: number;
			eventWaiterLimit?: number;
			requestTimeoutMs?: number;
			limits?: Partial<GatewayFlowControlLimits>;
			signal?: AbortSignal;
		},
	) {
		const replayLimit = options.eventReplayLimit ?? DEFAULT_EVENT_REPLAY_LIMIT;
		this.eventReplayLimit = Number.isSafeInteger(replayLimit) && replayLimit >= 0
			? replayLimit
			: DEFAULT_EVENT_REPLAY_LIMIT;
		this.eventReplayBytes = nonNegativeLimit(options.eventReplayBytes, DEFAULT_EVENT_REPLAY_BYTES);
		this.eventWaiterLimit = nonNegativeLimit(options.eventWaiterLimit, DEFAULT_EVENT_WAITER_LIMIT);
		this.requestTimeoutMs = nonNegativeLimit(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
		if (this.requestTimeoutMs === 0 || this.requestTimeoutMs > 2_147_483_647) {
			throw new RangeError("Invalid gateway request timeout.");
		}
		this.limits = gatewayLimits(options.limits);
		this.budget = new GatewayRequestBudget(this.limits);
		this.writer = new GatewayWriteQueue(options.output, this.limits, (error) => this.closeFromError(error));
	}

	start(): void {
		if (this.closed || this.reader) return;
		this.options.signal?.addEventListener("abort", this.aborted, { once: true });
		this.reader = new GatewayFrameReader({
			input: this.options.input,
			maxFrameBytes: this.limits.maxFrameBytes,
			onLine: (line, bytes) => this.handleLine(line, bytes),
			onError: (error) => this.closeFromError(error),
			onClose: () => this.closeFromError(new Error("Gateway input closed.")),
		});
		if (this.options.signal?.aborted) this.aborted();
	}

	stop(): void {
		this.closed = true;
		this.detach();
		this.rejectAll(new Error("Gateway closed."));
	}

	expectClose(): void {
		this.closeExpected = true;
	}

	async request<M extends GatewayMethod>(method: M, params: GatewayParams<M>): Promise<GatewayResult<M>> {
		parseGatewayParams(method, params);
		return parseGatewayResult(method, await this.send(method, { ...params }));
	}

	send(method: string, params: JsonObject = {}): Promise<JsonObject> {
		const id = String(this.nextId++);
		return new Promise((resolve, reject) => {
			if (this.closed || (this.options.output as { destroyed?: boolean }).destroyed) {
				reject(new GatewayRequestError({ code: "pipe_closed", message: "Gateway output closed.", method }));
				return;
			}
			let release: (() => void) | undefined;
			try {
				const frame = encodeMessage(request(id, method, params));
				if (Buffer.byteLength(frame) > this.limits.maxFrameBytes + 1) {
					throw new GatewayFlowControlError("gateway_message_too_large", "Gateway message exceeds the size limit.");
				}
				release = this.budget.acquire(method, Buffer.byteLength(frame));
				if (!release) throw gatewayOverloaded();
				const timer = setTimeout(() => {
					this.closeFromError(new GatewayRequestError({
						code: "gateway_request_timeout", message: "Gateway request timed out; its outcome is unknown.", method,
					}));
				}, this.requestTimeoutMs);
				timer.unref();
				this.pending.set(id, { method, resolve, reject, release, timer });
				this.writer.enqueue(frame, { control: isGatewayControlMethod(method) });
			} catch (error) {
				clearTimeout(this.pending.get(id)?.timer);
				this.pending.delete(id);
				release?.();
				reject(error instanceof GatewayFlowControlError
					? new GatewayRequestError({ code: error.code, message: error.message, method, data: { dispatched: false } })
					: new GatewayRequestError({ code: "invalid_params", message: "Unable to encode gateway request.", method }));
			}
		});
	}

	waitForEvent(
		method: string,
		matches: (event: GatewayEvent) => boolean = () => true,
		timeoutMs = 10000,
	): Promise<GatewayEvent> {
		const existingIndex = this.events.findIndex(
			({ event }) => event.method === method && matches(event),
		);
		if (existingIndex >= 0) {
			const entry = this.events.splice(existingIndex, 1)[0]!;
			this.replayBytes -= entry.bytes;
			return Promise.resolve(entry.event);
		}
		if (this.closed) return Promise.reject(new Error("Gateway closed."));
		if (this.pendingEvents.length >= this.eventWaiterLimit) return Promise.reject(gatewayOverloaded());
		return new Promise((resolve, reject) => {
			const pending: PendingEvent = {
				method,
				matches,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.removePendingEvent(pending);
					reject(new Error(`Timed out waiting for ${method}.`));
				}, timeoutMs),
			};
			this.pendingEvents.push(pending);
		});
	}

	private handleLine(line: string, bytes: number): void {
		if (this.closed) {
			return;
		}
		let message: RpcMessage;
		try {
			message = decodeMessage(line);
		} catch (error) {
			if (error instanceof ContractValidationError) {
				this.closeFromError(error);
				return;
			}
			if (error instanceof SyntaxError) {
				this.closeFromError(new ContractValidationError("Invalid JSON-RPC message."));
				return;
			}
			throw error;
		}
		if ("id" in message && !("method" in message) && this.pending.has(String(message.id))) {
			const pending = this.pending.get(String(message.id));
			this.pending.delete(String(message.id));
			if (!pending) {
				return;
			}
			clearTimeout(pending.timer);
			pending.release();
			if ("error" in message && message.error) {
				pending.reject(
					new GatewayRequestError({
						code: message.error.code,
						message: message.error.message,
						method: pending.method,
						data: message.error.data ?? {},
					}),
				);
				return;
			}
			try {
				const result = ("result" in message && message.result) || {};
				pending.resolve(isGatewayMethod(pending.method) ? parseGatewayResult(pending.method, result) : result);
			} catch (error) {
				const failure = error instanceof Error ? error : new Error("Invalid gateway result.");
				pending.reject(failure);
				this.closeFromError(failure);
			}
			return;
		}
		if ("method" in message && !("id" in message)) {
			const event = message as GatewayEvent;
			try { this.options.log?.(event); }
			catch (error) {
				this.closeFromError(error instanceof Error ? error : new Error("Gateway event handler failed."));
				return;
			}
			if (this.closed) return;
			if (!this.resolvePendingEvents(event)) {
				this.rememberEvent(event, bytes);
			}
		}
	}

	private rememberEvent(event: GatewayEvent, bytes: number): void {
		if (this.eventReplayLimit === 0 || bytes > this.eventReplayBytes) return;
		this.events.push({ event, bytes });
		this.replayBytes += bytes;
		while (this.events.length > this.eventReplayLimit || this.replayBytes > this.eventReplayBytes) {
			this.replayBytes -= this.events.shift()!.bytes;
		}
	}

	private resolvePendingEvents(event: GatewayEvent): boolean {
		let matched = false;
		for (const pending of [...this.pendingEvents]) {
			if (pending.method !== event.method || !pending.matches(event)) {
				continue;
			}
			matched = true;
			this.removePendingEvent(pending);
			pending.resolve(event);
		}
		return matched;
	}

	private removePendingEvent(pending: PendingEvent): void {
		const index = this.pendingEvents.indexOf(pending);
		if (index >= 0) {
			this.pendingEvents.splice(index, 1);
		}
		clearTimeout(pending.timer);
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.release();
			pending.reject(error);
		}
		this.pending.clear();
		for (const pending of this.pendingEvents) {
			pending.reject(error);
			clearTimeout(pending.timer);
		}
		this.pendingEvents.length = 0;
		this.events.length = 0;
		this.replayBytes = 0;
	}

	private closeFromError(error: Error): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.detach();
		this.rejectAll(error);
		const input = this.options.input as NodeJS.ReadableStream & { destroy?: () => void };
		input.destroy?.();
		if (!this.closeExpected) {
			this.options.onClose?.(error);
		}
	}

	private detach(): void {
		this.reader?.stop();
		this.reader = null;
		this.writer.dispose();
		this.options.signal?.removeEventListener("abort", this.aborted);
	}
}

function nonNegativeLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid gateway client limit.");
	return value;
}

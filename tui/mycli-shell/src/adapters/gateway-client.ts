import { createInterface, type Interface } from "node:readline";

export type JsonObject = Record<string, unknown>;

type RpcRequest = {
	jsonrpc: "2.0";
	id: string;
	method: string;
	params: JsonObject;
};

type RpcResponse = {
	jsonrpc: "2.0";
	id: string;
	result?: JsonObject;
	error?: { code: string; message: string; data?: JsonObject };
};

type RpcNotification = {
	jsonrpc: "2.0";
	method: string;
	params: JsonObject;
};

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export type GatewayEvent = RpcNotification;

type PendingRequest = {
	method: string;
	resolve: (value: JsonObject) => void;
	reject: (error: Error) => void;
};

type PendingEvent = {
	method: string;
	matches: (event: GatewayEvent) => boolean;
	resolve: (event: GatewayEvent) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

function request(id: string, method: string, params: JsonObject = {}): RpcRequest {
	return { jsonrpc: "2.0", id, method, params };
}

function encodeMessage(message: RpcMessage): string {
	return `${JSON.stringify(message)}\n`;
}

function decodeMessage(line: string): RpcMessage {
	const message = JSON.parse(line) as RpcMessage;
	if (message.jsonrpc !== "2.0") {
		throw new Error("Unsupported JSON-RPC version");
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
		this.data = data;
	}
}

export class GatewayClient {
	private nextId = 1;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly pendingEvents: PendingEvent[] = [];
	private readonly events: GatewayEvent[] = [];
	private readline: Interface | null = null;
	private closed = false;

	constructor(
		private readonly options: {
			input: NodeJS.ReadableStream;
			output: NodeJS.WritableStream;
			log?: (event: GatewayEvent) => void;
		},
	) {}

	start(): void {
		this.options.output.on?.("error", (error) => {
			this.closeFromError(error instanceof Error ? error : new Error("Gateway output closed."));
		});
		this.options.input.on?.("error", (error) => {
			this.closeFromError(error instanceof Error ? error : new Error("Gateway input closed."));
		});
		this.readline = createInterface({ input: this.options.input, crlfDelay: Infinity });
		this.readline.on("line", (line) => this.handleLine(line));
		this.readline.on("error", (error) => {
			this.closeFromError(error instanceof Error ? error : new Error("Gateway input closed."));
		});
		this.readline.on("close", () => {
			this.closeFromError(new Error("Gateway input closed."));
		});
	}

	stop(): void {
		this.closed = true;
		this.readline?.close();
		this.readline = null;
		this.rejectAll(new Error("Gateway closed."));
	}

	send(method: string, params: JsonObject = {}): Promise<JsonObject> {
		const id = String(this.nextId++);
		return new Promise((resolve, reject) => {
			if (this.closed || (this.options.output as { destroyed?: boolean }).destroyed) {
				reject(new GatewayRequestError({ code: "pipe_closed", message: "Gateway output closed.", method }));
				return;
			}
			this.pending.set(id, { method, resolve, reject });
			let ok = false;
			try {
				ok = this.options.output.write(encodeMessage(request(id, method, params)));
			} catch (error) {
				this.pending.delete(id);
				this.closeFromError(error instanceof Error ? error : new Error("Gateway output closed."));
				reject(new GatewayRequestError({ code: "pipe_closed", message: "Gateway output closed.", method }));
				return;
			}
			if (!ok && (this.options.output as { destroyed?: boolean }).destroyed) {
				this.pending.delete(id);
				this.closeFromError(new Error("Gateway output closed."));
				reject(new GatewayRequestError({ code: "pipe_closed", message: "Gateway output closed.", method }));
			}
		});
	}

	waitForEvent(
		method: string,
		matches: (event: GatewayEvent) => boolean = () => true,
		timeoutMs = 10000,
	): Promise<GatewayEvent> {
		const existing = this.events.find((event) => event.method === method && matches(event));
		if (existing) {
			return Promise.resolve(existing);
		}
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

	private handleLine(line: string): void {
		if (this.closed) {
			return;
		}
		const message = decodeMessage(line);
		if ("id" in message && this.pending.has(String(message.id))) {
			const pending = this.pending.get(String(message.id));
			this.pending.delete(String(message.id));
			if (!pending) {
				return;
			}
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
			pending.resolve(("result" in message && message.result) || {});
			return;
		}
		if ("method" in message) {
			this.events.push(message);
			this.options.log?.(message);
			this.resolvePendingEvents(message);
		}
	}

	private resolvePendingEvents(event: GatewayEvent): void {
		for (const pending of [...this.pendingEvents]) {
			if (pending.method !== event.method || !pending.matches(event)) {
				continue;
			}
			this.removePendingEvent(pending);
			pending.resolve(event);
		}
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
			pending.reject(error);
		}
		this.pending.clear();
		for (const pending of this.pendingEvents) {
			pending.reject(error);
			clearTimeout(pending.timer);
		}
		this.pendingEvents.length = 0;
	}

	private closeFromError(error: Error): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.rejectAll(error);
		this.readline?.close();
		this.readline = null;
	}
}

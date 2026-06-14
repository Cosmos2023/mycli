import { createInterface, type Interface } from "node:readline";

export type JsonObject = Record<string, unknown>;

export type RpcRequest = {
	jsonrpc: "2.0";
	id: string;
	method: string;
	params: JsonObject;
};

export type RpcResponse = {
	jsonrpc: "2.0";
	id: string;
	result?: JsonObject;
	error?: { code: string; message: string };
};

export type RpcNotification = {
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

export function request(id: string, method: string, params: JsonObject = {}): RpcRequest {
	return { jsonrpc: "2.0", id, method, params };
}

export function encodeMessage(message: RpcMessage): string {
	return `${JSON.stringify(message)}\n`;
}

export function decodeMessage(line: string): RpcMessage {
	const message = JSON.parse(line) as RpcMessage;
	if (message.jsonrpc !== "2.0") {
		throw new Error("Unsupported JSON-RPC version");
	}
	return message;
}

export class GatewayRequestError extends Error {
	readonly code: string;
	readonly method: string;

	constructor({ code, message, method }: { code: string; message: string; method: string }) {
		super(message);
		this.name = "GatewayRequestError";
		this.code = code;
		this.method = method;
	}
}

export class GatewayClient {
	private nextId = 1;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly pendingEvents: PendingEvent[] = [];
	private readonly events: GatewayEvent[] = [];
	private readline: Interface | null = null;

	constructor(
		private readonly options: {
			input: NodeJS.ReadableStream;
			output: NodeJS.WritableStream;
			log?: (event: GatewayEvent) => void;
		},
	) {}

	start(): void {
		this.readline = createInterface({ input: this.options.input, crlfDelay: Infinity });
		this.readline.on("line", (line) => this.handleLine(line));
	}

	stop(): void {
		this.readline?.close();
		this.readline = null;
	}

	send(method: string, params: JsonObject = {}): Promise<JsonObject> {
		const id = String(this.nextId++);
		return new Promise((resolve, reject) => {
			this.pending.set(id, { method, resolve, reject });
			this.options.output.write(encodeMessage(request(id, method, params)));
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
}

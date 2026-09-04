import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { PassThrough } from "node:stream";
import {
	parseJsonRpcMessage,
	type GatewayEventNotification,
} from "@mycli/contracts";
import type { GatewayTransport } from "mycli-shell-tui/gateway-transport";

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

export interface NodeGatewayRpcTransportOptions {
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
	readonly #lines: ReadLineInterface;
	#closed = false;

	constructor(options: NodeGatewayRpcTransportOptions) {
		this.#options = options;
		this.transport = {
			input: this.#clientInput,
			output: this.#clientOutput,
			close: options.close,
		};
		this.#lines = createInterface({ input: this.#clientOutput, crlfDelay: Infinity });
		this.#lines.on("line", (line) => { this.#handleLine(line); });
		this.#lines.on("error", () => { void options.close(); });
		this.#clientOutput.on("error", () => { void options.close(); });
	}

	writeNotification(notification: GatewayEventNotification): void {
		this.#write(notification);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#lines.close();
		this.#clientInput.end();
		this.#clientOutput.end();
	}

	#handleLine(line: string): void {
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
		try {
			const result = this.#options.dispatch(request);
			if (result instanceof Promise) {
				void result.then(
					(value) => { this.#completeRequest(request, value); },
					(error: unknown) => { this.#failRequest(request, error); },
				);
			} else {
				this.#completeRequest(request, result);
			}
		} catch (error) {
			this.#failRequest(request, error);
		}
	}

	#completeRequest(request: NodeGatewayRpcRequest, result: JsonObject): void {
		this.#write({ jsonrpc: "2.0", id: request.id, result });
		if (this.#options.shouldCloseAfterResponse?.(request, result) === true) {
			queueMicrotask(() => { void this.#options.close(); });
		}
	}

	#failRequest(request: NodeGatewayRpcRequest, error: unknown): void {
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

	#write(message: object): void {
		if (!this.#closed) this.#clientInput.write(`${JSON.stringify(message)}\n`);
	}
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

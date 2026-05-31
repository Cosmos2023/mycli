import { createInterface, type Interface } from "node:readline";
import type {
  GatewayClientOptions,
  GatewayEvent,
  GatewayEventForMethod,
  JsonObject,
  RpcMessage,
  RpcRequest,
} from "./types.ts";

type PendingRequest = {
  method: string;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
};

type EventWaiter = {
  method: string;
  predicate: (event: GatewayEvent) => boolean;
  resolve: (event: GatewayEvent) => void;
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
  private pending = new Map<string, PendingRequest>();
  private eventWaiters: EventWaiter[] = [];
  private events: GatewayEvent[] = [];
  private readline: Interface | null = null;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly log: (event: GatewayEvent) => void;

  constructor({ input, output, log = () => undefined }: GatewayClientOptions) {
    this.input = input;
    this.output = output;
    this.log = log;
  }

  start(): void {
    this.readline = createInterface({ input: this.input, crlfDelay: Infinity });
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
      this.output.write(encodeMessage(request(id, method, params)));
    });
  }

  waitForEvent<Method extends string>(
    method: Method,
    predicate: (event: GatewayEventForMethod<Method>) => boolean = () => true,
  ): Promise<GatewayEventForMethod<Method>> {
    const matches = (event: GatewayEvent): event is GatewayEventForMethod<Method> =>
      event.method === method && predicate(event as GatewayEventForMethod<Method>);
    const existing = this.events.find(matches);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) =>
      this.eventWaiters.push({
        method,
        predicate: (event) => predicate(event as GatewayEventForMethod<Method>),
        resolve: (event) => resolve(event as GatewayEventForMethod<Method>),
      }),
    );
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
      } else {
        pending.resolve(("result" in message && message.result) || {});
      }
      return;
    }
    if ("method" in message) {
      this.events.push(message);
      this.log(message);
      this.resolveEventWaiters(message);
    }
  }

  private resolveEventWaiters(event: GatewayEvent): void {
    const remaining: EventWaiter[] = [];
    for (const waiter of this.eventWaiters) {
      if (event.method === waiter.method && waiter.predicate(event)) {
        waiter.resolve(event);
      } else {
        remaining.push(waiter);
      }
    }
    this.eventWaiters = remaining;
  }
}

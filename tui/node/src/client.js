import { createInterface } from "node:readline";
import { decodeMessage, encodeMessage, request } from "./protocol.js";

export class GatewayClient {
  constructor({ input, output, log = () => {} }) {
    this.input = input;
    this.output = output;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = [];
    this.events = [];
  }

  start() {
    const rl = createInterface({ input: this.input, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));
  }

  send(method, params = {}) {
    const id = String(this.nextId++);
    this.output.write(encodeMessage(request(id, method, params)));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  handleLine(line) {
    const message = decodeMessage(line);
    if (message.id && this.pending.has(String(message.id))) {
      const pending = this.pending.get(String(message.id));
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      this.events.push(message);
      this.log(message);
      this.resolveEventWaiters(message);
    }
  }

  waitForEvent(method, predicate = () => true) {
    for (const event of this.events) {
      if (event.method === method && predicate(event)) {
        return Promise.resolve(event);
      }
    }
    return new Promise((resolve) => {
      this.eventWaiters.push({ method, predicate, resolve });
    });
  }

  resolveEventWaiters(event) {
    const remaining = [];
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

import type { Socket } from "node:net";
import { NetworkProxyError } from "./proxy-protocol.ts";

/** Bounded handshake reader; relinquishes the paused socket and unconsumed payload. */
export class ProxySocketReader {
	#buffer: Buffer = Buffer.alloc(0);
	#error?: Error;
	#wake?: () => void;
	readonly #socket: Socket;
	readonly #signal: AbortSignal;
	readonly #maximum: number;

	constructor(socket: Socket, signal: AbortSignal, maximum = 65_536) {
		this.#socket = socket;
		this.#signal = signal;
		this.#maximum = maximum;
		socket.on("data", this.#data);
		socket.on("error", this.#failed);
		socket.on("end", this.#ended);
		socket.on("close", this.#ended);
		signal.addEventListener("abort", this.#ended, { once: true });
		socket.resume();
	}

	readonly #data = (chunk: Buffer): void => {
		if (this.#buffer.length + chunk.length > this.#maximum) {
			this.#error = new NetworkProxyError(400, "Proxy handshake exceeds its limit.");
			this.#socket.pause();
		} else this.#buffer = Buffer.concat([this.#buffer, chunk]);
		this.#wake?.();
	};
	readonly #failed = (): void => { this.#ended(); };
	readonly #ended = (): void => {
		this.#error = new NetworkProxyError(502, "Proxy connection closed during setup.");
		this.#wake?.();
	};

	async read(size: number): Promise<Buffer> {
		while (this.#buffer.length < size) await this.#wait();
		this.#check();
		const result = this.#buffer.subarray(0, size);
		this.#buffer = this.#buffer.subarray(size);
		return result;
	}

	async headers(): Promise<Buffer> {
		for (;;) {
			this.#check();
			const index = this.#buffer.indexOf("\r\n\r\n");
			if (index >= 0 && index + 4 <= 16_384) return this.read(index + 4);
			if (this.#buffer.length >= 16_384) throw new NetworkProxyError(502, "Upstream proxy headers exceed their limit.");
			await this.#wait();
		}
	}

	finish(): Buffer {
		this.#socket.pause();
		this.#socket.removeListener("data", this.#data);
		this.#socket.removeListener("error", this.#failed);
		this.#socket.removeListener("end", this.#ended);
		this.#socket.removeListener("close", this.#ended);
		this.#signal.removeEventListener("abort", this.#ended);
		return this.#buffer;
	}

	#check(): void {
		if (this.#error) throw this.#error;
		if (this.#signal.aborted || this.#socket.destroyed) throw new NetworkProxyError(502, "Proxy connection setup was cancelled.");
	}

	async #wait(): Promise<void> {
		this.#check();
		await new Promise<void>((resolve) => { this.#wake = resolve; });
		this.#wake = undefined;
		this.#check();
	}
}

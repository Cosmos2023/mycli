import { GatewayFlowControlError } from "./limits.ts";

export class GatewayFrameDecoder {
	#buffer: Buffer = Buffer.alloc(0);
	#length = 0;
	#closed = false;

	constructor(
		private readonly maxBytes: number,
		private readonly onLine: (line: string, bytes: number) => void,
	) {}

	push(chunk: Buffer | string): void {
		const input = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		let offset = 0;
		while (offset < input.length && !this.#closed) {
			const newline = input.indexOf(10, offset);
			const end = newline < 0 ? input.length : newline;
			this.#append(input.subarray(offset, end));
			if (newline < 0) return;
			this.#emit();
			offset = newline + 1;
		}
	}

	end(): void {
		if (!this.#closed && this.#length > 0) this.#emit();
		this.close();
	}

	close(): void {
		this.#closed = true;
		this.#buffer = Buffer.alloc(0);
		this.#length = 0;
	}

	#append(chunk: Buffer): void {
		const length = this.#length + chunk.length;
		if (length > this.maxBytes) {
			this.close();
			throw new GatewayFlowControlError("gateway_message_too_large", "Gateway message exceeds the size limit.");
		}
		if (length > this.#buffer.length) {
			const buffer = Buffer.allocUnsafe(Math.min(this.maxBytes, Math.max(length, this.#buffer.length * 2, 4096)));
			this.#buffer.copy(buffer, 0, 0, this.#length);
			this.#buffer = buffer;
		}
		chunk.copy(this.#buffer, this.#length);
		this.#length = length;
	}

	#emit(): void {
		const bytes = this.#length;
		const end = this.#buffer[bytes - 1] === 13 ? bytes - 1 : bytes;
		const line = this.#buffer.toString("utf8", 0, end);
		this.#length = 0;
		this.onLine(line, bytes);
	}
}

export class GatewayFrameReader {
	readonly #decoder: GatewayFrameDecoder;
	#stopped = false;
	readonly #data = (chunk: Buffer | string): void => {
		try { this.#decoder.push(chunk); }
		catch (error) { this.#fail(error); }
	};
	readonly #end = (): void => {
		try { this.#decoder.end(); }
		catch (error) { this.#fail(error); return; }
		this.#close();
	};
	readonly #close = (): void => {
		if (this.#stopped) return;
		this.stop();
		this.options.onClose?.();
	};
	readonly #fail = (error: unknown): void => {
		if (this.#stopped) return;
		this.stop();
		this.options.onError(error instanceof Error ? error : new Error("Gateway input failed."));
	};

	constructor(private readonly options: {
		readonly input: NodeJS.ReadableStream;
		readonly maxFrameBytes: number;
		readonly onLine: (line: string, bytes: number) => void;
		readonly onError: (error: Error) => void;
		readonly onClose?: () => void;
	}) {
		this.#decoder = new GatewayFrameDecoder(options.maxFrameBytes, options.onLine);
		options.input.on("error", this.#fail);
		options.input.on("end", this.#end);
		options.input.on("close", this.#close);
		options.input.on("data", this.#data);
		const state = options.input as { readableEnded?: boolean; destroyed?: boolean };
		if (state.readableEnded || state.destroyed) queueMicrotask(this.#close);
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#decoder.close();
		this.options.input.off("data", this.#data);
		this.options.input.off("end", this.#end);
		this.options.input.off("close", this.#close);
		this.options.input.off("error", this.#fail);
		this.options.input.pause();
	}
}

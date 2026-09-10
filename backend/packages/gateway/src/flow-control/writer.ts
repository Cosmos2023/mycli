import { GatewayFlowControlError, gatewayOverloaded, type GatewayFlowControlLimits } from "./limits.ts";

interface PendingWrite {
	readonly frame: string;
	readonly bytes: number;
	readonly onWritten?: () => void;
	readonly coalesceKey?: string;
	readonly batch?: true;
}

export interface GatewayWriteCoalescing {
	readonly key: string;
	readonly merge: (previousFrame: string, nextFrame: string) => string;
}

type GatewayWriteOptions = { readonly control?: boolean } & (
	| { readonly onWritten?: () => void; readonly coalesce?: never; readonly batch?: never }
	| { readonly coalesce: GatewayWriteCoalescing; readonly onWritten?: never; readonly batch?: never }
	| { readonly batch: true; readonly onWritten?: never; readonly coalesce?: never }
);

const MAX_BATCH_BYTES = 64 * 1024;

export class GatewayWriteQueue {
	readonly #queue: PendingWrite[] = [];
	readonly #pending = new Set<PendingWrite>();
	readonly #coalesced = new Map<string, PendingWrite>();
	#bytes = 0;
	#blocked = false;
	#closed = false;
	#ending = false;
	#pumping = false;
	#finishing = false;
	#timer: NodeJS.Timeout | undefined;
	#batchPump: NodeJS.Immediate | undefined;
	#endPromise: Promise<boolean> | undefined;
	#resolveEnd: ((drained: boolean) => void) | undefined;
	readonly #drain = (): void => { this.#blocked = false; this.#pump(); };
	readonly #error = (error?: Error): void => {
		this.#fail(error ?? new GatewayFlowControlError("pipe_closed", "Gateway output closed."));
	};

	constructor(
		private readonly output: NodeJS.WritableStream,
		private readonly limits: GatewayFlowControlLimits,
		private readonly onFailure: (error: Error) => void,
	) {
		output.on("drain", this.#drain);
		output.on("error", this.#error);
		output.on("close", this.#error);
	}

	enqueue(frame: string, options: GatewayWriteOptions = {}): void {
		const state = this.output as { destroyed?: boolean; writableEnded?: boolean };
		if (this.#closed || this.#ending || state.destroyed || state.writableEnded) {
			throw new GatewayFlowControlError("pipe_closed", "Gateway output closed.");
		}
		const frameBytes = Buffer.byteLength(frame);
		if (frameBytes > this.limits.maxFrameBytes + 1) {
			throw new GatewayFlowControlError("gateway_message_too_large", "Gateway message exceeds the size limit.");
		}
		const tail = this.#queue.at(-1);
		let previous: PendingWrite | undefined;
		if (options.coalesce) previous = this.#coalesced.get(options.coalesce.key);
		else if (options.batch && tail?.batch
			&& tail.bytes + frameBytes <= Math.min(MAX_BATCH_BYTES, this.limits.maxFrameBytes + 1)) previous = tail;
		let nextFrame = frame;
		if (previous) nextFrame = options.coalesce ? options.coalesce.merge(previous.frame, frame) : previous.frame + frame;
		const bytes = Buffer.byteLength(nextFrame);
		if (bytes > this.limits.maxFrameBytes + 1) {
			throw new GatewayFlowControlError("gateway_message_too_large", "Gateway message exceeds the size limit.");
		}
		const maxCount = this.limits.maxQueuedMessages + (options.control ? this.limits.controlReserveRequests : 0);
		const maxBytes = this.limits.maxQueuedBytes + (options.control ? this.limits.controlReserveBytes : 0);
		if (this.#pending.size - (previous ? 1 : 0) >= maxCount
			|| this.#bytes - (previous?.bytes ?? 0) + bytes > maxBytes) throw gatewayOverloaded();
		if (previous) {
			// Move the replacement to the tail so newer sequence numbers never overtake other events.
			this.#queue.splice(this.#queue.indexOf(previous), 1);
			this.#pending.delete(previous);
			this.#bytes -= previous.bytes;
		}
		const pending: PendingWrite = {
			frame: nextFrame, bytes,
			...(options.onWritten ? { onWritten: options.onWritten } : {}),
			...(options.coalesce ? { coalesceKey: options.coalesce.key } : {}),
			...(options.batch ? { batch: true as const } : {}),
		};
		if (options.coalesce) this.#coalesced.set(options.coalesce.key, pending);
		this.#pending.add(pending);
		this.#bytes += bytes;
		this.#queue.push(pending);
		this.#armTimer();
		if (options.batch) {
			// Batch one event-loop turn without changing any frame or its delivery order.
			this.#batchPump ??= setImmediate(() => this.#pump());
		} else {
			this.#pump();
		}
	}

	end(): Promise<boolean> {
		if (this.#endPromise) return this.#endPromise;
		if (this.#closed) return Promise.resolve(false);
		this.#ending = true;
		this.#endPromise = new Promise((resolve) => { this.#resolveEnd = resolve; });
		this.#pump();
		this.#finishIfDrained();
		return this.#endPromise;
	}

	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		clearImmediate(this.#batchPump);
		this.#batchPump = undefined;
		this.#queue.length = 0;
		this.#pending.clear();
		this.#coalesced.clear();
		this.#bytes = 0;
		this.output.off("drain", this.#drain);
		this.output.off("error", this.#error);
		this.output.off("close", this.#error);
		this.#resolveEnd?.(false);
	}

	#pump(): void {
		clearImmediate(this.#batchPump);
		this.#batchPump = undefined;
		if (this.#pumping || this.#closed) return;
		this.#pumping = true;
		try {
			while (!this.#blocked && !this.#closed && this.#queue.length > 0) {
				const pending = this.#queue.shift()!;
				if (pending.coalesceKey !== undefined) this.#coalesced.delete(pending.coalesceKey);
				this.#blocked = !this.output.write(pending.frame, (error?: Error | null) => {
					if (this.#closed) return;
					// A Writable emits its error after the callback; retain the listener until then.
					if (error) return;
					this.#pending.delete(pending);
					this.#bytes -= pending.bytes;
					clearTimeout(this.#timer);
					this.#timer = undefined;
					this.#armTimer();
					pending.onWritten?.();
					this.#finishIfDrained();
				});
			}
		} catch (error) {
			this.#error(error instanceof Error ? error : undefined);
		} finally {
			this.#pumping = false;
		}
	}

	#armTimer(): void {
		if (this.#timer || (this.#pending.size === 0 && !this.#finishing)) return;
		this.#timer = setTimeout(() => {
			this.#fail(new GatewayFlowControlError("gateway_output_stalled", "Gateway output stopped draining."));
		}, this.limits.writeStallTimeoutMs);
		this.#timer.unref();
	}

	#finishIfDrained(): void {
		if (!this.#ending || this.#pending.size > 0 || this.#closed || this.#finishing) return;
		this.#finishing = true;
		this.#armTimer();
		try {
			this.output.end(() => {
				if (this.#closed) return;
				this.#resolveEnd?.(true);
				this.dispose();
			});
		} catch (error) { this.#error(error instanceof Error ? error : undefined); }
	}

	#fail(error: Error): void {
		if (this.#closed) return;
		this.dispose();
		this.onFailure(error);
	}
}

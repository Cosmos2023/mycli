import { performance } from "node:perf_hooks";

export interface FrameSchedulerClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(timer: unknown): void;
}

export interface FrameSchedulerOptions {
	minIntervalMs: number;
	isBlocked?: () => boolean;
	clock?: FrameSchedulerClock;
}

const SYSTEM_CLOCK: FrameSchedulerClock = {
	now: () => performance.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Coalesces event-driven redraw requests and enforces a maximum frame rate. */
export class FrameScheduler {
	private readonly clock: FrameSchedulerClock;
	private readonly isBlocked: () => boolean;
	private pending = false;
	private paused = false;
	private stopped = false;
	private timer: unknown;
	private lastFrameAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly renderFrame: () => void,
		private readonly options: FrameSchedulerOptions,
	) {
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.isBlocked = options.isBlocked ?? (() => false);
	}

	request(immediate = false): void {
		this.pending = true;
		if (immediate) {
			this.cancelTimer();
		}
		this.schedule(immediate);
	}

	setPaused(paused: boolean): void {
		if (this.paused === paused) return;
		this.paused = paused;
		if (paused) {
			this.cancelTimer();
			return;
		}
		this.schedule(false);
	}

	/** Retry a pending frame after an external gate, such as stdout backpressure, opens. */
	notifyReady(): void {
		this.schedule(false);
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.schedule(false);
	}

	stop(): void {
		this.stopped = true;
		this.cancelTimer();
	}

	private schedule(immediate: boolean): void {
		if (
			this.stopped ||
			this.paused ||
			this.isBlocked() ||
			this.timer !== undefined ||
			!this.pending
		) {
			return;
		}
		const elapsed = this.clock.now() - this.lastFrameAt;
		const delayMs = immediate ? 0 : Math.max(0, this.options.minIntervalMs - elapsed);
		this.timer = this.clock.setTimeout(() => this.emitFrame(), delayMs);
	}

	private emitFrame(): void {
		this.timer = undefined;
		if (this.stopped || this.paused || this.isBlocked() || !this.pending) return;

		this.pending = false;
		this.lastFrameAt = this.clock.now();
		this.renderFrame();
		this.schedule(false);
	}

	private cancelTimer(): void {
		if (this.timer === undefined) return;
		this.clock.clearTimeout(this.timer);
		this.timer = undefined;
	}
}

interface DrainEventSource {
	on(event: "drain", listener: () => void): unknown;
	removeListener(event: "drain", listener: () => void): unknown;
}

/** Tracks a Node Writable's false/drain lifecycle without owning the stream. */
export class OutputBackpressureTracker {
	private backpressured = false;
	private drainAttached = false;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly source: DrainEventSource) {}

	get blocked(): boolean {
		return this.backpressured;
	}

	observeWrite(accepted: boolean): void {
		if (accepted) return;
		this.backpressured = true;
		this.syncDrainListener();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		this.syncDrainListener();
		return () => {
			this.listeners.delete(listener);
			this.syncDrainListener();
		};
	}

	private readonly handleDrain = (): void => {
		if (!this.backpressured) return;
		this.backpressured = false;
		for (const listener of this.listeners) listener();
		this.syncDrainListener();
	};

	private syncDrainListener(): void {
		const shouldAttach = this.backpressured || this.listeners.size > 0;
		if (shouldAttach === this.drainAttached) return;
		this.drainAttached = shouldAttach;
		if (shouldAttach) {
			this.source.on("drain", this.handleDrain);
		} else {
			this.source.removeListener("drain", this.handleDrain);
		}
	}
}

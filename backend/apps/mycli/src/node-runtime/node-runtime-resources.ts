type ResourceOperation = () => void | Promise<void>;

export interface NodeBackendResourceOwnerOptions {
	readonly closeUpdateCache: ResourceOperation;
	readonly closeAgentWorkers?: ResourceOperation;
	readonly closeShellManager: ResourceOperation;
	readonly drainShellLifecycle: ResourceOperation;
	readonly drainArtifacts: ResourceOperation;
	readonly closeStore: ResourceOperation;
}

export class NodeBackendResourceOwner {
	readonly #options: NodeBackendResourceOwnerOptions;
	#closeIntegration: ResourceOperation | undefined;
	#closing: Promise<void> | undefined;

	constructor(options: NodeBackendResourceOwnerOptions) {
		this.#options = options;
	}

	bindIntegration(close: ResourceOperation): void {
		if (this.#closing) throw new Error("backend resources are closing");
		if (this.#closeIntegration) throw new Error("backend integration resource is already bound");
		this.#closeIntegration = close;
	}

	close(): Promise<void> {
		this.#closing ??= this.#closeResources();
		return this.#closing;
	}

	async #closeResources(): Promise<void> {
		let failure: unknown;
		for (const operation of [
			this.#options.closeUpdateCache,
			this.#closeIntegration,
			this.#options.closeAgentWorkers,
			this.#options.closeShellManager,
			this.#options.drainShellLifecycle,
			this.#options.drainArtifacts,
			this.#options.closeStore,
		]) {
			if (!operation) continue;
			try {
				await operation();
			} catch (error) {
				failure ??= error;
			}
		}
		if (failure !== undefined) throw failure;
	}
}

export class SerializedSessionArtifactQueue {
	#pending: Promise<void> = Promise.resolve();
	#closing: Promise<void> | undefined;

	run(operation: () => Promise<void>): Promise<void> {
		if (this.#closing) throw new Error("artifact queue is closing");
		const scheduled = this.#pending.then(operation);
		this.#pending = scheduled.catch(() => undefined);
		return scheduled;
	}

	drain(): Promise<void> {
		return this.#pending;
	}

	close(): Promise<void> {
		this.#closing ??= this.#pending;
		return this.#closing;
	}
}

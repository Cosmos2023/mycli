export interface RefreshableNodeRuntime {
	refreshExtensions?(): void;
}

export class NodeRuntimeRegistry<Runtime extends RefreshableNodeRuntime> {
	readonly #runtimeBySessionId = new Map<string, Runtime>();

	get(sessionId: string): Runtime | undefined {
		return this.#runtimeBySessionId.get(sessionId);
	}

	set(sessionId: string, runtime: Runtime): void {
		if (!sessionId.trim()) throw new TypeError("runtime session id must be non-empty");
		this.#runtimeBySessionId.set(sessionId, runtime);
	}

	delete(sessionId: string, expected: Runtime): boolean {
		if (this.#runtimeBySessionId.get(sessionId) !== expected) return false;
		return this.#runtimeBySessionId.delete(sessionId);
	}

	refreshExtensions(): void {
		for (const runtime of [...this.#runtimeBySessionId.values()]) {
			runtime.refreshExtensions?.();
		}
	}
}

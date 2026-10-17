/**
 * A scope an extension attaches values to. Keys belong to whoever wrote them: the runtime never
 * inspects them, and nothing stops two extensions from using the same key, so prefix it.
 */
export interface ExtensionStateScope {
	get<Value>(key: string): Value | undefined;
	/** Stores the value and returns it, so a lazy initializer stays one expression. */
	set<Value>(key: string, value: Value): Value;
	delete(key: string): void;
	has(key: string): boolean;
}

/**
 * Extension state whose lifetime the runtime owns, so an extension does not have to invent a map and
 * remember to clean it up. Codex hands every hook a thread store and a turn store; these are the two
 * lifetimes mycli needs.
 */
export interface ExtensionState {
	/** Lives as long as the runtime. */
	readonly session: ExtensionStateScope;
	/**
	 * Lives for one turn. The runtime drops it when that turn reaches *any* terminal state, so an
	 * extension that only cleans up on the happy path cannot leak — which is exactly what a map
	 * cleared from `onTurnComplete` does, because a failed or interrupted turn never completes.
	 */
	turn(turnId: string): ExtensionStateScope;
}

export interface ExtensionStateStore extends ExtensionState {
	/** Drops everything attached to a turn. The runtime calls this once the turn is terminal. */
	endTurn(turnId: string): void;
}

export function createExtensionState(): ExtensionStateStore {
	const turns = new Map<string, ExtensionStateScope>();
	return Object.freeze({
		session: createScope(),
		turn: (turnId: string): ExtensionStateScope => {
			const existing = turns.get(turnId);
			if (existing) return existing;
			const created = createScope();
			turns.set(turnId, created);
			return created;
		},
		endTurn: (turnId: string): void => { turns.delete(turnId); },
	});
}

function createScope(): ExtensionStateScope {
	const values = new Map<string, unknown>();
	return Object.freeze({
		get: <Value>(key: string): Value | undefined => values.get(key) as Value | undefined,
		set: <Value>(key: string, value: Value): Value => { values.set(key, value); return value; },
		delete: (key: string): void => { values.delete(key); },
		has: (key: string): boolean => values.has(key),
	});
}

import type { ExtensionDefinition, ExtensionState, ExtensionTurnInput } from "@mycli/extensions";
import type { MemoryContextResult, MemoryContextServiceContract } from "./memory-context-service.ts";

export interface MemoryExtensionOptions {
	readonly service: MemoryContextServiceContract;
	/** Read at call time so a settings change applies to the next turn. */
	readonly enabled: () => boolean;
	/** Runtime-managed state, so the memoized collect cannot outlive its turn. */
	readonly state: ExtensionState;
}

/**
 * Memory as an extension. It contributes the conversation item the direct request path inserts
 * ahead of the current input and the context section the durable request path renders, then runs
 * the explicit remember/forget actions after a completed turn.
 *
 * The collect call is memoized per turn so both representations stay one observation. It is
 * forgotten when the runtime drops that turn's state, which happens on every terminal path — not
 * only on completion, which is where the map this replaced cleaned up and therefore leaked on
 * failed and interrupted turns.
 */
export function createMemoryExtension(options: MemoryExtensionOptions): ExtensionDefinition {
	const collectKey = "memory:collect";
	const collect = (input: ExtensionTurnInput): Promise<MemoryContextResult | undefined> => {
		const turn = options.state.turn(input.turnId);
		const existing = turn.get<Promise<MemoryContextResult | undefined>>(collectKey);
		if (existing) return existing;
		const pending = input.source !== "user" || !options.enabled()
			? Promise.resolve(undefined)
			: options.service.collect({
				userMessage: input.message,
				sessionId: input.sessionId,
				enabled: true,
				signal: input.signal,
			}).then(
				(result) => result,
				// A failed lookup means "no memory for this turn"; the turn keeps going.
				() => undefined,
			);
		turn.set(collectKey, pending);
		return pending;
	};
	return {
		id: "memory",
		context: {
			context: async (input) => {
				const text = (await collect(input))?.item?.text;
				if (!text?.trim()) return undefined;
				return [{
					key: "memory",
					kind: "memory",
					title: "Memory",
					content: `<memory_context>\n- ${text.trim()}\n</memory_context>`,
					source: "runtime:memory",
					cacheClass: "dynamic",
					scope: "transcript",
					includeInMemory: true,
				}];
			},
		},
		conversationItems: {
			conversationItems: async (input) => {
				const item = (await collect(input))?.item;
				return item ? [item] : undefined;
			},
		},
		turnLifecycle: {
			onTurnComplete: async (input) => {
				// Explicit remember/forget actions are durable, so they need the terminal snapshot.
				if (!input.terminalSnapshotWritten) return;
				if (input.source !== "user" || !options.enabled()) return;
				await options.service.applyExplicitActions({ userMessage: input.message, enabled: true });
			},
		},
	};
}

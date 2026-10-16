import type { ExtensionDefinition, ExtensionTurnInput } from "@mycli/extensions";
import type { MemoryContextResult, MemoryContextServiceContract } from "./memory-context-service.ts";

export interface MemoryExtensionOptions {
	readonly service: MemoryContextServiceContract;
	/** Read at call time so a settings change applies to the next turn. */
	readonly enabled: () => boolean;
}

/**
 * Memory as an extension. It contributes the conversation item the direct request path inserts
 * ahead of the current input and the context section the durable request path renders, then runs
 * the explicit remember/forget actions after a completed turn.
 *
 * The collect call is memoized per turn so both representations stay one observation, and it
 * forgets the turn once it completes.
 */
export function createMemoryExtension(options: MemoryExtensionOptions): ExtensionDefinition {
	const perTurn = new Map<string, Promise<MemoryContextResult | undefined>>();
	const collect = (input: ExtensionTurnInput): Promise<MemoryContextResult | undefined> => {
		const existing = perTurn.get(input.turnId);
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
		perTurn.set(input.turnId, pending);
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
				perTurn.delete(input.turnId);
				// Explicit remember/forget actions are durable, so they need the terminal snapshot.
				if (!input.terminalSnapshotWritten) return;
				if (input.source !== "user" || !options.enabled()) return;
				await options.service.applyExplicitActions({ userMessage: input.message, enabled: true });
			},
		},
	};
}

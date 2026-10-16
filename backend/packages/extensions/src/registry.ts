import type { CanonicalConversationItem } from "@mycli/core";
import type {
	ExtensionDefinition,
	ExtensionTokenUsageInput,
	ExtensionTurnCompleteInput,
	ExtensionTurnInput,
} from "./contributors.ts";

export type ExtensionHookName = "onTurnStart" | "onTurnComplete" | "conversationItems" | "onTokenUsage";

/** A hook that threw. Extensions are auxiliary, so a failure is reported instead of propagated. */
export interface ExtensionFailure {
	readonly extensionId: string;
	readonly hook: ExtensionHookName;
	readonly message: string;
}

export interface ExtensionRegistryOptions {
	/** Every isolated failure is reported here so a broken extension stays visible. */
	readonly onFailure?: (failure: ExtensionFailure) => void;
}

const FAILURE_MESSAGE_MAX_CHARS = 240;

/**
 * Owns the registered extensions and runs their hooks.
 *
 * Two properties matter and are enforced here rather than by each feature:
 * - registration order is the execution order, so behaviour is deterministic;
 * - one extension throwing can never fail a turn, and the failure is reported.
 */
export class ExtensionRegistry {
	readonly #extensions = new Map<string, ExtensionDefinition>();
	readonly #onFailure: ((failure: ExtensionFailure) => void) | undefined;

	constructor(options: ExtensionRegistryOptions = {}) {
		this.#onFailure = options.onFailure;
	}

	register(definition: ExtensionDefinition): void {
		const id = definition.id.trim();
		if (!id) throw new TypeError("extension id must be non-empty");
		if (this.#extensions.has(id)) throw new TypeError(`duplicate extension id: ${id}`);
		this.#extensions.set(id, Object.freeze({ ...definition, id }));
	}

	has(id: string): boolean {
		return this.#extensions.has(id);
	}

	ids(): readonly string[] {
		return Object.freeze([...this.#extensions.keys()]);
	}

	async runTurnStart(input: ExtensionTurnInput): Promise<void> {
		for (const [id, extension] of this.#extensions) {
			await this.#run(id, "onTurnStart", () => extension.turnLifecycle?.onTurnStart?.(input));
		}
	}

	async runTurnComplete(input: ExtensionTurnCompleteInput): Promise<void> {
		for (const [id, extension] of this.#extensions) {
			await this.#run(id, "onTurnComplete", () => extension.turnLifecycle?.onTurnComplete?.(input));
		}
	}

	async runTokenUsage(input: ExtensionTokenUsageInput): Promise<void> {
		for (const [id, extension] of this.#extensions) {
			await this.#run(id, "onTokenUsage", () => extension.tokenUsage?.onTokenUsage?.(input));
		}
	}

	async collectConversationItems(
		input: ExtensionTurnInput,
	): Promise<readonly CanonicalConversationItem[]> {
		const items: CanonicalConversationItem[] = [];
		for (const [id, extension] of this.#extensions) {
			const hook = extension.conversationItems?.conversationItems;
			if (!hook) continue;
			try {
				const contributed = await hook(input);
				if (contributed?.length) items.push(...contributed);
			} catch (error) {
				this.#report(id, "conversationItems", error);
			}
		}
		return Object.freeze(items);
	}

	async #run(
		id: string,
		hook: ExtensionHookName,
		invoke: () => void | Promise<void>,
	): Promise<void> {
		try {
			await invoke();
		} catch (error) {
			this.#report(id, hook, error);
		}
	}

	#report(extensionId: string, hook: ExtensionHookName, error: unknown): void {
		if (!this.#onFailure) return;
		try {
			this.#onFailure(Object.freeze({ extensionId, hook, message: failureMessage(error) }));
		} catch {
			// Reporting a failure must not become a failure of its own.
		}
	}
}

function failureMessage(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	const printable = [...text].map((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 0x20 || code === 0x7f ? " " : character;
	}).join("");
	return printable.slice(0, FAILURE_MESSAGE_MAX_CHARS);
}

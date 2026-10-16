import type { CanonicalConversationItem } from "@mycli/core";
import type { ToolAdapter } from "@mycli/tools";
import type {
	ExtensionAdmission,
	ExtensionAdmissionFailureInput,
	ExtensionAdmissionInput,
	ExtensionAdmissionRef,
	ExtensionAdmittedTurnInput,
	ExtensionCompactionBudget,
	ExtensionCompactionBudgetInput,
	ExtensionContextSection,
	ExtensionDefinition,
	ExtensionFinishedTurnInput,
	ExtensionTokenUsageInput,
	ExtensionTurnCompleteInput,
	ExtensionTurnInput,
	ExtensionTurnPolicyInput,
	ExtensionTurnStop,
} from "./contributors.ts";

export type ExtensionHookName =
	| "onTurnAdmitted"
	| "onTurnStart"
	| "onTurnComplete"
	| "onTurnFinished"
	| "conversationItems"
	| "context"
	| "onTokenUsage"
	| "nextTurn"
	| "assertAdmission"
	| "onAdmissionFailed"
	| "stopReason"
	| "toolsStopReason"
	| "allowTools"
	| "onRestore"
	| "onInterrupt"
	| "onClose"
	| "tools"
	| "compactionBudget";

/** A turn an extension asked for, resolved back to the extension that asked. */
export interface ResolvedAdmission extends ExtensionAdmission {
	readonly extensionId: string;
}

/** A turn stop an extension asked for, resolved back to the extension that asked. */
export interface ResolvedTurnStop extends ExtensionTurnStop {
	readonly extensionId: string;
}

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

	async runTurnAdmitted(input: ExtensionAdmittedTurnInput): Promise<void> {
		for (const [id, extension] of this.#extensions) {
			await this.#run(id, "onTurnAdmitted", () => extension.turnLifecycle?.onTurnAdmitted?.(input));
		}
	}

	async runTurnComplete(input: ExtensionTurnCompleteInput): Promise<void> {
		for (const [id, extension] of this.#extensions) {
			await this.#run(id, "onTurnComplete", () => extension.turnLifecycle?.onTurnComplete?.(input));
		}
	}

	async runTurnFinished(input: ExtensionFinishedTurnInput): Promise<void> {
		for (const [id, extension] of this.#extensions) {
			await this.#run(id, "onTurnFinished", () => extension.turnLifecycle?.onTurnFinished?.(input));
		}
	}

	async runTokenUsage(input: ExtensionTokenUsageInput): Promise<void> {
		for (const [id, extension] of this.#extensions) {
			await this.#run(id, "onTokenUsage", () => extension.tokenUsage?.onTokenUsage?.(input));
		}
	}

	/**
	 * Asks each extension, in registration order, whether it wants to start a turn. A throwing
	 * extension is reported and treated as "no turn", so a broken extension cannot stall the
	 * scheduler for the others.
	 */
	nextTurn(input: ExtensionAdmissionInput): ResolvedAdmission | undefined {
		for (const [id, extension] of this.#extensions) {
			const hook = extension.admission?.nextTurn;
			if (!hook) continue;
			let admission: ExtensionAdmission | undefined;
			try {
				admission = hook(input);
			} catch (error) {
				this.#report(id, "nextTurn", error);
				continue;
			}
			if (admission) return Object.freeze({ ...admission, extensionId: id });
		}
		return undefined;
	}

	/**
	 * Validates an admission with the extension that issued it. Unlike the auxiliary hooks this one
	 * gates the turn, so the failure is reported *and* propagated to the caller.
	 */
	assertAdmission(ref: ExtensionAdmissionRef, input: { readonly sessionId: string }): void {
		const extension = this.#extensions.get(ref.extensionId);
		if (!extension) throw new TypeError(`admission from an unregistered extension: ${ref.extensionId}`);
		try {
			extension.admission?.assertAdmission?.({ sessionId: input.sessionId, reference: ref.reference });
		} catch (error) {
			this.#report(ref.extensionId, "assertAdmission", error);
			throw error;
		}
	}

	/** Tells the owning extension that its admitted turn could not be started. */
	admissionFailed(ref: ExtensionAdmissionRef, input: Omit<ExtensionAdmissionFailureInput, "reference">): void {
		const extension = this.#extensions.get(ref.extensionId);
		if (!extension) return;
		try {
			extension.admission?.onAdmissionFailed?.({ ...input, reference: ref.reference });
		} catch (error) {
			this.#report(ref.extensionId, "onAdmissionFailed", error);
			throw error;
		}
	}

	/**
	 * Asks each extension whether the turn must stop. A throwing extension cannot decide, so it is
	 * reported and skipped; the failure stays visible in the session trace.
	 */
	stopReason(input: ExtensionTurnPolicyInput): ResolvedTurnStop | undefined {
		return this.#firstTurnStop(input, "stopReason");
	}

	toolsStopReason(input: ExtensionTurnPolicyInput): ResolvedTurnStop | undefined {
		return this.#firstTurnStop(input, "toolsStopReason");
	}

	/** Every contributor is asked, so one extension's state never depends on another's answer. */
	allowTools(input: ExtensionTurnPolicyInput): boolean {
		let allowed = true;
		for (const [id, extension] of this.#extensions) {
			const hook = extension.turnPolicy?.allowTools;
			if (!hook) continue;
			try {
				if (!hook(input)) allowed = false;
			} catch (error) {
				this.#report(id, "allowTools", error);
			}
		}
		return allowed;
	}

	#firstTurnStop(
		input: ExtensionTurnPolicyInput,
		hook: "stopReason" | "toolsStopReason",
	): ResolvedTurnStop | undefined {
		for (const [id, extension] of this.#extensions) {
			const decide = extension.turnPolicy?.[hook];
			if (!decide) continue;
			try {
				const stop = decide(input);
				if (stop) return Object.freeze({ ...stop, extensionId: id });
			} catch (error) {
				this.#report(id, hook, error);
			}
		}
		return undefined;
	}

	/**
	 * Session lifecycle is contract-bearing: `onRestore` decides whether a feature may continue
	 * after a restart and `onInterrupt` decides whether it keeps driving work, so both report and
	 * propagate. `onClose` releases resources, so every extension is closed and the first failure
	 * is rethrown afterwards.
	 */
	restore(): void {
		this.#runLifecycle("onRestore");
	}

	interrupt(): void {
		this.#runLifecycle("onInterrupt");
	}

	close(): void {
		let firstError: unknown;
		for (const [id, extension] of this.#extensions) {
			const hook = extension.sessionLifecycle?.onClose;
			if (!hook) continue;
			try {
				hook();
			} catch (error) {
				this.#report(id, "onClose", error);
				firstError ??= error;
			}
		}
		if (firstError !== undefined) throw firstError;
	}

	#runLifecycle(hook: "onRestore" | "onInterrupt"): void {
		for (const [id, extension] of this.#extensions) {
			const run = extension.sessionLifecycle?.[hook];
			if (!run) continue;
			try {
				run();
			} catch (error) {
				this.#report(id, hook, error);
				throw error;
			}
		}
	}

	/**
	 * Every extension's tools, in registration order. A throwing contributor is reported and
	 * skipped: a broken extension must not leave the session without a catalog.
	 */
	tools(): readonly ToolAdapter[] {
		const adapters: ToolAdapter[] = [];
		for (const [id, extension] of this.#extensions) {
			const contribute = extension.tools?.tools;
			if (!contribute) continue;
			try {
				adapters.push(...contribute());
			} catch (error) {
				this.#report(id, "tools", error);
			}
		}
		return Object.freeze(adapters);
	}

	/**
	 * The account this compaction is charged to, resolved once so the owner captures it before the
	 * summarizer spends anything. A throwing contributor is reported and skipped.
	 */
	compactionBudget(input: ExtensionCompactionBudgetInput): ExtensionCompactionBudget | undefined {
		for (const [id, extension] of this.#extensions) {
			const resolve = extension.compactionBudget?.compactionBudget;
			if (!resolve) continue;
			try {
				const budget = resolve(input);
				if (budget) return budget;
			} catch (error) {
				this.#report(id, "compactionBudget", error);
			}
		}
		return undefined;
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

	/**
	 * Merges the turn-context sections every extension contributes. Duplicate keys keep the first
	 * section; a conflicting duplicate is reported instead of silently reordering the context.
	 */
	async collectContext(input: ExtensionTurnInput): Promise<readonly ExtensionContextSection[]> {
		const byKey = new Map<string, ExtensionContextSection>();
		for (const [id, extension] of this.#extensions) {
			const hook = extension.context?.context;
			if (!hook) continue;
			let contributed: readonly ExtensionContextSection[] | undefined;
			try {
				contributed = await hook(input);
			} catch (error) {
				this.#report(id, "context", error);
				continue;
			}
			for (const section of contributed ?? []) {
				const existing = byKey.get(section.key);
				if (!existing) {
					byKey.set(section.key, Object.freeze({ ...section }));
					continue;
				}
				if (existing.content !== section.content) {
					this.#report(id, "context", new Error(`conflicting context section key: ${section.key}`));
				}
			}
		}
		return Object.freeze([...byKey.values()]);
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

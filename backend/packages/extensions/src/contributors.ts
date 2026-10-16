import type {
	CanonicalConversationItem,
	InstructionFragmentKind,
	ProviderUsage,
} from "@mycli/core";

/** Where a turn came from: a human submission, another agent, or goal continuation. */
export type ExtensionTurnSource = "user" | "agent_mailbox" | "goal";

/**
 * The view a contributor gets of the turn it is observing. It deliberately carries only what every
 * lifecycle point has in common, so the core never has to know which extension needs what.
 */
export interface ExtensionTurnInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly workspaceRoot: string;
	readonly source: ExtensionTurnSource;
	readonly message: string;
	readonly signal: AbortSignal;
}

export interface ExtensionTurnCompleteInput extends ExtensionTurnInput {
	readonly assistantText: string;
	readonly usage: ProviderUsage;
	/** False when the terminal snapshot could not be written, so durable side effects are unsafe. */
	readonly terminalSnapshotWritten: boolean;
}

export interface ExtensionTokenUsageInput {
	readonly sessionId: string;
	readonly turnId: string;
	/** Identifies the provider request the usage belongs to, so accounting stays idempotent. */
	readonly requestId: string;
	readonly usage: ProviderUsage;
}

export interface TurnLifecycleContributor {
	/** Runs once the turn is admitted and before the first provider request. */
	onTurnStart?(input: ExtensionTurnInput): void | Promise<void>;
	/** Runs after a turn completes; failures are isolated like every other hook. */
	onTurnComplete?(input: ExtensionTurnCompleteInput): void | Promise<void>;
}

export interface ConversationItemContributor {
	/**
	 * Items the runtime inserts ahead of the current user input, mirroring how memory is injected.
	 * Return `undefined` to contribute nothing for this turn.
	 */
	conversationItems?(
		input: ExtensionTurnInput,
	): readonly CanonicalConversationItem[] | undefined | Promise<readonly CanonicalConversationItem[] | undefined>;
}

export interface TokenUsageContributor {
	onTokenUsage?(input: ExtensionTokenUsageInput): void | Promise<void>;
}

/**
 * A turn-context section an extension contributes. The extension owns the identity (`key`,
 * `kind`, `title`, `source`) and the rendered `content`, so migrating a feature onto the registry
 * does not change the bytes the model sees.
 */
export interface ExtensionContextSection {
	readonly key: string;
	readonly kind: InstructionFragmentKind;
	readonly title: string;
	readonly content: string;
	readonly source: string;
	/** Trusted policy-producing sections carry developer authority, like trusted hook context. */
	readonly trusted?: boolean;
	readonly policyProducing?: boolean;
	readonly cacheClass?: "static" | "dynamic" | "ephemeral";
	readonly scope?: "turn" | "transcript" | "session";
	readonly includeInMemory?: boolean;
	readonly required?: boolean;
}

export interface ContextContributor {
	context?(
		input: ExtensionTurnInput,
	): readonly ExtensionContextSection[] | undefined | Promise<readonly ExtensionContextSection[] | undefined>;
}

/** One registered feature. `id` is the stable identity used for ordering, tracing, and failures. */
export interface ExtensionDefinition {
	readonly id: string;
	readonly turnLifecycle?: TurnLifecycleContributor;
	readonly conversationItems?: ConversationItemContributor;
	readonly context?: ContextContributor;
	readonly tokenUsage?: TokenUsageContributor;
}

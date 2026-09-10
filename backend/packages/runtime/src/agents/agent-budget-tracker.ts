import type {
	AgentBudget,
	AgentBudgetExhaustionKind,
	ProviderUsage,
} from "@mycli/core";

export interface AgentBudgetTrackerOptions {
	readonly budget?: AgentBudget;
	readonly clock?: () => number;
}

export interface ProviderOutputBudgetInput {
	readonly usage: ProviderUsage;
	readonly assistantText: string;
	readonly toolCallCount: number;
}

export interface ProviderOutputBudgetObservation {
	readonly retryEmptyOutput: boolean;
	readonly exhaustion?: AgentBudgetExhaustionKind;
}

export class AgentBudgetTracker {
	readonly #budget: AgentBudget;
	readonly #clock: () => number;
	readonly #startedAt: number;
	#providerSteps = 0;
	#toolCalls = 0;
	#tokens = 0;
	#noProgressTurns = 0;
	#exhausted: AgentBudgetExhaustionKind | undefined;

	constructor(options: AgentBudgetTrackerOptions = {}) {
		this.#budget = validatedAgentBudget(options.budget);
		this.#clock = options.clock ?? (() => performance.now());
		this.#startedAt = this.#budget.wallClockMs === undefined ? 0 : this.#clock();
	}

	exhaustion(): AgentBudgetExhaustionKind | undefined {
		return this.#exhausted;
	}

	providerStepCount(): number {
		return this.#providerSteps;
	}

	toolCallCount(): number {
		return this.#toolCalls;
	}

	beginProviderStep(): AgentBudgetExhaustionKind | undefined {
		const maxTurns = this.#budget.maxTurns;
		if (maxTurns !== undefined && this.#providerSteps >= maxTurns) {
			return this.markExhausted("max_turns");
		}
		this.#providerSteps += 1;
		return undefined;
	}

	reserveToolCalls(count: number): AgentBudgetExhaustionKind | undefined {
		if (!Number.isSafeInteger(count) || count < 0) {
			throw new TypeError("tool call reservation must be a non-negative integer");
		}
		const maxToolCalls = this.#budget.maxToolCalls;
		if (maxToolCalls !== undefined && this.#toolCalls + count > maxToolCalls) {
			return this.markExhausted("max_tool_calls");
		}
		this.#toolCalls += count;
		return undefined;
	}

	wallClockExhaustion(): AgentBudgetExhaustionKind | undefined {
		const limit = this.#budget.wallClockMs;
		if (limit === undefined) return undefined;
		const elapsed = this.#clock() - this.#startedAt;
		return elapsed >= limit ? this.markExhausted("wall_clock") : undefined;
	}

	observeProviderOutput(input: ProviderOutputBudgetInput): ProviderOutputBudgetObservation {
		if (!Number.isSafeInteger(input.toolCallCount) || input.toolCallCount < 0) {
			throw new TypeError("provider tool call count must be a non-negative integer");
		}
		this.#tokens = usageTokenTotal(input.usage);
		if (input.toolCallCount > 0
			&& this.#budget.maxTokens !== undefined
			&& this.#tokens >= this.#budget.maxTokens) {
			return Object.freeze({
				retryEmptyOutput: false,
				exhaustion: this.markExhausted("max_tokens"),
			});
		}

		if (input.toolCallCount === 0
			&& !input.assistantText.trim()
			&& this.#budget.noProgressTurnLimit !== undefined) {
			this.#noProgressTurns += 1;
			if (this.#noProgressTurns >= this.#budget.noProgressTurnLimit) {
				return Object.freeze({
					retryEmptyOutput: false,
					exhaustion: this.markExhausted("no_progress"),
				});
			}
			return Object.freeze({ retryEmptyOutput: true });
		}

		this.#noProgressTurns = 0;
		return Object.freeze({ retryEmptyOutput: false });
	}

	markExhausted(kind: AgentBudgetExhaustionKind): AgentBudgetExhaustionKind {
		this.#exhausted ??= kind;
		return this.#exhausted;
	}
}

function validatedAgentBudget(value: AgentBudget | undefined): AgentBudget {
	if (!value) return Object.freeze({});
	const entries = Object.entries(value).flatMap(([key, limit]) => {
		if (limit === undefined) return [];
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new TypeError(`agent budget ${key} must be a positive integer`);
		}
		return [[key, limit] as const];
	});
	return Object.freeze(Object.fromEntries(entries));
}

function usageTokenTotal(usage: ProviderUsage): number {
	const total = usage.total_tokens ?? usage.totalTokens;
	if (typeof total === "number" && Number.isFinite(total) && total >= 0) return total;
	const input = usage.input_tokens ?? usage.inputTokens ?? 0;
	const output = usage.output_tokens ?? usage.outputTokens ?? 0;
	return Math.max(0, input) + Math.max(0, output);
}

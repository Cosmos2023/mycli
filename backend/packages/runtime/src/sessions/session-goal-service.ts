import type { TurnInterruptionReason } from "@mycli/contracts";
import { randomUUID } from "node:crypto";
import type { SessionGoal } from "@mycli/contracts";
import {
	GoalStateError, addGoalCount, changeGoalStatus, createSessionGoal, goalObjective,
	goalReference, goalTokenBudget, goalUsageTokens, matchesGoal,
	type GoalRef, type GoalStatus, type ProviderUsage,
} from "@mycli/core";
import type { GoalCommit, SessionGoalStore } from "@mycli/storage";
import type { SessionGoalSteering } from "./session-goal-context.ts";

interface GoalTurn {
	ref: GoalRef | null;
	accountingGoalId: string | null;
	readonly human: boolean;
	/** Objective the goal had when the turn started; a later edit steers instead of stopping. */
	objective: string | null;
	/** The budget really ran out in this turn, so the turn gets one wrap-up step. */
	budgetWrapUp?: boolean;
	/** The single wrap-up step has been requested and carries no tools. */
	wrapUpServed?: boolean;
	finalizing?: boolean;
	accountedAt: number;
}

export interface SessionGoalServiceOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly store: SessionGoalStore;
	readonly clock?: () => string;
	readonly monotonicClock?: () => number;
	readonly createId?: () => string;
}

/** Owns goal state and accounting; ordinary runtime admission owns execution. */
export class SessionGoalService {
	readonly #turns = new Map<string, GoalTurn>();
	readonly #listeners = new Set<() => void>();
	readonly #clock: () => string;
	readonly #now: () => number;
	readonly #createId: () => string;
	#closed = false;
	#halted = false;

	constructor(private readonly options: SessionGoalServiceOptions) {
		this.#clock = options.clock ?? (() => new Date().toISOString());
		this.#now = options.monotonicClock ?? (() => performance.now());
		this.#createId = options.createId ?? randomUUID;
	}

	get(): SessionGoal | null { return this.options.store.get(this.options.sessionId); }

	inspect(): SessionGoal | null {
		this.#flushElapsed();
		return this.get();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}

	continuation(): GoalRef | undefined {
		if (this.#closed || this.#halted || this.#turns.size > 0) return undefined;
		const goal = this.get();
		return goal?.status === "active" ? goalReference(goal) : undefined;
	}

	assertContinuation(ref: GoalRef): void {
		this.#assertOpen();
		const goal = this.get();
		if (!matchesGoal(goal, ref) || goal.status !== "active") throw staleError();
	}

	failAdmission(ref: GoalRef, message: string): void {
		const goal = this.get();
		if (matchesGoal(goal, ref) && goal.status === "active") this.setStatus("blocked", message);
	}

	create(input: { readonly objective: string; readonly tokenBudget?: number | null }, turnId?: string): SessionGoal {
		this.#assertOpen();
		const previous = this.get();
		const turn = turnId === undefined ? undefined : this.#turns.get(turnId);
		if (turnId !== undefined) {
			if (!turn?.human) throw authorityError();
			if (turn.ref ? !matchesGoal(previous, turn.ref) : previous !== null) throw staleError();
		}
		const goal = Object.freeze({
			...createSessionGoal({ ...input, current: previous, goalId: this.#createId(), now: this.#clock() }),
			audit_turns: turn ? 1 : 0,
		});
		this.#commit("create", previous, goal, turnId ? `goal:${goal.goal_id}:turn:${turnId}` : undefined);
		if (turn) {
			turn.ref = goalReference(goal);
			turn.accountingGoalId = goal.goal_id;
			turn.objective = goal.objective;
			turn.accountedAt = this.#now();
		}
		return goal;
	}

	edit(input: { readonly objective?: string; readonly tokenBudget?: number | null }): SessionGoal {
		this.#assertOpen();
		this.#flushElapsed();
		const previous = this.#required();
		const tokenBudget = input.tokenBudget === undefined ? previous.token_budget : goalTokenBudget(input.tokenBudget);
		const exhausted = tokenBudget !== null && previous.tokens_used >= tokenBudget;
		const status = exhausted ? "budget_limited" : previous.status === "active" ? "active" : "paused";
		const goal: SessionGoal = Object.freeze({
			...previous, revision: addGoalCount(previous.revision, 1),
			objective: input.objective === undefined ? previous.objective : goalObjective(input.objective),
			token_budget: tokenBudget, updated_at: this.#clock(), audit_turns: 0, status,
			stop_reason: exhausted ? "Goal token budget exhausted." : status === "paused" ? "Goal edited. Resume to continue." : null,
		});
		this.#commit("edit", previous, goal);
		return goal;
	}

	setStatus(status: GoalStatus, reason: string | null = null): SessionGoal {
		this.#assertOpen();
		this.#flushElapsed();
		const previous = this.#required();
		const goal = changeGoalStatus(previous, status, this.#clock(), reason);
		if (goal !== previous) this.#commit("status", previous, goal);
		return goal;
	}

	updateFromTool(status: "complete" | "blocked" | "paused", turnId: string): SessionGoal {
		this.#assertOpen();
		const turn = this.#turns.get(turnId);
		const previous = this.#required();
		// The same goal keeps owning its turn across an objective edit; a replacement or a stop does not.
		if (!turn?.ref || previous.goal_id !== turn.ref.goalId
			|| (previous.status !== "active" && previous.status !== "budget_limited")) throw staleError();
		if (status === "paused" && !turn.human) throw authorityError();
		if (status === "blocked" && previous.audit_turns < 3) {
			throw new GoalStateError("goal_blocked_too_early", "Report blocked only after the same blocker persists for at least three goal turns in the current run.");
		}
		if (previous.status === "budget_limited" && status !== "complete") return previous;
		const goal = this.setStatus(status, status === "blocked" ? "Further progress requires user input or an external change." : null);
		turn.ref = goalReference(goal);
		turn.finalizing = true;
		return goal;
	}

	clear(): void {
		this.#assertOpen();
		this.#flushElapsed();
		const previous = this.get();
		if (previous) this.#commit("clear", previous, null);
	}

	/** Cold activation never inherits permission to launch automatic work. */
	restore(): void {
		if (this.get()?.status === "active") this.setStatus("paused", "Session restored. Resume the goal to continue.");
	}

	interrupt(): void {
		if (this.#closed || this.#halted) return;
		try {
			if (this.get()?.status === "active") this.setStatus("paused", "Goal paused by interruption.");
		} catch (error) { this.#halted = true; throw error; }
	}

	beginTurn(turnId: string, source: "user" | "agent_mailbox" | "goal", expected?: GoalRef): void {
		this.#assertOpen();
		if (this.#turns.has(turnId)) return;
		if (source === "goal") {
			if (!expected) throw staleError();
			this.assertContinuation(expected);
		}
		const previous = this.get();
		const active = previous?.status === "active" ? previous : null;
		if (active) this.#commit("round", active, Object.freeze({
			...active, audit_turns: addGoalCount(active.audit_turns, 1),
			rounds_started: addGoalCount(active.rounds_started, source === "goal" ? 1 : 0), updated_at: this.#clock(),
		}), `goal:${active.goal_id}:turn:${turnId}`);
		this.#turns.set(turnId, {
			ref: previous ? goalReference(previous) : null, accountingGoalId: active?.goal_id ?? null,
			human: source === "user", objective: active?.objective ?? null, accountedAt: this.#now(),
		});
	}

	observeUsage(turnId: string, requestId: string, usage: ProviderUsage): void {
		const turn = this.#turns.get(turnId);
		if (!turn?.accountingGoalId) return;
		const before = this.get();
		this.observeAttributedUsage(turn.accountingGoalId, requestId, usage);
		const after = this.get();
		// A known token count that tips an active goal over its budget earns one wrap-up step;
		// unavailable usage keeps the hard stop, because the budget cannot be confirmed spent.
		if (goalUsageTokens(usage) !== null && before?.status === "active"
			&& after?.status === "budget_limited" && after.goal_id === turn.accountingGoalId) {
			turn.budgetWrapUp = true;
		}
	}

	/** Children retain their original goal identity even if their root turn has settled. */
	observeAttributedUsage(goalId: string, requestId: string, usage: ProviderUsage): void {
		if (this.#closed || this.#halted) return;
		const previous = this.get();
		if (!previous || previous.goal_id !== goalId) return;
		const tokens = goalUsageTokens(usage);
		const observed = this.options.store.usage(this.options.sessionId, goalId, requestId);
		if (observed !== undefined && (tokens === null || (observed !== null && tokens <= observed))) return;
		const tokensUsed = addGoalCount(previous.tokens_used, Math.max(0, (tokens ?? 0) - (observed ?? 0)));
		const exhausted = previous.status === "active" && previous.token_budget !== null
			&& (tokensUsed >= previous.token_budget || tokens === null);
		this.#commit("usage", previous, Object.freeze({
			...previous, tokens_used: tokensUsed, usage_incomplete: previous.usage_incomplete || tokens === null,
			updated_at: this.#clock(), status: exhausted ? "budget_limited" : previous.status,
			stop_reason: exhausted ? tokens === null
				? "Provider usage is unavailable; budgeted execution stopped. Reported tokens are a lower bound."
				: "Goal token budget exhausted." : previous.stop_reason,
		}), `goal:${goalId}:usage:${requestId}:${tokens ?? "unknown"}`, { requestId, tokens });
	}

	accountingGoalId(turnId: string): string | undefined {
		return this.#turns.get(turnId)?.accountingGoalId ?? undefined;
	}

	remainingTokenBudget(goalId: string, turnId?: string): number | undefined {
		const goal = this.get();
		const turn = turnId === undefined ? undefined : this.#turns.get(turnId);
		if (this.executionHaltReason() || !goal || goal.goal_id !== goalId) return 0;
		if (goal.status !== "active" && !(turn?.finalizing && turn.ref && matchesGoal(goal, turn.ref))) return 0;
		if (goal.token_budget === null) return undefined;
		return goal.usage_incomplete ? 0 : Math.max(0, goal.token_budget - goal.tokens_used);
	}

	/** Deferred child admission may happen after the initiating parent turn has settled. */
	usageReference(turnId: string): GoalRef | undefined {
		const turn = this.#turns.get(turnId);
		if (turn) return turn.accountingGoalId ? turn.ref ?? undefined : undefined;
		const goal = this.get();
		return goal ? this.options.store.turnReference(this.options.sessionId, goal.goal_id, turnId) : undefined;
	}

	/** Pause/edit invalidate old work; completed goals may still produce their final response. */
	stopReason(turnId: string): string | undefined {
		const turn = this.#turns.get(turnId);
		if (!turn?.accountingGoalId) return undefined;
		const halted = this.executionHaltReason();
		if (halted) return halted;
		const goal = this.get();
		// An objective edit keeps the same goal owning this turn and steers it instead of stopping it.
		if (!goal || !turn.ref || goal.goal_id !== turn.ref.goalId) return "Goal changed while this turn was running.";
		// The spent turn gets exactly one more step, and only that step answers without tools.
		if (turn.budgetWrapUp && turn.wrapUpServed !== true) return undefined;
		return turn.finalizing || goal.status === "active" ? undefined : goal.stop_reason ?? `Goal is ${goal.status}.`;
	}

	interruptionReason(turnId: string): TurnInterruptionReason {
		const turn = this.#turns.get(turnId);
		const goal = this.get();
		if (!goal || !turn?.ref || goal.goal_id !== turn.ref.goalId) return "goal_changed";
		return goal.status === "budget_limited" ? goal.usage_incomplete ? "goal_usage_unavailable" : "goal_budget" : "goal_stopped";
	}

	toolsStopReason(turnId: string): string | undefined {
		const turn = this.#turns.get(turnId);
		if (turn?.finalizing) return "The goal has stopped; provide the final response without further tools.";
		// The pending batch still runs so the wrap-up step can answer it.
		if (turn?.budgetWrapUp && turn.wrapUpServed !== true) return undefined;
		if (turn?.budgetWrapUp) return "The goal token budget is exhausted; provide the final response without further tools.";
		return this.stopReason(turnId);
	}

	/** Steering the goal adds to a running turn's context on its next provider step. */
	steeringFor(turnId: string): SessionGoalSteering | undefined {
		const turn = this.#turns.get(turnId);
		if (!turn) return undefined;
		if (turn.budgetWrapUp) return "budget_limit";
		const goal = this.get();
		return goal && turn.objective !== null && goal.objective !== turn.objective ? "objective_updated" : undefined;
	}

	/** Offer the single wrap-up step: the request carries no tools, so it cannot open new work. */
	beginWrapUpStep(turnId: string): boolean {
		const turn = this.#turns.get(turnId);
		if (turn?.budgetWrapUp !== true || turn.wrapUpServed === true) return false;
		turn.wrapUpServed = true;
		return true;
	}

	executionHaltReason(): string | undefined {
		return this.#closed || this.#halted ? "The goal runtime stopped. Reopen the session before resuming." : undefined;
	}

	finishTurn(turnId: string, status: string, reason?: string): void {
		const turn = this.#turns.get(turnId);
		if (!turn) return;
		try {
			this.#flushElapsed();
			const goal = this.get();
			if (!turn.ref || !goal || goal.goal_id !== turn.ref.goalId || goal.status !== "active") return;
			if (status === "interrupted") this.interrupt();
			else if (status !== "completed") this.setStatus(
				reason === "quota_exceeded" || reason === "usage_limit_exceeded" ? "usage_limited" : "blocked",
				"Turn execution failed. Resolve the reported error, then resume the goal.",
			);
		} finally { this.#turns.delete(turnId); }
	}

	close(): void {
		if (this.#closed) return;
		try { this.interrupt(); }
		finally { this.#closed = true; this.#turns.clear(); this.#listeners.clear(); }
	}

	#flushElapsed(): void {
		for (const turn of this.#turns.values()) {
			const previous = this.get();
			if (!previous || previous.goal_id !== turn.accountingGoalId) continue;
			const now = this.#now();
			const elapsed = Math.max(0, Math.floor(now - turn.accountedAt));
			if (elapsed > 0) this.#commit("usage", previous, Object.freeze({
				...previous, elapsed_ms: addGoalCount(previous.elapsed_ms, elapsed), updated_at: this.#clock(),
			}));
			turn.accountedAt = now;
		}
	}

	#required(): SessionGoal {
		const goal = this.get();
		if (!goal) throw new GoalStateError("goal_not_found", "This session has no goal. Create one with /goal <objective>.");
		return goal;
	}

	#commit(operation: GoalCommit["operation"], previous: SessionGoal | null, next: SessionGoal | null, eventId = `goal:${this.#createId()}`, usage?: GoalCommit["usage"]): boolean {
		let changed: boolean;
		try {
			changed = this.options.store.commit({
				sessionId: this.options.sessionId, workspaceRoot: this.options.workspaceRoot, threadId: this.options.threadId,
				operation, expected: previous, next, eventId, createdAt: this.#clock(), ...(usage ? { usage } : {}),
			});
		} catch (error) { this.#halted = true; throw error; }
		if (changed) for (const listener of this.#listeners) {
			try { listener(); } catch { /* Publication cannot undo a durable state change. */ }
		}
		return changed;
	}

	#assertOpen(): void {
		const reason = this.executionHaltReason();
		if (reason) throw new GoalStateError("goal_runtime_closed", reason);
	}
}

function authorityError(): GoalStateError {
	return new GoalStateError("goal_authority_required", "This goal operation requires an explicit request in a human turn.");
}

function staleError(): GoalStateError {
	return new GoalStateError("goal_changed", "The goal changed after this turn started. The old turn cannot change it.");
}

import { parseSessionGoal, type SessionGoal } from "@mycli/contracts";
import { GoalStateError, goalReference, type GoalRef } from "@mycli/core";
import { StorageFailure, type SessionStateStore } from "./session-store.ts";
import type { TranscriptEventAppendInput, TranscriptEventEnvelope } from "../transcript/transcript-events.ts";

export interface GoalCommit {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly eventId: string;
	readonly operation: "create" | "edit" | "status" | "clear" | "usage" | "round";
	readonly expected: SessionGoal | null;
	readonly next: SessionGoal | null;
	readonly createdAt: string;
	readonly usage?: { readonly requestId: string; readonly tokens: number | null };
}

export interface SessionGoalStore {
	get(sessionId: string): SessionGoal | null;
	turnReference(sessionId: string, goalId: string, turnId: string): GoalRef | undefined;
	usage(sessionId: string, goalId: string, requestId: string): number | null | undefined;
	commit(input: GoalCommit): boolean;
}

/** Goal snapshots and their audit records share the session store's transaction. */
export class SessionGoalRepository implements SessionGoalStore {
	constructor(private readonly options: {
		readonly writable?: boolean;
		readonly usageGet: (sessionId: string, goalId: string, requestId: string) => number | null | undefined;
		readonly usageSave: (sessionId: string, goalId: string, requestId: string, tokens: number | null) => void;
		readonly state: Pick<SessionStateStore, "loadState" | "compareAndSetState">;
		readonly write: <Result>(operation: () => Result) => Result;
		readonly appendEvent: (input: TranscriptEventAppendInput) => unknown;
		readonly loadEvent: (sessionId: string, eventId: string) => TranscriptEventEnvelope | undefined;
	}) {}

	get(sessionId: string): SessionGoal | null {
		const value = this.options.state.loadState(sessionId, "session_goal");
		return value === undefined ? null : parseSessionGoal(value);
	}

	turnReference(sessionId: string, goalId: string, turnId: string): GoalRef | undefined {
		const event = this.options.loadEvent(sessionId, `goal:${goalId}:turn:${turnId}`);
		if (event?.eventType !== "display_activity" || event.payload.activityType !== "goal") return undefined;
		const snapshot = event.payload.metadata?.goal_snapshot;
		return snapshot ? goalReference(parseSessionGoal(snapshot)) : undefined;
	}

	usage(sessionId: string, goalId: string, requestId: string): number | null | undefined {
		return this.options.usageGet(sessionId, goalId, requestId);
	}

	commit(input: GoalCommit): boolean {
		if (this.options.writable === false) throw new StorageFailure("Goals require session format 15.", {}, "storage.version_unsupported");
		const next = input.next === null ? null : parseSessionGoal(input.next);
		return this.options.write(() => {
			if (this.options.loadEvent(input.sessionId, input.eventId)) return false;
			if (!this.options.state.compareAndSetState({
				sessionId: input.sessionId, workspaceRoot: input.workspaceRoot, threadId: input.threadId,
				key: "session_goal", expectedPayload: input.expected ?? undefined, payload: next ?? undefined,
			})) throw new GoalStateError("goal_changed", "The goal changed. Read its current state and retry.");
			if (input.usage && next) this.options.usageSave(input.sessionId, next.goal_id, input.usage.requestId, input.usage.tokens);
			this.options.appendEvent({
				schemaVersion: 1, sessionId: input.sessionId, eventId: input.eventId,
				eventType: "display_activity", modelVisible: false, createdAt: input.createdAt,
				payload: { activityType: "goal", metadata: {
					...(input.usage ? { goal_usage_request: input.usage.requestId, goal_usage_tokens: input.usage.tokens } : {}),
					goal_operation: input.operation, goal_snapshot: next === null ? null : { ...next },
				} },
			});
			return true;
		});
	}
}

import type { HookPoint, HookRunnerContract, RuntimeEvent } from "@mycli/core";
import { HookCoordinator, type HookPointResult } from "./hook-coordinator.ts";

export type SessionHookPoint = Extract<HookPoint, "session_start" | "session_end">;

export interface SessionHookOptions {
	readonly runner: HookRunnerContract;
	readonly sessionId: string;
	readonly emit?: (event: RuntimeEvent) => void;
}

/**
 * Session hooks fire outside any turn, so they borrow a stable synthetic turn id. Hook identity and
 * the JSON payload stay deterministic without inventing a real turn record.
 */
export async function runSessionHookPoint(
	options: SessionHookOptions,
	point: SessionHookPoint,
	metadata: Readonly<Record<string, unknown>>,
	signal: AbortSignal,
): Promise<HookPointResult> {
	const coordinator = new HookCoordinator({
		runner: options.runner,
		sessionId: options.sessionId,
		turnId: `session:${options.sessionId}`,
		...(options.emit ? { emit: options.emit } : {}),
	});
	return await coordinator.runPoint(point, metadata, signal);
}

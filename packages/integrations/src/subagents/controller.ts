import { randomUUID } from "node:crypto";
import type {
	SubagentTaskRecord,
	SubagentTaskStore,
} from "@mycli/storage";
import {
	SUBAGENT_TASK_PROGRESS_MAX_CHARS,
	SUBAGENT_TASK_REPORT_MAX_CHARS,
} from "@mycli/storage";
import type { SubagentProfileRegistry } from "./profile-registry.ts";
import { resolveChildTools } from "./tool-scope.ts";
import type { SubagentBudget } from "./types.ts";

export interface ChildRuntimeCreateInput {
	readonly parentSessionId: string;
	readonly parentTurnId: string;
	readonly childSessionId: string;
	readonly profileId: string;
	readonly model?: string;
	readonly tools: readonly string[];
	readonly budget?: Readonly<{
		readonly maxTurns?: number;
		readonly maxToolCalls?: number;
		readonly noProgressTurnLimit?: number;
	}>;
}

export type ChildRuntimeEvent =
	| { readonly type: "progress"; readonly summary: string }
	| { readonly type: "usage"; readonly usage: Readonly<Record<string, number>> };

export interface ChildRuntimeResult {
	readonly status: "completed" | "failed" | "interrupted";
	readonly report: string;
	readonly usage: Readonly<Record<string, number>>;
}

export interface ChildRuntimeHandle {
	run(
		prompt: string,
		signal: AbortSignal,
		emit: (event: ChildRuntimeEvent) => void,
	): Promise<ChildRuntimeResult>;
	send(message: string): Promise<void>;
	interrupt(reason: string): Promise<void>;
	close(): Promise<void>;
}

export interface ChildRuntimeFactory {
	create(input: ChildRuntimeCreateInput): Promise<ChildRuntimeHandle>;
}

export interface StartSubagentInput {
	readonly profileId: string;
	readonly prompt: string;
	readonly mode?: "foreground" | "background";
	readonly allowedTools?: readonly string[];
}

export type SubagentStartResult =
	| {
		readonly status: "running";
		readonly taskId: string;
		readonly childSessionId: string;
		readonly summary: string;
		readonly report?: string;
		readonly error?: string;
	}
	| {
		readonly status: "completed" | "failed" | "interrupted";
		readonly taskId: string;
		readonly childSessionId: string;
		readonly summary: string;
		readonly report?: string;
		readonly error?: string;
	};

export type SubagentOutputResult =
	| {
		readonly found: false;
		readonly childSessionId: string;
		readonly status: "missing";
		readonly progressSequence: 0;
	}
	| {
		readonly found: true;
		readonly childSessionId: string;
		readonly taskId: string;
		readonly status: SubagentTaskRecord["status"];
		readonly progressSequence: number;
		readonly progressSummary?: string;
		readonly report?: string;
		readonly outputReference?: string;
		readonly error?: string;
	};

export interface SubagentMessageResult {
	readonly accepted: boolean;
	readonly childSessionId: string;
	readonly delivery: "accepted" | "unavailable";
}

export interface SubagentControlContract {
	start(input: StartSubagentInput): Promise<SubagentStartResult>;
	output(childSessionId: string): SubagentOutputResult;
	send(childSessionId: string, message: string): Promise<SubagentMessageResult>;
}

export interface SubagentControllerOptions {
	readonly registry: SubagentProfileRegistry;
	readonly taskStore: SubagentTaskStore;
	readonly factory: ChildRuntimeFactory;
	readonly parentSessionId: string;
	readonly parentTurnId: () => string;
	readonly parentTools: () => readonly string[];
	readonly createTaskId?: () => string;
	readonly createChildSessionId?: () => string;
	readonly shutdownTimeoutMs?: number;
}

interface OwnedChild {
	readonly taskId: string;
	readonly childSessionId: string;
	readonly handle: ChildRuntimeHandle;
	readonly abortController: AbortController;
	readonly closeOnce: () => Promise<void>;
	progressSequence: number;
	usage: Readonly<Record<string, number>>;
	completion?: Promise<SubagentStartResult>;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 60_000;

export class SubagentController implements SubagentControlContract {
	readonly #options: Required<Pick<
		SubagentControllerOptions,
		"createTaskId" | "createChildSessionId" | "shutdownTimeoutMs"
	>> & Omit<SubagentControllerOptions, "createTaskId" | "createChildSessionId" | "shutdownTimeoutMs">;
	readonly #owned = new Map<string, OwnedChild>();
	#closing: Promise<void> | undefined;

	constructor(options: SubagentControllerOptions) {
		this.#options = {
			...options,
			createTaskId: options.createTaskId ?? randomUUID,
			createChildSessionId: options.createChildSessionId ?? randomUUID,
			shutdownTimeoutMs: positiveTimeout(options.shutdownTimeoutMs),
		};
	}

	async start(input: StartSubagentInput): Promise<SubagentStartResult> {
		const profile = this.#options.registry.get(input.profileId);
		if (!profile) {
			return Object.freeze({
				status: "failed",
				taskId: "unavailable",
				childSessionId: "unavailable",
				summary: "Subagent failed",
				error: "subagent profile not found",
			});
		}
		const taskId = this.#options.createTaskId();
		const childSessionId = this.#options.createChildSessionId();
		const parentTurnId = this.#options.parentTurnId();
		const ownership = {
			taskId,
			parentSessionId: this.#options.parentSessionId,
			childSessionId,
		};
		this.#options.taskStore.reserve({
			...ownership,
			parentTurnId,
			profileId: profile.id,
		});
		const requestedTools = input.allowedTools
			? profile.allowedTools.filter((name) => input.allowedTools?.includes(name))
			: profile.allowedTools;
		const resolved = resolveChildTools({
			parentTools: this.#options.parentTools(),
			allowed: requestedTools,
			denied: profile.deniedTools,
		});
		const createInput = deepFreeze({
			parentSessionId: this.#options.parentSessionId,
			parentTurnId,
			childSessionId,
			profileId: profile.id,
			...(profile.model ? { model: profile.model } : {}),
			tools: [...resolved.tools],
			...(hasBudget(profile.budget) ? { budget: { ...profile.budget } } : {}),
		}) satisfies ChildRuntimeCreateInput;

		let handle: ChildRuntimeHandle;
		try {
			handle = await this.#options.factory.create(createInput);
		} catch {
			this.#options.taskStore.markRunning(ownership);
			this.#options.taskStore.fail({ ...ownership, error: "child runtime failed" });
			return terminalResult(this.#options.taskStore.get(taskId), childSessionId);
		}

		const abortController = new AbortController();
		const closeOnce = onceAsync(() => handle.close());
		const owned: OwnedChild = {
			taskId,
			childSessionId,
			handle,
			abortController,
			closeOnce,
			progressSequence: 0,
			usage: Object.freeze({}),
		};
		this.#options.taskStore.markRunning(ownership);
		this.#owned.set(childSessionId, owned);
		const prompt = `${profile.prompt}\n\n${input.prompt.trim()}`;
		owned.completion = this.#runOwned(owned, prompt);

		if ((input.mode ?? "background") === "foreground") {
			return owned.completion;
		}
		return Object.freeze({
			status: "running",
			taskId,
			childSessionId,
			summary: "Subagent started in background",
		});
	}

	output(childSessionId: string): SubagentOutputResult {
		const record = this.#options.taskStore.getByChildSession(
			this.#options.parentSessionId,
			childSessionId,
		);
		if (!record) {
			return Object.freeze({
				found: false,
				childSessionId,
				status: "missing",
				progressSequence: 0,
			});
		}
		return outputFromRecord(record);
	}

	async send(childSessionId: string, message: string): Promise<SubagentMessageResult> {
		const owned = this.#owned.get(childSessionId);
		const record = this.#options.taskStore.getByChildSession(
			this.#options.parentSessionId,
			childSessionId,
		);
		if (!owned || record?.status !== "running") return unavailableMessage(childSessionId);
		try {
			await owned.handle.send(message);
			return Object.freeze({ accepted: true, childSessionId, delivery: "accepted" });
		} catch {
			return unavailableMessage(childSessionId);
		}
	}

	async interrupt(childSessionId: string, reason = "parent interrupted child"): Promise<boolean> {
		const owned = this.#owned.get(childSessionId);
		if (!owned) return false;
		owned.abortController.abort();
		this.#interruptRecord(owned, reason);
		await bounded(
			Promise.allSettled([
				owned.handle.interrupt(reason),
				owned.closeOnce(),
				...(owned.completion ? [owned.completion] : []),
			]).then(() => undefined),
			this.#options.shutdownTimeoutMs,
		);
		return true;
	}

	async waitFor(childSessionId: string): Promise<void> {
		await this.#owned.get(childSessionId)?.completion;
	}

	close(): Promise<void> {
		this.#closing ??= this.#closeAll();
		return this.#closing;
	}

	recoverAbandoned(reason: string): number {
		return this.#options.taskStore.interruptAbandoned(this.#options.parentSessionId, reason);
	}

	async #runOwned(owned: OwnedChild, prompt: string): Promise<SubagentStartResult> {
		const ownership = {
			taskId: owned.taskId,
			parentSessionId: this.#options.parentSessionId,
			childSessionId: owned.childSessionId,
		};
		try {
			const result = await owned.handle.run(
				prompt,
				owned.abortController.signal,
				(event) => this.#recordEvent(owned, event),
			);
			const current = this.#options.taskStore.get(owned.taskId);
			if (current?.status === "running") {
				const report = result.report.slice(0, SUBAGENT_TASK_REPORT_MAX_CHARS);
				const usage = normalizedUsage(result.usage, owned.usage);
				if (result.status === "completed") {
					this.#options.taskStore.complete({
						...ownership,
						report,
						outputReference: `subagent-task:${owned.taskId}`,
						usage,
					});
				} else if (result.status === "failed") {
					this.#options.taskStore.fail({
						...ownership,
						error: "child runtime failed",
						report,
						outputReference: `subagent-task:${owned.taskId}`,
						usage,
					});
				} else {
					this.#options.taskStore.interrupt({
						...ownership,
						reason: "child runtime interrupted",
						report,
						outputReference: `subagent-task:${owned.taskId}`,
						usage,
					});
				}
			}
		} catch {
			const current = this.#options.taskStore.get(owned.taskId);
			if (current?.status === "running") {
				if (owned.abortController.signal.aborted) {
					this.#options.taskStore.interrupt({ ...ownership, reason: "child runtime interrupted" });
				} else {
					this.#options.taskStore.fail({ ...ownership, error: "child runtime failed" });
				}
			}
		} finally {
			await owned.closeOnce().catch(() => undefined);
			this.#owned.delete(owned.childSessionId);
		}
		return terminalResult(this.#options.taskStore.get(owned.taskId), owned.childSessionId);
	}

	#recordEvent(owned: OwnedChild, event: ChildRuntimeEvent): void {
		if (event.type === "usage") {
			owned.usage = normalizedUsage(event.usage, owned.usage);
			return;
		}
		owned.progressSequence += 1;
		this.#options.taskStore.updateProgress({
			taskId: owned.taskId,
			parentSessionId: this.#options.parentSessionId,
			childSessionId: owned.childSessionId,
			sequence: owned.progressSequence,
			summary: event.summary.slice(0, SUBAGENT_TASK_PROGRESS_MAX_CHARS),
			...(Object.keys(owned.usage).length > 0 ? { usage: owned.usage } : {}),
		});
	}

	#interruptRecord(owned: OwnedChild, reason: string): void {
		const record = this.#options.taskStore.get(owned.taskId);
		if (record?.status !== "running") return;
		this.#options.taskStore.interrupt({
			taskId: owned.taskId,
			parentSessionId: this.#options.parentSessionId,
			childSessionId: owned.childSessionId,
			reason,
		});
	}

	async #closeAll(): Promise<void> {
		const owned = [...this.#owned.values()];
		await Promise.all(owned.map(async (child) => {
			child.abortController.abort();
			this.#interruptRecord(child, "parent shutdown");
			await bounded(
				Promise.allSettled([
					child.handle.interrupt("parent shutdown"),
					child.closeOnce(),
					...(child.completion ? [child.completion] : []),
				]).then(() => undefined),
				this.#options.shutdownTimeoutMs,
			);
		}));
	}
}

function outputFromRecord(record: SubagentTaskRecord): SubagentOutputResult {
	return Object.freeze({
		found: true,
		childSessionId: record.childSessionId,
		taskId: record.taskId,
		status: record.status,
		progressSequence: record.progressSequence,
		...(record.payload.progressSummary ? { progressSummary: record.payload.progressSummary } : {}),
		...(record.payload.report !== undefined ? { report: record.payload.report } : {}),
		...(record.payload.outputReference ? { outputReference: record.payload.outputReference } : {}),
		...(record.payload.error ? { error: record.payload.error } : {}),
	});
}

function terminalResult(
	record: SubagentTaskRecord | undefined,
	childSessionId: string,
): SubagentStartResult {
	if (!record) {
		return Object.freeze({
			status: "failed",
			taskId: "unavailable",
			childSessionId,
			summary: "Subagent failed",
			error: "child runtime failed",
		});
	}
	if (record.status === "completed") {
		return Object.freeze({
			status: record.status,
			taskId: record.taskId,
			childSessionId,
			summary: "Subagent completed",
			report: record.payload.report ?? "",
		});
	}
	if (record.status === "interrupted") {
		return Object.freeze({
			status: record.status,
			taskId: record.taskId,
			childSessionId,
			summary: "Subagent interrupted",
			...(record.payload.report !== undefined ? { report: record.payload.report } : {}),
			error: "child runtime interrupted",
		});
	}
	return Object.freeze({
		status: "failed",
		taskId: record.taskId,
		childSessionId,
		summary: "Subagent failed",
		...(record.payload.report !== undefined ? { report: record.payload.report } : {}),
		error: "child runtime failed",
	});
}

function hasBudget(budget: SubagentBudget): boolean {
	return budget.maxTurns !== undefined
		|| budget.maxToolCalls !== undefined
		|| budget.noProgressTurnLimit !== undefined;
}

function normalizedUsage(
	value: Readonly<Record<string, number>>,
	fallback: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
	const entries = Object.entries(value).filter(([key, amount]) =>
		key.length > 0
		&& key.length <= 64
		&& Number.isFinite(amount)
		&& amount >= 0
	).slice(0, 64);
	return Object.freeze(entries.length > 0 ? Object.fromEntries(entries) : { ...fallback });
}

function positiveTimeout(value: number | undefined): number {
	const selected = value ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	if (!Number.isSafeInteger(selected) || selected <= 0 || selected > MAX_SHUTDOWN_TIMEOUT_MS) {
		throw new TypeError("invalid subagent shutdown timeout");
	}
	return selected;
}

function unavailableMessage(childSessionId: string): SubagentMessageResult {
	return Object.freeze({ accepted: false, childSessionId, delivery: "unavailable" });
}

function onceAsync(operation: () => Promise<void>): () => Promise<void> {
	let result: Promise<void> | undefined;
	return () => result ??= operation();
}

async function bounded(operation: Promise<void>, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		operation.catch(() => undefined),
		new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
	]);
	if (timer) clearTimeout(timer);
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

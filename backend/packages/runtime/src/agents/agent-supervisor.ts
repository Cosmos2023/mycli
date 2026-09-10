import { randomUUID } from "node:crypto";
import type {
	AgentBudgetExhaustionKind,
	AgentCanonicalEvent,
	AgentLifecycleEvent,
	AgentPath,
	AgentSpawnConfigSnapshot,
	AgentTaskEventContext,
} from "@mycli/core";
import {
	AgentCapacityError,
	AgentDepthError,
	DEFAULT_SUBAGENT_ROLE,
	agentThreadId,
	parseAgentPath,
} from "@mycli/core";
import type {
	AgentLifecycleStore,
	AgentLifecycleTransition,
	AgentThreadRecord,
	AgentThreadStore,
	SubagentTaskRecord,
	SubagentTaskStore,
} from "@mycli/storage";
import { AgentScheduler } from "./agent-scheduler.ts";
import type { ProviderStepExecutor } from "../providers/provider-step-executor.ts";
import {
	SUBAGENT_TASK_PROGRESS_MAX_CHARS,
	SUBAGENT_TASK_REPORT_MAX_CHARS,
} from "@mycli/storage";

export interface AgentThreadRuntimeCreateInput {
	readonly purpose?: "spawn" | "reload";
	readonly parentSessionId: string;
	readonly parentTurnId: string;
	readonly childSessionId: string;
	readonly threadId: string;
	readonly rootThreadId: string;
	readonly parentThreadId: string;
	readonly path: AgentPath;
	readonly config: AgentSpawnConfigSnapshot;
	readonly model?: string;
	readonly tools: readonly string[];
	readonly budget?: Readonly<{
		readonly maxTurns?: number;
		readonly maxToolCalls?: number;
		readonly maxTokens?: number;
		readonly noProgressTurnLimit?: number;
		readonly wallClockMs?: number;
	}>;
}

export type AgentThreadRuntimeEvent =
	| { readonly type: "progress"; readonly summary: string }
	| { readonly type: "usage"; readonly usage: Readonly<Record<string, number>> }
	| {
		readonly type: "waiting";
		readonly reason: "approval" | "clarification";
		readonly summary: string;
	}
	| { readonly type: "resumed"; readonly summary: string };

export interface AgentThreadRuntimeResult {
	readonly status: "completed" | "failed" | "interrupted";
	readonly report: string;
	readonly usage: Readonly<Record<string, number>>;
	readonly budgetExhausted?: AgentBudgetExhaustionKind;
}

export interface AgentThreadRuntimeHandle {
	run(
		prompt: string,
		signal: AbortSignal,
		emit: (event: AgentThreadRuntimeEvent) => void,
		turnId: string,
	): Promise<AgentThreadRuntimeResult>;
	runMailbox?(
		signal: AbortSignal,
		emit: (event: AgentThreadRuntimeEvent) => void,
		turnId: string,
	): Promise<AgentThreadRuntimeResult>;
	bindProviderStepExecutor?(executor: ProviderStepExecutor | undefined): void;
	forceInterrupt?(reason: string, turnId: string): Promise<boolean>;
	recoverInterrupt?(reason: string, turnId: string): Promise<boolean>;
	markIdle?(): void | Promise<void>;
	send(message: string): Promise<void>;
	interrupt(reason: string): Promise<void>;
	close(): Promise<void>;
}

export interface AgentThreadRuntimeFactory {
	create(input: AgentThreadRuntimeCreateInput): Promise<AgentThreadRuntimeHandle>;
}

export interface SpawnSupervisedAgentInput {
	readonly parentSessionId: string;
	readonly parentTurnId: string;
	readonly parentThreadId: string;
	readonly rootThreadId: string;
	readonly parentPath: AgentPath;
	readonly taskName: string;
	readonly prompt: string;
	readonly mode?: "foreground" | "background";
	readonly config: AgentSpawnConfigSnapshot;
	readonly model?: string;
	readonly taskId?: string;
	readonly childSessionId?: string;
}

export type SupervisedAgentStartResult =
	| {
		readonly status: "running";
		readonly taskId: string;
		readonly childSessionId: string;
		readonly taskName: string;
		readonly agentPath: AgentPath;
		readonly summary: string;
	}
	| {
		readonly status: "completed" | "failed" | "interrupted";
		readonly taskId: string;
		readonly childSessionId: string;
		readonly taskName: string;
		readonly agentPath: AgentPath;
		readonly summary: string;
		readonly report?: string;
		readonly error?: string;
	};

export type SupervisedAgentOutputResult =
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

export interface SupervisedAgentMessageResult {
	readonly accepted: boolean;
	readonly childSessionId: string;
	readonly delivery: "accepted" | "unavailable";
}

export interface AgentSupervisorOptions {
	readonly lifecycleStore: AgentLifecycleStore;
	readonly threadStore: AgentThreadStore;
	readonly taskStore: SubagentTaskStore;
	readonly runtimeFactory: AgentThreadRuntimeFactory;
	readonly createTaskId?: () => string;
	readonly createThreadId?: () => string;
	readonly createEventId?: () => string;
	readonly createTurnId?: () => string;
	readonly clock?: () => string;
	readonly shutdownTimeoutMs?: number;
	readonly maxResidents?: number;
	readonly maxDepth?: number;
	readonly onEvent?: (event: AgentCanonicalEvent) => void | Promise<void>;
}

interface ResidentAgent {
	taskId: string;
	readonly parentSessionId: string;
	parentTurnId: string;
	thread: AgentThreadRecord;
	readonly handle: AgentThreadRuntimeHandle;
	abortController: AbortController;
	readonly closeOnce: () => Promise<void>;
	progressSequence: number;
	usage: Readonly<Record<string, number>>;
	terminalPublished: boolean;
	finalizing: boolean;
	interruption?: ResidentInterruption;
	pendingFollowUp?: PendingAgentFollowUp;
	completion?: Promise<SupervisedAgentStartResult>;
}

interface ResidentInterruption {
	readonly reason: string;
	readonly settled: Promise<boolean>;
}

interface PendingAgentFollowUp {
	readonly parentTurnId: string;
	readonly description: string;
}

export class AgentRuntimePool {
	readonly #residents = new Map<string, ResidentAgent>();

	add(resident: ResidentAgent): void {
		if (this.#residents.has(resident.thread.threadId)) {
			throw new Error("agent_runtime_already_resident");
		}
		this.#residents.set(resident.thread.threadId, resident);
	}

	get(threadId: string): ResidentAgent | undefined {
		return this.#residents.get(threadId);
	}

	remove(threadId: string): ResidentAgent | undefined {
		const resident = this.#residents.get(threadId);
		this.#residents.delete(threadId);
		return resident;
	}

	list(): readonly ResidentAgent[] {
		return Object.freeze([...this.#residents.values()]);
	}
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 60_000;

export class AgentSupervisor {
	readonly #options: Required<Pick<
		AgentSupervisorOptions,
		"createTaskId" | "createThreadId" | "createEventId" | "createTurnId" | "clock" | "shutdownTimeoutMs"
	>> & Omit<
		AgentSupervisorOptions,
		"createTaskId" | "createThreadId" | "createEventId" | "createTurnId" | "clock" | "shutdownTimeoutMs"
	>;
	readonly #pool = new AgentRuntimePool();
	readonly #scheduler: AgentScheduler;
	#closing: Promise<void> | undefined;

	constructor(options: AgentSupervisorOptions) {
		this.#options = {
			...options,
			createTaskId: options.createTaskId ?? randomUUID,
			createThreadId: options.createThreadId ?? randomUUID,
			createEventId: options.createEventId ?? randomUUID,
			createTurnId: options.createTurnId ?? randomUUID,
			clock: options.clock ?? (() => new Date().toISOString()),
			shutdownTimeoutMs: positiveTimeout(options.shutdownTimeoutMs),
		};
		this.#scheduler = new AgentScheduler({
			...(options.maxResidents === undefined ? {} : { maxResidents: options.maxResidents }),
			...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
		});
	}

	async spawn(input: SpawnSupervisedAgentInput): Promise<SupervisedAgentStartResult> {
		const taskId = input.taskId ?? this.#options.createTaskId();
		const childSessionId = input.childSessionId ?? this.#options.createThreadId();
		const mode = input.mode ?? "background";
		const description = input.prompt.trim().slice(0, SUBAGENT_TASK_PROGRESS_MAX_CHARS);
		if (!description) return spawnFailure(taskId, childSessionId, input.taskName, input.parentPath);
		try {
			this.#scheduler.assertChildDepth(input.parentPath);
			const slot = this.#scheduler.reserve(
				childSessionId,
				this.#pool.list().map((resident) => ({
					threadId: resident.thread.threadId,
					status: resident.thread.status,
					lastActiveAt: resident.thread.lastActiveAt,
				})),
			);
			if (slot.evictThreadId) await this.#evictIdle(slot.evictThreadId);
		} catch (error) {
			return spawnFailure(
				taskId,
				childSessionId,
				input.taskName,
				input.parentPath,
				agentControlError(error),
			);
		}
		let thread: AgentThreadRecord;
		try {
			const reservation = this.#options.lifecycleStore.reserve({
				thread: {
					threadId: childSessionId,
					rootThreadId: input.rootThreadId,
					parentThreadId: input.parentThreadId,
					parentPath: input.parentPath,
					taskName: input.taskName,
					profileId: DEFAULT_SUBAGENT_ROLE,
					spawnConfig: input.config,
				},
				task: {
					taskId,
					parentSessionId: input.parentSessionId,
					parentTurnId: input.parentTurnId,
					childSessionId,
					profileId: DEFAULT_SUBAGENT_ROLE,
					mode,
					description,
				},
			});
			thread = reservation.thread;
			await this.#emit("reserved", thread, undefined, reservation.task);
		} catch {
			this.#scheduler.release(childSessionId);
			return spawnFailure(taskId, childSessionId, input.taskName, input.parentPath);
		}

		let handle: AgentThreadRuntimeHandle;
		try {
			handle = await this.#options.runtimeFactory.create(deepFreeze({
				parentSessionId: input.parentSessionId,
				parentTurnId: input.parentTurnId,
				childSessionId,
				threadId: childSessionId,
				rootThreadId: input.rootThreadId,
				parentThreadId: input.parentThreadId,
				path: thread.path,
				config: input.config,
				...(input.model ? { model: input.model } : {}),
				tools: [...input.config.tools],
				...(input.config.budget ? { budget: { ...input.config.budget } } : {}),
			}));
		} catch {
			return this.#failSpawn(thread, taskId, input, "child runtime failed");
		}

		const ownership = {
			taskId,
			parentSessionId: input.parentSessionId,
			childSessionId,
		};
		const abortController = new AbortController();
		const resident: ResidentAgent = {
			taskId,
			parentSessionId: input.parentSessionId,
			parentTurnId: input.parentTurnId,
			thread,
			handle,
			abortController,
			closeOnce: onceAsync(() => handle.close()),
			progressSequence: 0,
			usage: Object.freeze({}),
				terminalPublished: false,
				finalizing: false,
			};
		let activation: AgentLifecycleTransition;
		try {
			activation = this.#options.lifecycleStore.activate(ownership);
			resident.thread = activation.thread;
			this.#pool.add(resident);
		} catch {
			await resident.closeOnce().catch(() => undefined);
			return this.#failSpawn(thread, taskId, input, "child runtime failed");
		}
		await this.#emit("spawned", activation.thread, undefined, activation.task);
		await this.#emit("started", activation.thread, undefined, activation.task);
		resident.completion = this.#runResident(resident, input.prompt);

		if (mode === "foreground") return resident.completion;
		return Object.freeze({
			status: "running",
			taskId,
			childSessionId,
			taskName: activation.thread.taskName,
			agentPath: activation.thread.path,
			summary: "Subagent started in background",
		});
	}

	output(childSessionId: string, parentSessionId: string): SupervisedAgentOutputResult {
		const record = this.#options.taskStore.getByChildSession(parentSessionId, childSessionId);
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

	async send(
		childSessionId: string,
		message: string,
		parentSessionId: string,
	): Promise<SupervisedAgentMessageResult> {
		const resident = this.#pool.get(childSessionId);
		if (resident?.parentSessionId !== parentSessionId) return unavailableMessage(childSessionId);
		const task = this.#options.taskStore.getByChildSession(parentSessionId, childSessionId);
		if (!resident || task?.status !== "running") return unavailableMessage(childSessionId);
		try {
			await resident.handle.send(message);
			return Object.freeze({ accepted: true, childSessionId, delivery: "accepted" });
		} catch {
			return unavailableMessage(childSessionId);
		}
	}

	async interrupt(childSessionId: string, reason = "parent interrupted child"): Promise<boolean> {
		const resident = this.#pool.get(childSessionId);
		const thread = this.#options.threadStore.get(childSessionId);
		if (!thread) return false;
		if (resident) {
			const interruption = this.#beginResidentInterruption(resident, reason);
			if (!await interruption.settled) return false;
			this.#terminalizeResidentInterruption(resident, interruption.reason);
			await this.#publishResidentTerminal(resident);
			this.#pool.remove(childSessionId);
			this.#scheduler.release(childSessionId);
		} else if (thread.status !== "completed"
			&& thread.status !== "failed"
			&& thread.status !== "interrupted") {
			const task = this.#options.taskStore.getLatestByChildSession(childSessionId);
			if (task && (task.status === "queued" || task.status === "running")) {
				this.#options.lifecycleStore.interruptRun({
					taskId: task.taskId,
					parentSessionId: task.parentSessionId,
					childSessionId,
					reason: boundedSummary(reason),
				});
			} else {
				this.#options.threadStore.transition({
					threadId: childSessionId,
					status: "interrupted",
					terminalSummary: boundedSummary(reason),
				});
			}
		}
		return true;
	}

	async waitFor(childSessionId: string): Promise<void> {
		await this.#pool.get(childSessionId)?.completion;
	}

	async followUp(
		childSessionId: string,
		parentTurnId: string,
		description = "Agent follow-up",
	): Promise<boolean> {
		const thread = this.#options.threadStore.get(childSessionId);
		if (!thread?.spawnConfig) return false;
		const pending = Object.freeze({
			parentTurnId: parentTurnId.trim().slice(0, 256) || this.#options.createEventId(),
			description: description.trim().slice(0, SUBAGENT_TASK_PROGRESS_MAX_CHARS)
				|| "Agent follow-up",
		});
		let resident = this.#pool.get(childSessionId);
		if (resident && (resident.finalizing
			|| resident.thread.status === "running"
			|| resident.thread.status === "waiting")) {
			resident.pendingFollowUp ??= pending;
			return true;
		}
		if (!resident && (thread.status === "idle"
			|| thread.status === "unloaded"
			|| recoverableInterruptedThread(thread))) {
			resident = await this.#loadResident(thread, pending.parentTurnId);
		}
		if (!resident || resident.thread.status !== "idle") return false;
		return this.#startResidentFollowUp(resident, pending);
	}

	async unload(childSessionId: string): Promise<boolean> {
		const resident = this.#pool.get(childSessionId);
		const thread = this.#options.threadStore.get(childSessionId);
		if (!resident || !thread || thread.status !== "idle") return false;
		await resident.closeOnce().catch(() => undefined);
		this.#pool.remove(childSessionId);
		this.#scheduler.release(childSessionId);
		const unloaded = this.#options.threadStore.transition({
			threadId: childSessionId,
			status: "unloaded",
		});
		await this.#emit("unloaded", unloaded);
		return true;
	}

	list(rootThreadId: string, pathPrefix?: AgentPath): readonly AgentThreadRecord[] {
		return this.#options.threadStore.list({
			rootThreadId,
			...(pathPrefix ? { pathPrefix: parseAgentPath(pathPrefix) } : {}),
		});
	}

	recoverLegacyAbandoned(parentSessionId: string, reason: string): number {
		let interrupted = 0;
		for (const task of this.#options.taskStore.list(parentSessionId, 1_000)) {
			if (task.status !== "running") continue;
			const thread = this.#options.threadStore.get(task.childSessionId);
			if (thread?.spawnConfig) continue;
			this.#options.taskStore.interrupt({
				taskId: task.taskId,
				parentSessionId: task.parentSessionId,
				childSessionId: task.childSessionId,
				reason: boundedSummary(reason),
			});
			interrupted += 1;
		}
		return interrupted;
	}

	close(): Promise<void> {
		this.#closing ??= this.#closeAll();
		return this.#closing;
	}

	async #runResident(
		resident: ResidentAgent,
		prompt: string,
		mailboxTriggered = false,
	): Promise<SupervisedAgentStartResult> {
		const ownership = {
			taskId: resident.taskId,
			parentSessionId: resident.parentSessionId,
			childSessionId: resident.thread.threadId,
		};
		let wallClockExhausted = false;
		let interruptionCleanupFailed = false;
		let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
		const wallClockMs = resident.thread.spawnConfig?.budget?.wallClockMs;
		if (wallClockMs !== undefined) {
			wallClockTimer = setTimeout(() => {
				wallClockExhausted = true;
				this.#beginResidentInterruption(resident, "agent budget exhausted: wall_clock");
			}, wallClockMs);
		}
		try {
			const turnId = this.#options.createTurnId();
			const runtimeResult = mailboxTriggered && resident.handle.runMailbox
				? await resident.handle.runMailbox(
					resident.abortController.signal,
					(event) => this.#recordRuntimeEvent(resident, event),
					turnId,
				)
				: await resident.handle.run(
					prompt,
					resident.abortController.signal,
					(event) => this.#recordRuntimeEvent(resident, event),
					turnId,
				);
			const result: AgentThreadRuntimeResult = wallClockExhausted
				? Object.freeze({
					status: "failed",
					report: "Subagent budget exhausted: wall_clock",
					usage: runtimeResult.usage,
					budgetExhausted: "wall_clock",
				})
				: runtimeResult;
			if (resident.interruption) {
				interruptionCleanupFailed = !await resident.interruption.settled;
				if (!interruptionCleanupFailed && !wallClockExhausted) {
					this.#terminalizeResidentInterruption(resident, resident.interruption.reason);
				}
			}
			const current = this.#options.taskStore.get(resident.taskId);
			const runtimeTerminalConfirmed = result.status !== "interrupted";
			if ((!interruptionCleanupFailed || runtimeTerminalConfirmed)
				&& current?.status === "running") {
				const report = result.report.slice(0, SUBAGENT_TASK_REPORT_MAX_CHARS);
				const usage = normalizedUsage(result.usage, resident.usage);
				if (result.status === "completed") {
					const terminal = this.#options.lifecycleStore.completeRun({
						...ownership,
						report,
						outputReference: `subagent-task:${resident.taskId}`,
						usage,
					});
					resident.thread = terminal.thread;
					await resident.handle.markIdle?.();
				} else if (result.status === "failed") {
					const error = result.budgetExhausted
						? `agent_budget_exhausted: ${result.budgetExhausted}`
						: "child runtime failed";
					const terminal = this.#options.lifecycleStore.failRun({
						...ownership,
						error,
						report,
						outputReference: `subagent-task:${resident.taskId}`,
						usage,
					});
					resident.thread = terminal.thread;
				} else {
					const terminal = this.#options.lifecycleStore.interruptRun({
						...ownership,
						reason: "child runtime interrupted",
						report,
						outputReference: `subagent-task:${resident.taskId}`,
						usage,
					});
					resident.thread = terminal.thread;
				}
			}
		} catch {
			if (resident.interruption) {
				interruptionCleanupFailed = !await resident.interruption.settled;
				if (!interruptionCleanupFailed && !wallClockExhausted) {
					this.#terminalizeResidentInterruption(resident, resident.interruption.reason);
				}
			}
			const current = this.#options.taskStore.get(resident.taskId);
			if (!interruptionCleanupFailed && current?.status === "running") {
				if (wallClockExhausted) {
					const error = "agent_budget_exhausted: wall_clock";
					const terminal = this.#options.lifecycleStore.failRun({
						...ownership,
						error,
						report: "Subagent budget exhausted: wall_clock",
					});
					resident.thread = terminal.thread;
				} else if (resident.abortController.signal.aborted) {
					const terminal = this.#options.lifecycleStore.interruptRun({
						...ownership,
						reason: "child runtime interrupted",
					});
					resident.thread = terminal.thread;
				} else {
					const terminal = this.#options.lifecycleStore.failRun({
						...ownership,
						error: "child runtime failed",
					});
					resident.thread = terminal.thread;
				}
			}
		} finally {
			resident.finalizing = true;
			if (wallClockTimer) clearTimeout(wallClockTimer);
			await this.#publishResidentTerminal(resident);
			if (resident.thread.status === "failed" || resident.thread.status === "interrupted") {
				await resident.closeOnce().catch(() => undefined);
				this.#pool.remove(resident.thread.threadId);
				this.#scheduler.release(resident.thread.threadId);
			}
			resident.finalizing = false;
		}
		const result = terminalResult(
			this.#options.taskStore.get(resident.taskId),
			resident.thread,
		);
		const pendingFollowUp = resident.thread.status === "idle"
			? resident.pendingFollowUp
			: undefined;
		resident.pendingFollowUp = undefined;
		if (pendingFollowUp) {
			queueMicrotask(() => {
				void this.#startResidentFollowUp(resident, pendingFollowUp);
			});
		}
		return result;
	}

	async #loadResident(
		thread: AgentThreadRecord,
		parentTurnId: string,
	): Promise<ResidentAgent | undefined> {
		const previousTask = this.#options.taskStore.getLatestByChildSession(thread.threadId);
		if (!previousTask || !thread.spawnConfig) return undefined;
		try {
			const slot = this.#scheduler.reserve(
				thread.threadId,
				this.#pool.list().map((candidate) => ({
					threadId: candidate.thread.threadId,
					status: candidate.thread.status,
					lastActiveAt: candidate.thread.lastActiveAt,
				})),
			);
			if (slot.evictThreadId) await this.#evictIdle(slot.evictThreadId);
		} catch {
			return undefined;
		}
		let handle: AgentThreadRuntimeHandle;
		try {
			handle = await this.#options.runtimeFactory.create(deepFreeze({
				purpose: "reload",
				parentSessionId: previousTask.parentSessionId,
				parentTurnId,
				childSessionId: thread.threadId,
				threadId: thread.threadId,
				rootThreadId: thread.rootThreadId,
				parentThreadId: thread.parentThreadId,
				path: thread.path,
				config: thread.spawnConfig,
				model: thread.spawnConfig.provider.model,
				tools: [...thread.spawnConfig.tools],
				...(thread.spawnConfig.budget ? { budget: { ...thread.spawnConfig.budget } } : {}),
			}));
		} catch {
			this.#scheduler.release(thread.threadId);
			return undefined;
		}
		const loaded = this.#options.threadStore.transition({
			threadId: thread.threadId,
			status: "idle",
		});
		const resident: ResidentAgent = {
			taskId: previousTask.taskId,
			parentSessionId: previousTask.parentSessionId,
			parentTurnId,
			thread: loaded,
			handle,
			abortController: new AbortController(),
			closeOnce: onceAsync(() => handle.close()),
			progressSequence: 0,
			usage: Object.freeze({}),
			terminalPublished: true,
			finalizing: false,
		};
		this.#pool.add(resident);
		await this.#emit("loaded", loaded, undefined, previousTask);
		return resident;
	}

	async #startResidentFollowUp(
		resident: ResidentAgent,
		pending: PendingAgentFollowUp,
	): Promise<boolean> {
		if (resident.finalizing || resident.thread.status !== "idle") {
			resident.pendingFollowUp ??= pending;
			return resident.thread.status === "running" || resident.finalizing;
		}
		const taskId = this.#options.createTaskId();
		const ownership = {
			taskId,
			parentSessionId: resident.parentSessionId,
			childSessionId: resident.thread.threadId,
		};
		try {
			const activation = this.#options.lifecycleStore.startFollowUp({
				...ownership,
				parentTurnId: pending.parentTurnId,
				profileId: resident.thread.profileId,
				mode: "background",
				description: pending.description,
			});
			resident.taskId = taskId;
			resident.parentTurnId = pending.parentTurnId;
			resident.thread = activation.thread;
			resident.abortController = new AbortController();
			resident.progressSequence = 0;
			resident.usage = Object.freeze({});
			resident.terminalPublished = false;
			resident.finalizing = false;
			resident.interruption = undefined;
			await this.#emit(
				"started",
				activation.thread,
				"Subagent follow-up started",
				activation.task,
			);
			resident.completion = this.#runResident(resident, "", true);
			return true;
		} catch {
			return false;
		}
	}

	async #failSpawn(
		thread: AgentThreadRecord,
		taskId: string,
		input: SpawnSupervisedAgentInput,
		error: string,
	): Promise<SupervisedAgentStartResult> {
		const ownership = {
			taskId,
			parentSessionId: input.parentSessionId,
			childSessionId: thread.threadId,
		};
		try {
			const failed = this.#options.lifecycleStore.failSpawn({ ...ownership, error });
			await this.#emit("failed", failed.thread, "Subagent failed", failed.task);
			return terminalResult(failed.task, failed.thread);
		} catch {
			return spawnFailure(taskId, thread.threadId, input.taskName, input.parentPath, error);
		} finally {
			this.#pool.remove(thread.threadId);
			this.#scheduler.release(thread.threadId);
		}
	}

	async #evictIdle(threadId: string): Promise<void> {
		const resident = this.#pool.get(threadId);
		if (!resident || resident.thread.status !== "idle") return;
		await resident.closeOnce().catch(() => undefined);
		this.#pool.remove(threadId);
		const unloaded = this.#options.threadStore.transition({
			threadId,
			status: "unloaded",
		});
		await this.#emit("unloaded", unloaded);
	}

	#recordRuntimeEvent(resident: ResidentAgent, event: AgentThreadRuntimeEvent): void {
		if (event.type === "usage") {
			resident.usage = normalizedUsage(event.usage, resident.usage);
			const task = this.#options.taskStore.get(resident.taskId);
			if (task) this.#emitUsage(resident.thread, task, resident.usage);
			return;
		}
		if (event.type === "waiting") {
			const current = this.#options.threadStore.get(resident.thread.threadId);
			if (current?.status === "running") {
				resident.thread = this.#options.threadStore.transition({
					threadId: resident.thread.threadId,
					status: "waiting",
				});
				void this.#emit("waiting", resident.thread, event.summary,
					this.#options.taskStore.get(resident.taskId));
			}
			return;
		}
		if (event.type === "resumed") {
			const current = this.#options.threadStore.get(resident.thread.threadId);
			if (current?.status === "waiting") {
				resident.thread = this.#options.threadStore.transition({
					threadId: resident.thread.threadId,
					status: "running",
				});
				void this.#emit("resumed", resident.thread, event.summary,
					this.#options.taskStore.get(resident.taskId));
			}
			return;
		}
		resident.progressSequence += 1;
		const summary = event.summary.slice(0, SUBAGENT_TASK_PROGRESS_MAX_CHARS);
		const updated = this.#options.taskStore.updateProgress({
			taskId: resident.taskId,
			parentSessionId: resident.parentSessionId,
			childSessionId: resident.thread.threadId,
			sequence: resident.progressSequence,
			summary,
			...(Object.keys(resident.usage).length > 0 ? { usage: resident.usage } : {}),
		});
		this.#options.threadStore.touch(resident.thread.threadId);
		this.#emitProgress(resident.thread, updated, summary, resident.usage);
	}

	#interruptTask(resident: ResidentAgent | undefined, reason: string): void {
		if (!resident) return;
		const task = this.#options.taskStore.get(resident.taskId);
		if (task?.status !== "running") return;
		const terminal = this.#options.lifecycleStore.interruptRun({
			taskId: resident.taskId,
			parentSessionId: resident.parentSessionId,
			childSessionId: resident.thread.threadId,
			reason: boundedSummary(reason),
		});
		resident.thread = terminal.thread;
	}

	#beginResidentInterruption(resident: ResidentAgent, reason: string): ResidentInterruption {
		if (resident.interruption) return resident.interruption;
		const boundedReason = boundedSummary(reason);
		let interruptOperation: Promise<void>;
		try {
			interruptOperation = resident.handle.interrupt(boundedReason);
		} catch (error) {
			interruptOperation = Promise.reject(error);
		}
		resident.abortController.abort();
		const settled = (async () => {
			const interrupted = await bounded(
				interruptOperation,
				this.#options.shutdownTimeoutMs,
			);
			if (!interrupted) return false;
			const closed = await bounded(
				Promise.resolve().then(resident.closeOnce),
				this.#options.shutdownTimeoutMs,
			);
			return closed;
		})();
		const interruption = Object.freeze({ reason: boundedReason, settled });
		resident.interruption = interruption;
		return interruption;
	}

	#terminalizeResidentInterruption(resident: ResidentAgent, reason: string): void {
		this.#interruptTask(resident, reason);
	}

	async #publishResidentTerminal(resident: ResidentAgent): Promise<void> {
		if (resident.terminalPublished) return;
		const terminal = this.#options.taskStore.get(resident.taskId);
		if (!terminal || terminal.status === "queued" || terminal.status === "running") return;
		resident.terminalPublished = true;
		const summary = terminal.status === "completed"
			? "Subagent completed"
			: terminal.status === "interrupted"
				? "Subagent interrupted"
				: "Subagent failed";
		await this.#emit(terminal.status, resident.thread, summary, terminal);
	}

	async #emit(
		kind: AgentLifecycleEvent["kind"],
		thread: AgentThreadRecord,
		summary?: string,
		task?: SubagentTaskRecord,
	): Promise<void> {
		if (!this.#options.onEvent) return;
		try {
			await this.#options.onEvent(Object.freeze({
				type: "agent_lifecycle",
				eventId: this.#options.createEventId(),
				occurredAt: this.#options.clock(),
				kind,
				threadId: agentThreadId(thread.threadId),
				rootThreadId: agentThreadId(thread.rootThreadId),
				parentThreadId: agentThreadId(thread.parentThreadId),
				path: thread.path,
				threadStatus: thread.status,
				...(task ? {
					sourceCallId: task.parentTurnId,
					task: taskEventContext(task),
				} : {}),
				...(summary ? { summary: summary.slice(0, SUBAGENT_TASK_PROGRESS_MAX_CHARS) } : {}),
			}));
		} catch {
			// Event consumers are projections and cannot change durable lifecycle behavior.
		}
	}

	#emitProgress(
		thread: AgentThreadRecord,
		task: SubagentTaskRecord,
		summary: string,
		usage: Readonly<Record<string, number>>,
	): void {
		this.#emitTaskEvent(Object.freeze({
			type: "agent_progress",
			kind: "progress",
			progressSequence: task.progressSequence,
			summary,
			usage,
		}), thread, task);
	}

	#emitUsage(
		thread: AgentThreadRecord,
		task: SubagentTaskRecord,
		usage: Readonly<Record<string, number>>,
	): void {
		this.#emitTaskEvent(Object.freeze({
			type: "agent_usage",
			kind: "usage",
			usage,
		}), thread, task);
	}

	#emitTaskEvent(
		event: Readonly<Record<string, unknown>>,
		thread: AgentThreadRecord,
		task: SubagentTaskRecord,
	): void {
		if (!this.#options.onEvent) return;
		try {
			void Promise.resolve(this.#options.onEvent(Object.freeze({
				...event,
				eventId: this.#options.createEventId(),
				occurredAt: this.#options.clock(),
				threadId: agentThreadId(thread.threadId),
				rootThreadId: agentThreadId(thread.rootThreadId),
				parentThreadId: agentThreadId(thread.parentThreadId),
				path: thread.path,
				sourceCallId: task.parentTurnId,
				task: taskEventContext(task),
			}) as AgentCanonicalEvent)).catch(() => undefined);
		} catch {
			// Event consumers are projections and cannot change durable task behavior.
		}
	}

	async #closeAll(): Promise<void> {
		await Promise.all(this.#pool.list().map(async (resident) => {
			const thread = this.#options.threadStore.get(resident.thread.threadId);
			if (thread?.status === "running" || thread?.status === "waiting" || thread?.status === "queued") {
				await this.interrupt(resident.thread.threadId, "parent shutdown");
				return;
			}
			await resident.closeOnce().catch(() => undefined);
			this.#pool.remove(resident.thread.threadId);
			this.#scheduler.release(resident.thread.threadId);
			if (thread?.status === "idle") {
				const unloaded = this.#options.threadStore.transition({
					threadId: thread.threadId,
					status: "unloaded",
				});
				await this.#emit("unloaded", unloaded);
			}
		}));
	}
}

function outputFromRecord(record: SubagentTaskRecord): SupervisedAgentOutputResult {
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

function taskEventContext(record: SubagentTaskRecord): AgentTaskEventContext {
	return Object.freeze({
		taskId: record.taskId,
		parentSessionId: record.parentSessionId,
		parentTurnId: record.parentTurnId,
		profileId: record.profileId,
		taskStatus: record.status,
	});
}

function terminalResult(
	record: SubagentTaskRecord | undefined,
	thread: AgentThreadRecord,
): SupervisedAgentStartResult {
	if (record?.status === "completed") {
		return Object.freeze({
			status: "completed",
			taskId: record.taskId,
			childSessionId: record.childSessionId,
			taskName: thread.taskName,
			agentPath: thread.path,
			summary: "Subagent completed",
			report: record.payload.report ?? "",
		});
	}
	if (record?.status === "interrupted") {
		return Object.freeze({
			status: "interrupted",
			taskId: record.taskId,
			childSessionId: record.childSessionId,
			taskName: thread.taskName,
			agentPath: thread.path,
			summary: "Subagent interrupted",
			...(record.payload.report !== undefined ? { report: record.payload.report } : {}),
			error: "child runtime interrupted",
		});
	}
	return Object.freeze({
		status: "failed",
		taskId: record?.taskId ?? "unavailable",
		childSessionId: record?.childSessionId ?? thread.threadId,
		taskName: thread.taskName,
		agentPath: thread.path,
		summary: "Subagent failed",
		...(record?.payload.report !== undefined ? { report: record.payload.report } : {}),
		error: record?.payload.error ?? "child runtime failed",
	});
}

function spawnFailure(
	taskId: string,
	childSessionId: string,
	taskName: string,
	parentPath: AgentPath,
	error = "child runtime failed",
): SupervisedAgentStartResult {
	return Object.freeze({
		status: "failed",
		taskId,
		childSessionId,
		taskName,
		agentPath: parentPath,
		summary: "Subagent failed",
		error,
	});
}

function agentControlError(error: unknown): string {
	if (error instanceof AgentCapacityError || error instanceof AgentDepthError) return error.message;
	return "child runtime failed";
}

function unavailableMessage(childSessionId: string): SupervisedAgentMessageResult {
	return Object.freeze({ accepted: false, childSessionId, delivery: "unavailable" });
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

function recoverableInterruptedThread(thread: AgentThreadRecord): boolean {
	return thread.status === "interrupted"
		&& thread.terminalSummary?.startsWith("agent runtime owner unavailable") === true;
}

function boundedSummary(value: string): string {
	return value.trim().slice(0, SUBAGENT_TASK_REPORT_MAX_CHARS) || "agent interrupted";
}

function positiveTimeout(value: number | undefined): number {
	const selected = value ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	if (!Number.isSafeInteger(selected) || selected <= 0 || selected > MAX_SHUTDOWN_TIMEOUT_MS) {
		throw new TypeError("invalid agent supervisor shutdown timeout");
	}
	return selected;
}

function onceAsync(operation: () => Promise<void>): () => Promise<void> {
	let result: Promise<void> | undefined;
	return () => result ??= operation();
}

async function bounded(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation.then(() => true, () => false),
			new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

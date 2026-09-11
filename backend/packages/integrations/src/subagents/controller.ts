import { randomUUID } from "node:crypto";
import {
	agentPathDepth,
	isAgentPathWithin,
	parseAgentForkTurns,
	parseAgentPath,
	rootAgentPath,
} from "@mycli/core";
import type {
	AgentBudgetExhaustionKind,
	AgentMailboxPayload,
	AgentMailboxRecord,
	AgentMailboxTriggerMode,
	AgentPath,
	AgentSpawnConfigSnapshot,
	AgentThreadId,
} from "@mycli/core";
import type {
	AgentThreadRecord,
	SubagentTaskRecord,
} from "@mycli/storage";
import { resolveChildTools } from "./tool-scope.ts";

export interface ChildRuntimeCreateInput {
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

export type ChildRuntimeEvent =
	| { readonly type: "progress"; readonly summary: string }
	| { readonly type: "usage"; readonly usage: Readonly<Record<string, number>> }
	| {
		readonly type: "waiting";
		readonly reason: "approval" | "clarification";
		readonly summary: string;
	}
	| { readonly type: "resumed"; readonly summary: string };

export interface ChildRuntimeResult {
	readonly status: "completed" | "failed" | "interrupted";
	readonly report: string;
	readonly usage: Readonly<Record<string, number>>;
	readonly budgetExhausted?: AgentBudgetExhaustionKind;
}

export interface ChildRuntimeHandle {
	run(
		prompt: string,
		signal: AbortSignal,
		emit: (event: ChildRuntimeEvent) => void,
		turnId: string,
	): Promise<ChildRuntimeResult>;
	runMailbox?(
		signal: AbortSignal,
		emit: (event: ChildRuntimeEvent) => void,
		turnId: string,
	): Promise<ChildRuntimeResult>;
	forceInterrupt?(reason: string, turnId: string): Promise<boolean>;
	recoverInterrupt?(reason: string, turnId: string): Promise<boolean>;
	markIdle?(): void | Promise<void>;
	send(message: string): Promise<void>;
	interrupt(reason: string): Promise<void>;
	close(): Promise<void>;
}

export interface ChildRuntimeFactory {
	create(input: ChildRuntimeCreateInput): Promise<ChildRuntimeHandle>;
}

export interface StartSubagentInput {
	readonly prompt: string;
	readonly taskName?: string;
	readonly mode?: "foreground" | "background";
	readonly allowedTools?: readonly string[];
	readonly parentSessionId?: string;
	readonly parentTurnId?: string;
	readonly forkTurns?: string;
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

export interface SubagentSupervisorSpawnInput {
	readonly parentSessionId: string;
	readonly parentTurnId: string;
	readonly parentThreadId: string;
	readonly rootThreadId: string;
	readonly parentPath: AgentPath;
	readonly taskName: string;
	readonly prompt: string;
	readonly mode: "foreground" | "background";
	readonly config: AgentSpawnConfigSnapshot;
	readonly model?: string;
	readonly taskId: string;
	readonly childSessionId: string;
}

export type SubagentSupervisorStartResult = SubagentStartResult & Readonly<{
	readonly taskName: string;
	readonly agentPath: AgentPath;
}>;

export interface SubagentSupervisorContract {
	spawn(input: SubagentSupervisorSpawnInput): Promise<SubagentSupervisorStartResult>;
	output(childSessionId: string, parentSessionId: string): SubagentOutputResult;
	send(childSessionId: string, message: string, parentSessionId: string): Promise<SubagentMessageResult>;
	interrupt(childSessionId: string, reason?: string): Promise<boolean>;
	waitFor(childSessionId: string): Promise<void>;
	unload(childSessionId: string): Promise<boolean>;
	list(rootThreadId: string, pathPrefix?: AgentPath): readonly AgentThreadRecord[];
	recoverLegacyAbandoned(parentSessionId: string, reason: string): number;
	close(): Promise<void>;
}

export interface CreateSubagentSupervisorOptions {
	readonly shutdownTimeoutMs?: number;
}

export interface SubagentControlContract {
	start(input: StartSubagentInput): Promise<SubagentStartResult>;
	output(childSessionId: string, parentSessionId?: string): SubagentOutputResult;
	send(
		childSessionId: string,
		message: string,
		parentSessionId?: string,
	): Promise<SubagentMessageResult>;
}

export interface AgentCoordinationEndpoint {
	readonly threadId: AgentThreadId;
	readonly rootThreadId: AgentThreadId;
	readonly path: AgentPath;
	readonly sessionId: string;
}

export interface AgentCoordinationRouteContext {
	readonly sender: AgentCoordinationEndpoint;
	readonly root: AgentCoordinationEndpoint;
}

export interface AgentCoordinationMailboxContract {
	send(input: Readonly<{
		sender: AgentCoordinationEndpoint;
		root: AgentCoordinationEndpoint;
		target: string;
		triggerMode: AgentMailboxTriggerMode;
		logicalId: string;
		sourceCallId?: string;
		payload: AgentMailboxPayload;
	}>): Promise<Readonly<{
		disposition: "enqueued" | "duplicate";
		item: AgentMailboxRecord;
		receiver: AgentCoordinationEndpoint;
		projected: boolean;
	}>>;
	resolveTarget(
		sender: AgentCoordinationEndpoint,
		root: AgentCoordinationEndpoint,
		target: string,
	): AgentCoordinationEndpoint;
}

export interface SpawnAgentInput {
	readonly ownerSessionId: string;
	readonly ownerTurnId?: string;
	readonly taskName: string;
	readonly message: string;
	readonly forkTurns?: string;
}

export interface SendAgentCoordinationInput {
	readonly ownerSessionId: string;
	readonly target: string;
	readonly message: string;
	readonly triggerMode: AgentMailboxTriggerMode;
	readonly callId: string;
}

export interface InterruptAgentCoordinationInput {
	readonly ownerSessionId: string;
	readonly target: string;
	readonly reason?: string;
}

export interface ListAgentCoordinationInput {
	readonly ownerSessionId: string;
	readonly pathPrefix?: string;
}

export interface AgentCoordinationMessageResult {
	readonly status: "queued" | "duplicate";
	readonly messageId: string;
	readonly receiverThreadId: string;
	readonly receiverPath: AgentPath;
	readonly receiverSequence: number;
	readonly triggerMode: AgentMailboxTriggerMode;
	readonly projected: boolean;
}

export interface AgentCoordinationInterruptResult {
	readonly interrupted: boolean;
	readonly threadId: string;
	readonly path: AgentPath;
}

export interface AgentCoordinationListRow {
	readonly threadId: string;
	readonly path: AgentPath;
	readonly taskName: string;
	readonly nickname?: string;
	readonly status: AgentThreadRecord["status"];
	readonly resident: boolean;
}

export interface AgentCoordinationControlContract {
	spawnAgent(input: SpawnAgentInput): Promise<SubagentSupervisorStartResult>;
	sendAgent(input: SendAgentCoordinationInput): Promise<AgentCoordinationMessageResult>;
	interruptAgent(input: InterruptAgentCoordinationInput): Promise<AgentCoordinationInterruptResult>;
	listAgents(input: ListAgentCoordinationInput): readonly AgentCoordinationListRow[];
}

export interface ResolveSubagentSpawnContextInput {
	readonly parentSessionId: string;
	readonly parentTurnId: string;
	readonly childSessionId: string;
	readonly tools: readonly string[];
}

export interface ResolvedSubagentSpawnContext {
	readonly parentThreadId: string;
	readonly rootThreadId: string;
	readonly parentPath: AgentPath;
	readonly config: AgentSpawnConfigSnapshot;
}

export interface SubagentControllerOptions {
	readonly createSupervisor: (
		options: CreateSubagentSupervisorOptions,
	) => SubagentSupervisorContract;
	readonly parentSessionId: string;
	readonly parentTurnId: () => string;
	readonly parentTools: (input: {
		readonly parentSessionId: string;
		readonly parentTurnId: string;
	}) => readonly string[];
	readonly resolveSpawnContext: (
		input: ResolveSubagentSpawnContextInput,
	) => ResolvedSubagentSpawnContext | Promise<ResolvedSubagentSpawnContext>;
	readonly createTaskId?: () => string;
	readonly createChildSessionId?: () => string;
	readonly shutdownTimeoutMs?: number;
	readonly maxAgentDepth?: number;
	readonly mailbox?: AgentCoordinationMailboxContract;
	readonly resolveAgentRouteContext?: (
		sessionId: string,
	) => AgentCoordinationRouteContext | undefined;
}

export class SubagentController implements SubagentControlContract, AgentCoordinationControlContract {
	readonly #options: Required<Pick<
		SubagentControllerOptions,
		"createTaskId" | "createChildSessionId" | "maxAgentDepth"
	>> & Omit<SubagentControllerOptions, "createTaskId" | "createChildSessionId" | "maxAgentDepth">;
	readonly #supervisor: SubagentSupervisorContract;

	constructor(options: SubagentControllerOptions) {
		this.#options = {
			...options,
			createTaskId: options.createTaskId ?? randomUUID,
			createChildSessionId: options.createChildSessionId ?? randomUUID,
			maxAgentDepth: nonNegativeDepth(options.maxAgentDepth ?? 1),
		};
		this.#supervisor = options.createSupervisor({
			...(options.shutdownTimeoutMs === undefined
				? {}
				: { shutdownTimeoutMs: options.shutdownTimeoutMs }),
		});
	}

	async start(input: StartSubagentInput): Promise<SubagentStartResult> {
		return compatibilityStartResult(await this.#start(input));
	}

	spawnAgent(input: SpawnAgentInput): Promise<SubagentSupervisorStartResult> {
		return this.#start({
			prompt: input.message,
			taskName: input.taskName,
			mode: "background",
			parentSessionId: input.ownerSessionId,
			...(input.ownerTurnId ? { parentTurnId: input.ownerTurnId } : {}),
			...(input.forkTurns ? { forkTurns: input.forkTurns } : {}),
		});
	}

	async #start(input: StartSubagentInput): Promise<SubagentSupervisorStartResult> {
		const taskId = this.#options.createTaskId();
		const childSessionId = this.#options.createChildSessionId();
		const parentSessionId = normalizedParentSessionId(
			input.parentSessionId,
			this.#options.parentSessionId,
		);
		const parentTurnId = input.parentTurnId ?? this.#options.parentTurnId();
		const parentTools = Object.freeze([...this.#options.parentTools({
			parentSessionId,
			parentTurnId,
		})]);
		const requestedTools = input.allowedTools ?? parentTools;
		const candidateTools = resolveChildTools({
			parentTools,
			allowed: requestedTools,
			denied: [],
			allowCoordination: true,
		}).tools;
		let context: ResolvedSubagentSpawnContext;
		try {
			context = await this.#options.resolveSpawnContext({
				parentSessionId,
				parentTurnId,
				childSessionId,
				tools: candidateTools,
			});
		} catch {
			return unavailableSupervisorStart(taskId, childSessionId);
		}
		const resolvedTools = resolveChildTools({
			parentTools,
			allowed: requestedTools,
			denied: [],
			allowCoordination: agentPathDepth(context.parentPath) + 1
				< this.#options.maxAgentDepth,
		}).tools;
		context = deepFreeze({
			...context,
			config: {
				...context.config,
				tools: [...resolvedTools],
				forkTurns: parseAgentForkTurns(input.forkTurns),
			},
		});
		const result = await this.#supervisor.spawn({
			parentSessionId,
			parentTurnId,
			parentThreadId: context.parentThreadId,
			rootThreadId: context.rootThreadId,
			parentPath: context.parentPath,
			taskName: input.taskName ?? generatedTaskName(childSessionId),
			prompt: input.prompt.trim(),
			mode: input.mode ?? "background",
			config: context.config,
			taskId,
			childSessionId,
		});
		return result;
	}

	async sendAgent(input: SendAgentCoordinationInput): Promise<AgentCoordinationMessageResult> {
		const { mailbox, context } = this.#coordination(input.ownerSessionId);
		const result = await mailbox.send({
			sender: context.sender,
			root: context.root,
			target: input.target,
			triggerMode: input.triggerMode,
			logicalId: input.callId,
			sourceCallId: input.callId,
			payload: { kind: "message", text: input.message },
		});
		return Object.freeze({
			status: result.disposition === "enqueued" ? "queued" : "duplicate",
			messageId: result.item.messageId,
			receiverThreadId: result.receiver.threadId,
			receiverPath: result.receiver.path,
			receiverSequence: result.item.receiverSequence,
			triggerMode: input.triggerMode,
			projected: result.projected,
		});
	}

	async interruptAgent(
		input: InterruptAgentCoordinationInput,
	): Promise<AgentCoordinationInterruptResult> {
		const { mailbox, context } = this.#coordination(input.ownerSessionId);
		const target = mailbox.resolveTarget(context.sender, context.root, input.target);
		if (target.threadId === context.root.threadId) {
			return Object.freeze({ interrupted: false, threadId: target.threadId, path: target.path });
		}
		const interrupted = await this.#supervisor.interrupt(
			target.threadId,
			input.reason?.trim() || "agent interrupted by coordinator",
		);
		return Object.freeze({ interrupted, threadId: target.threadId, path: target.path });
	}

	listAgents(input: ListAgentCoordinationInput): readonly AgentCoordinationListRow[] {
		const { context } = this.#coordination(input.ownerSessionId);
		const prefix = input.pathPrefix === undefined ? undefined : parseAgentPath(input.pathPrefix);
		const root = Object.freeze({
			threadId: context.root.threadId,
			path: context.root.path,
			taskName: "root",
			status: "running" as const,
			resident: true,
		});
		const descendants = this.#supervisor.list(context.root.threadId, prefix).map((record) => Object.freeze({
			threadId: record.threadId,
			path: record.path,
			taskName: record.taskName,
			...(record.nickname === undefined ? {} : { nickname: record.nickname }),
			status: record.status,
			resident: !["unloaded", "completed", "failed", "interrupted"].includes(record.status),
		}));
		return Object.freeze([
			...(prefix === undefined || isAgentPathWithin(root.path, prefix) ? [root] : []),
			...descendants,
		]);
	}

	output(childSessionId: string, parentSessionId?: string): SubagentOutputResult {
		return this.#supervisor.output(
			childSessionId,
			normalizedParentSessionId(parentSessionId, this.#options.parentSessionId),
		);
	}

	send(
		childSessionId: string,
		message: string,
		parentSessionId?: string,
	): Promise<SubagentMessageResult> {
		return this.#supervisor.send(
			childSessionId,
			message,
			normalizedParentSessionId(parentSessionId, this.#options.parentSessionId),
		);
	}

	interrupt(childSessionId: string, reason?: string): Promise<boolean> {
		return this.#supervisor.interrupt(childSessionId, reason);
	}

	waitFor(childSessionId: string): Promise<void> {
		return this.#supervisor.waitFor(childSessionId);
	}

	unload(childSessionId: string): Promise<boolean> {
		return this.#supervisor.unload(childSessionId);
	}

	list(rootThreadId: string, pathPrefix?: AgentPath): readonly AgentThreadRecord[] {
		return this.#supervisor.list(rootThreadId, pathPrefix);
	}

	close(): Promise<void> {
		return this.#supervisor.close();
	}

	recoverAbandoned(reason: string): number {
		return this.#supervisor.recoverLegacyAbandoned(this.#options.parentSessionId, reason);
	}

	#coordination(ownerSessionId: string): Readonly<{
		mailbox: AgentCoordinationMailboxContract;
		context: AgentCoordinationRouteContext;
	}> {
		const mailbox = this.#options.mailbox;
		const context = this.#options.resolveAgentRouteContext?.(ownerSessionId);
		if (!mailbox || !context) throw new Error("agent_coordination_unavailable");
		return Object.freeze({ mailbox, context });
	}
}

function compatibilityStartResult(result: SubagentSupervisorStartResult): SubagentStartResult {
	return Object.freeze({
		status: result.status,
		taskId: result.taskId,
		childSessionId: result.childSessionId,
		summary: result.summary,
		...(result.report === undefined ? {} : { report: result.report }),
		...(result.error === undefined ? {} : { error: result.error }),
	});
}

function unavailableStart(
	taskId = "unavailable",
	childSessionId = "unavailable",
): SubagentStartResult {
	return Object.freeze({
		status: "failed",
		taskId,
		childSessionId,
		summary: "Subagent failed",
		error: "child runtime failed",
	});
}

function unavailableSupervisorStart(
	taskId = "unavailable",
	childSessionId = "unavailable",
): SubagentSupervisorStartResult {
	return Object.freeze({
		...unavailableStart(taskId, childSessionId),
		taskName: "unavailable",
		agentPath: rootAgentPath(),
	});
}

function generatedTaskName(childSessionId: string): string {
	const suffix = childSessionId.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")
		.replaceAll(/^-|-$/gu, "").slice(0, 16) || "agent";
	return `agent-${suffix}`;
}

function normalizedParentSessionId(value: string | undefined, fallback: string): string {
	return value?.trim() || fallback;
}

function nonNegativeDepth(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError("maxAgentDepth must be a non-negative integer");
	}
	return value;
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

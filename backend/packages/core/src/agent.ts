import { createHash } from "node:crypto";
import type {
	CanonicalConversationItem,
	ProtocolId,
	ProviderId,
	ReasoningEffort,
} from "./types.ts";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type AgentThreadId = Brand<string, "AgentThreadId">;
export type AgentPath = Brand<string, "AgentPath">;

// Persisted in legacy profile_id columns as display metadata only.
export const DEFAULT_SUBAGENT_ROLE = "subagent";

export type AgentLifecycleStatus =
	| "queued"
	| "running"
	| "waiting"
	| "idle"
	| "unloaded"
	| "completed"
	| "failed"
	| "interrupted";

export type AgentTerminalStatus = Extract<
	AgentLifecycleStatus,
	"completed" | "failed" | "interrupted"
>;

export type AgentMailboxMessageId = Brand<string, "AgentMailboxMessageId">;
export type AgentMailboxTriggerMode = "queue_only" | "follow_up";
export type AgentMailboxDeliveryState = "pending" | "queued" | "committed";

export type AgentMailboxPayload =
	| Readonly<{
		readonly kind: "message";
		readonly text: string;
	}>
	| Readonly<{
		readonly kind: "completion";
		readonly status: AgentTerminalStatus;
		readonly report: string;
		readonly outputReference?: string;
	}>;

export interface AgentMailboxRecord {
	readonly messageId: AgentMailboxMessageId;
	readonly queueId: string;
	readonly rootThreadId: AgentThreadId;
	readonly senderThreadId: AgentThreadId;
	readonly senderPath: AgentPath;
	readonly receiverThreadId: AgentThreadId;
	readonly receiverPath: AgentPath;
	readonly receiverSessionId: string;
	readonly receiverSequence: number;
	readonly triggerMode: AgentMailboxTriggerMode;
	readonly sourceCallId?: string;
	readonly dedupeKey: string;
	readonly payload: AgentMailboxPayload;
	readonly state: AgentMailboxDeliveryState;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly queuedAt?: string;
	readonly committedAt?: string;
}

export interface AgentMailboxDedupeInput {
	readonly namespace: string;
	readonly rootThreadId: AgentThreadId;
	readonly senderThreadId: AgentThreadId;
	readonly receiverThreadId: AgentThreadId;
	readonly logicalId: string;
}

export type AgentForkTurns = "none" | "all" | Readonly<{
	readonly kind: "last_n";
	readonly turns: number;
}>;

export interface AgentBudget {
	readonly maxTurns?: number;
	readonly maxToolCalls?: number;
	readonly maxTokens?: number;
	readonly noProgressTurnLimit?: number;
	readonly wallClockMs?: number;
}

export interface AgentInstructionSnapshot {
	readonly project: string;
	readonly role?: string;
}

export interface AgentExecutionPolicySnapshot {
	readonly trusted: boolean;
	readonly permission: "read-only" | "workspace" | "full-access";
	readonly sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
	readonly filesystem: "read_only" | "workspace_write" | "unrestricted";
	readonly network: "disabled" | "enabled";
	readonly networkDomains?: readonly string[];
	readonly readableRoots?: readonly string[];
	readonly writableRoots: readonly string[];
}

export interface AgentProviderSnapshot {
	readonly provider: ProviderId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly reasoningEffort?: ReasoningEffort;
}

export interface AgentSpawnConfigSnapshot {
	readonly workspaceRoot: string;
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly executionPolicy: AgentExecutionPolicySnapshot;
	readonly provider: AgentProviderSnapshot;
	readonly instructions: AgentInstructionSnapshot;
	readonly tools: readonly string[];
	readonly budget?: AgentBudget;
	readonly forkTurns: AgentForkTurns;
}

export interface AgentIdentity {
	readonly threadId: AgentThreadId;
	readonly rootThreadId: AgentThreadId;
	readonly parentThreadId?: AgentThreadId;
	readonly path: AgentPath;
	readonly taskName: string;
	readonly nickname?: string;
}

export interface SpawnAgentCommand {
	readonly parentThreadId: AgentThreadId;
	readonly parentPath: AgentPath;
	readonly rootThreadId: AgentThreadId;
	readonly taskName: string;
	readonly message: string;
	readonly config: AgentSpawnConfigSnapshot;
}

export interface SendAgentMessageCommand {
	readonly senderThreadId: AgentThreadId;
	readonly senderPath: AgentPath;
	readonly target: string;
	readonly message: string;
	readonly triggerTurn: boolean;
	readonly sourceCallId?: string;
}

export interface InterruptAgentCommand {
	readonly senderThreadId: AgentThreadId;
	readonly target: string;
	readonly reason: string;
}

export interface ListAgentsQuery {
	readonly rootThreadId: AgentThreadId;
	readonly pathPrefix?: AgentPath;
}

export type AgentLifecycleEventKind =
	| "reserved"
	| "spawned"
	| "loaded"
	| "started"
	| "waiting"
	| "resumed"
	| "interrupted"
	| "unloaded"
	| "completed"
	| "failed";

export type AgentTaskStatus = "queued" | "running" | AgentTerminalStatus;

export interface AgentCanonicalEventBase {
	readonly eventId: string;
	readonly occurredAt: string;
	readonly threadId: AgentThreadId;
	readonly rootThreadId: AgentThreadId;
	readonly parentThreadId?: AgentThreadId;
	readonly path: AgentPath;
	readonly sourceCallId?: string;
}

export interface AgentTaskEventContext {
	readonly taskId: string;
	readonly parentSessionId: string;
	readonly parentTurnId: string;
	readonly profileId: string;
	readonly taskStatus: AgentTaskStatus;
}

export interface AgentLifecycleEvent extends AgentCanonicalEventBase {
	readonly type: "agent_lifecycle";
	readonly kind: AgentLifecycleEventKind;
	readonly threadStatus: AgentLifecycleStatus;
	readonly task?: AgentTaskEventContext;
	readonly summary?: string;
}

export interface AgentProgressEvent extends AgentCanonicalEventBase {
	readonly type: "agent_progress";
	readonly kind: "progress";
	readonly task: AgentTaskEventContext;
	readonly progressSequence: number;
	readonly summary: string;
	readonly usage: Readonly<Record<string, number>>;
}

export interface AgentUsageEvent extends AgentCanonicalEventBase {
	readonly type: "agent_usage";
	readonly kind: "usage";
	readonly task: AgentTaskEventContext;
	readonly usage: Readonly<Record<string, number>>;
}

export interface AgentCommunicationEvent extends AgentCanonicalEventBase {
	readonly type: "agent_communication";
	readonly kind: "message_queued" | "message_delivered";
	readonly messageId: AgentMailboxMessageId;
	readonly senderThreadId: AgentThreadId;
	readonly senderPath: AgentPath;
	readonly receiverThreadId: AgentThreadId;
	readonly receiverPath: AgentPath;
	readonly receiverSequence: number;
	readonly triggerMode: AgentMailboxTriggerMode;
	readonly payloadKind: AgentMailboxPayload["kind"];
}

export type AgentCanonicalEvent =
	| AgentLifecycleEvent
	| AgentProgressEvent
	| AgentUsageEvent
	| AgentCommunicationEvent;

export class AgentPathError extends Error {
	readonly code = "invalid_agent_path" as const;

	constructor(message: string) {
		super(`invalid_agent_path: ${message}`);
		this.name = "AgentPathError";
	}
}

export class AgentTransitionError extends Error {
	readonly code = "invalid_agent_transition" as const;

	constructor(from: AgentLifecycleStatus, to: AgentLifecycleStatus) {
		super(`invalid_agent_transition: cannot transition from ${from} to ${to}`);
		this.name = "AgentTransitionError";
	}
}

export class AgentAuthorityError extends Error {
	readonly code = "agent_authority_expansion" as const;

	constructor() {
		super("agent_authority_expansion: child authority cannot exceed parent authority");
		this.name = "AgentAuthorityError";
	}
}

export class AgentCapacityError extends Error {
	readonly code = "agent_capacity_exhausted" as const;

	constructor(maxResidents: number) {
		super(`agent_capacity_exhausted: resident agent limit ${maxResidents} reached`);
		this.name = "AgentCapacityError";
	}
}

export class AgentDepthError extends Error {
	readonly code = "agent_depth_exceeded" as const;

	constructor(maxDepth: number) {
		super(`agent_depth_exceeded: maximum agent depth is ${maxDepth}`);
		this.name = "AgentDepthError";
	}
}

export type AgentBudgetExhaustionKind =
	| "max_turns"
	| "max_tool_calls"
	| "max_tokens"
	| "no_progress"
	| "wall_clock";

export class AgentBudgetExhaustedError extends Error {
	readonly code = "agent_budget_exhausted" as const;

	constructor(readonly kind: AgentBudgetExhaustionKind) {
		super(`agent_budget_exhausted: ${kind}`);
		this.name = "AgentBudgetExhaustedError";
	}
}

const AGENT_PATH_MAX_CHARS = 512;
const AGENT_TASK_NAME_MAX_CHARS = 64;
const TASK_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const STATUS_TRANSITIONS: Readonly<Record<AgentLifecycleStatus, ReadonlySet<AgentLifecycleStatus>>> = {
	queued: new Set(["running", "interrupted", "failed"]),
	running: new Set(["waiting", "idle", "completed", "failed", "interrupted"]),
	waiting: new Set(["running", "idle", "failed", "interrupted"]),
	idle: new Set(["running", "unloaded", "completed", "failed", "interrupted"]),
	unloaded: new Set(["idle", "running", "failed", "interrupted"]),
	completed: new Set(),
	failed: new Set(),
	interrupted: new Set(["idle"]),
};

export function agentThreadId(value: string): AgentThreadId {
	const normalized = value.trim();
	if (!normalized || normalized.length > 256 || /[\0\r\n]/u.test(normalized)) {
		throw new AgentPathError("thread id must be a non-blank bounded value");
	}
	return normalized as AgentThreadId;
}

export function agentMailboxMessageId(value: string): AgentMailboxMessageId {
	const normalized = value.trim();
	if (!/^mailbox-[a-f0-9]{64}$/u.test(normalized)) {
		throw new AgentPathError("mailbox message id is invalid");
	}
	return normalized as AgentMailboxMessageId;
}

export function agentMailboxDedupeKey(input: AgentMailboxDedupeInput): string {
	const namespace = boundedMailboxIdentity(input.namespace, "namespace");
	const logicalId = boundedMailboxIdentity(input.logicalId, "logical id");
	const canonical = JSON.stringify({
		version: 1,
		namespace,
		root_thread_id: agentThreadId(input.rootThreadId),
		sender_thread_id: agentThreadId(input.senderThreadId),
		receiver_thread_id: agentThreadId(input.receiverThreadId),
		logical_id: logicalId,
	});
	return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function agentMailboxMessageIdFor(
	receiverThreadId: AgentThreadId,
	dedupeKey: string,
): AgentMailboxMessageId {
	const receiver = agentThreadId(receiverThreadId);
	const key = boundedMailboxIdentity(dedupeKey, "dedupe key", 512);
	const digest = createHash("sha256")
		.update(`${receiver}\0${key}`, "utf8")
		.digest("hex");
	return agentMailboxMessageId(`mailbox-${digest}`);
}

export function agentTaskName(value: string): string {
	const normalized = value.trim();
	if (normalized.length > AGENT_TASK_NAME_MAX_CHARS || !TASK_NAME_PATTERN.test(normalized)) {
		throw new AgentPathError(
			"task name must use lowercase letters, digits, hyphens, or underscores and start and end with an alphanumeric character",
		);
	}
	return normalized;
}

export function parseAgentPath(value: string): AgentPath {
	const normalized = value.trim();
	if (!normalized || normalized.length > AGENT_PATH_MAX_CHARS || normalized !== value) {
		throw new AgentPathError("path must be non-blank, bounded, and contain no surrounding whitespace");
	}
	const segments = normalized.split("/");
	if (segments[0] !== "" || segments[1] !== "root" || segments.length < 2) {
		throw new AgentPathError("path must start with /root");
	}
	for (const segment of segments.slice(2)) agentTaskName(segment);
	return normalized as AgentPath;
}

export function rootAgentPath(): AgentPath {
	return "/root" as AgentPath;
}

export function childAgentPath(parent: AgentPath, taskName: string): AgentPath {
	return parseAgentPath(`${parseAgentPath(parent)}/${agentTaskName(taskName)}`);
}

export function agentPathDepth(path: AgentPath): number {
	return parseAgentPath(path).split("/").length - 2;
}

export function isAgentPathWithin(path: AgentPath, prefix: AgentPath): boolean {
	const candidate = parseAgentPath(path);
	const ancestor = parseAgentPath(prefix);
	return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

export function isSameAgentTree(leftRootThreadId: AgentThreadId, rightRootThreadId: AgentThreadId): boolean {
	return agentThreadId(leftRootThreadId) === agentThreadId(rightRootThreadId);
}

export function canTransitionAgentStatus(
	from: AgentLifecycleStatus,
	to: AgentLifecycleStatus,
): boolean {
	return from === to || STATUS_TRANSITIONS[from].has(to);
}

export function assertAgentStatusTransition(
	from: AgentLifecycleStatus,
	to: AgentLifecycleStatus,
): void {
	if (!canTransitionAgentStatus(from, to)) throw new AgentTransitionError(from, to);
}

export function parseAgentForkTurns(value: string | undefined): AgentForkTurns {
	const normalized = value?.trim() || "none";
	if (normalized === "none" || normalized === "all") return normalized;
	if (!/^[1-9][0-9]*$/u.test(normalized)) {
		throw new TypeError("fork_turns must be none, all, or a positive integer string");
	}
	const turns = Number(normalized);
	if (!Number.isSafeInteger(turns)) {
		throw new TypeError("fork_turns must be none, all, or a positive integer string");
	}
	return Object.freeze({ kind: "last_n", turns });
}

export function narrowAgentExecutionPolicy(
	parent: AgentExecutionPolicySnapshot,
	requested?: AgentExecutionPolicySnapshot,
): AgentExecutionPolicySnapshot {
	const candidate = requested ?? parent;
	const broader = candidate.trusted && !parent.trusted
		|| permissionRank(candidate.permission) > permissionRank(parent.permission)
		|| sandboxRank(candidate.sandboxMode) > sandboxRank(parent.sandboxMode)
		|| filesystemRank(candidate.filesystem) > filesystemRank(parent.filesystem)
		|| networkRank(candidate.network) > networkRank(parent.network)
		|| networkDomainsBroadenAuthority(parent, candidate)
		|| (parent.filesystem !== "unrestricted"
			&& (candidate.readableRoots ?? []).some((root) => (
				!(parent.readableRoots ?? []).includes(root)
				&& !parent.writableRoots.includes(root)
			)))
		|| (parent.filesystem !== "unrestricted"
			&& candidate.writableRoots.some((root) => !parent.writableRoots.includes(root)));
	if (broader) throw new AgentAuthorityError();
	return Object.freeze({
		...candidate,
		...(candidate.networkDomains === undefined ? {} : {
			networkDomains: Object.freeze([...candidate.networkDomains]),
		}),
		...(candidate.readableRoots === undefined ? {} : {
			readableRoots: Object.freeze([...candidate.readableRoots]),
		}),
		writableRoots: Object.freeze([...candidate.writableRoots]),
	});
}

export function selectAgentForkConversation(
	items: readonly CanonicalConversationItem[],
	forkTurns: AgentForkTurns,
): readonly CanonicalConversationItem[] {
	if (forkTurns === "none") return Object.freeze([]);
	const start = forkTurns === "all" ? 0 : lastTurnStart(items, forkTurns.turns);
	const selected = items.slice(start).map(stripProviderContinuation);
	const resultIds = new Set(selected.flatMap((item) =>
		item.type === "tool_result" ? [item.callId] : []
	));
	const callIds = new Set(selected.flatMap((item) =>
		item.type === "assistant_tool_calls"
			? item.calls.filter((call) => resultIds.has(call.callId)).map((call) => call.callId)
			: []
	));
	return Object.freeze(selected.flatMap((item): CanonicalConversationItem[] => {
		if (item.type === "tool_result") return callIds.has(item.callId) ? [item] : [];
		if (item.type !== "assistant_tool_calls") return [item];
		const calls = Object.freeze(item.calls.filter((call) => callIds.has(call.callId)));
		if (calls.length > 0) return [Object.freeze({ ...item, calls })];
		return item.text ? [Object.freeze({ type: "assistant", text: item.text })] : [];
	}));
}

function lastTurnStart(items: readonly CanonicalConversationItem[], turns: number): number {
	let remaining = turns;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (items[index]?.type !== "user") continue;
		remaining -= 1;
		if (remaining === 0) return index;
	}
	return 0;
}

function stripProviderContinuation(item: CanonicalConversationItem): CanonicalConversationItem {
	if (item.type === "assistant") return Object.freeze({ type: "assistant", text: item.text });
	if (item.type === "assistant_tool_calls") {
		return Object.freeze({
			type: "assistant_tool_calls",
			text: item.text,
			calls: Object.freeze(item.calls.map((call) => Object.freeze({ ...call }))),
		});
	}
	if (item.type === "user") {
		return Object.freeze({
			type: "user",
			text: item.text,
			...(item.images ? { images: Object.freeze([...item.images]) } : {}),
		});
	}
	if (item.type === "context") {
		return Object.freeze({ ...item, metadata: Object.freeze({ ...item.metadata }) });
	}
	return Object.freeze({ ...item });
}

function permissionRank(value: AgentExecutionPolicySnapshot["permission"]): number {
	return value === "read-only" ? 0 : value === "workspace" ? 1 : 2;
}

function sandboxRank(value: AgentExecutionPolicySnapshot["sandboxMode"]): number {
	return value === "read-only" ? 0 : value === "workspace-write" ? 1 : 2;
}

function filesystemRank(value: AgentExecutionPolicySnapshot["filesystem"]): number {
	return value === "read_only" ? 0 : value === "workspace_write" ? 1 : 2;
}

function networkRank(value: AgentExecutionPolicySnapshot["network"]): number {
	return value === "disabled" ? 0 : 1;
}

function networkDomainsBroadenAuthority(
	parent: AgentExecutionPolicySnapshot,
	candidate: AgentExecutionPolicySnapshot,
): boolean {
	if (candidate.network !== "enabled" || parent.networkDomains === undefined) return false;
	if (candidate.networkDomains === undefined) return true;
	return candidate.networkDomains.some((domain) => !parent.networkDomains?.includes(domain));
}

function boundedMailboxIdentity(value: string, field: string, maximum = 256): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > maximum || /[\0\r\n]/u.test(normalized)) {
		throw new AgentPathError(`${field} must be a non-blank bounded value`);
	}
	return normalized;
}

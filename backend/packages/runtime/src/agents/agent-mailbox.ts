import { randomUUID } from "node:crypto";
import {
	agentMailboxDedupeKey,
	agentThreadId,
	parseAgentPath,
	rootAgentPath,
} from "@mycli/core";
import type {
	AgentMailboxPayload,
	AgentMailboxRecord,
	AgentMailboxTriggerMode,
	AgentCommunicationEvent,
	AgentPath,
	AgentThreadId,
	QueuedInput,
} from "@mycli/core";
import type {
	AgentMailboxStore,
	AgentThreadRecord,
	AgentThreadStore,
} from "@mycli/storage";
import type { QueueCoordinator } from "../turns/queue-coordinator.ts";

export interface AgentMailboxEndpoint {
	readonly threadId: AgentThreadId;
	readonly rootThreadId: AgentThreadId;
	readonly path: AgentPath;
	readonly sessionId: string;
}

export interface SendAgentMailboxInput {
	readonly sender: AgentMailboxEndpoint;
	readonly root: AgentMailboxEndpoint;
	readonly target: string;
	readonly triggerMode: AgentMailboxTriggerMode;
	readonly logicalId: string;
	readonly sourceCallId?: string;
	readonly payload: AgentMailboxPayload;
}

export interface AgentMailboxDeliveryResult {
	readonly disposition: "enqueued" | "duplicate";
	readonly item: AgentMailboxRecord;
	readonly receiver: AgentMailboxEndpoint;
	readonly projected: boolean;
}

export interface AgentMailboxRepairResult {
	readonly receiver: AgentMailboxEndpoint;
	readonly repairedCount: number;
	readonly committedCount: number;
	readonly pendingCount: number;
}

export interface AgentMailboxOptions {
	readonly store: AgentMailboxStore;
	readonly threadStore: AgentThreadStore;
	readonly queueForSession: (sessionId: string) => QueueCoordinator | undefined;
	readonly committedQueueIds: (sessionId: string) => ReadonlySet<string>;
	readonly triggerReceiver?: (
		receiver: AgentMailboxEndpoint,
		item: AgentMailboxRecord,
	) => void | Promise<void>;
	readonly onActivity?: (input: Readonly<{
		kind: "mailbox" | "completion";
		rootThreadId: AgentThreadId;
		threadId: AgentThreadId;
	}>) => void;
	readonly createEventId?: () => string;
	readonly clock?: () => string;
	readonly onEvent?: (event: AgentCommunicationEvent) => void | Promise<void>;
}

export class AgentMailboxTargetError extends Error {
	constructor(
		readonly code:
			| "agent_target_not_found"
			| "agent_target_forbidden"
			| "agent_target_ambiguous"
			| "invalid_agent_target",
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "AgentMailboxTargetError";
	}
}

export class AgentMailbox {
	readonly #options: AgentMailboxOptions;

	constructor(options: AgentMailboxOptions) {
		this.#options = options;
	}

	async send(input: SendAgentMailboxInput): Promise<AgentMailboxDeliveryResult> {
		const root = this.#validateRoot(input.root);
		const sender = this.#validateSender(input.sender, root);
		const receiver = this.resolveTarget(sender, root, input.target);
		const logicalId = requiredIdentity(input.logicalId, "logicalId");
		const sourceCallId = input.sourceCallId === undefined
			? undefined
			: requiredIdentity(input.sourceCallId, "sourceCallId");
		const result = this.#options.store.enqueue({
			rootThreadId: root.threadId,
			senderThreadId: sender.threadId,
			senderPath: sender.path,
			receiverThreadId: receiver.threadId,
			receiverPath: receiver.path,
			receiverSessionId: receiver.sessionId,
			triggerMode: input.triggerMode,
			...(sourceCallId === undefined ? {} : { sourceCallId }),
			dedupeKey: agentMailboxDedupeKey({
				namespace: input.payload.kind === "completion"
					? "terminal_completion"
					: "coordination_call",
				rootThreadId: root.threadId,
				senderThreadId: sender.threadId,
				receiverThreadId: receiver.threadId,
				logicalId,
			}),
			payload: input.payload,
		});
		if (result.disposition === "enqueued") {
			this.#emit("message_queued", result.item);
			try {
				this.#options.onActivity?.({
					kind: input.payload.kind === "completion" ? "completion" : "mailbox",
					rootThreadId: root.threadId,
					threadId: receiver.threadId,
				});
			} catch {
				// Durable mailbox delivery does not depend on activity observers.
			}
		}
		const projected = this.#project(result.item, receiver);
		if (input.triggerMode === "follow_up" && result.disposition === "enqueued") {
			await this.#options.triggerReceiver?.(receiver, result.item);
		}
		return Object.freeze({
			disposition: result.disposition,
			item: this.#options.store.get(result.item.messageId) ?? result.item,
			receiver,
			projected,
		});
	}

	resolveTarget(
		sender: AgentMailboxEndpoint,
		root: AgentMailboxEndpoint,
		target: string,
	): AgentMailboxEndpoint {
		const normalized = target.trim();
		if (!normalized || normalized.length > 512 || /[\0\r\n]/u.test(normalized)) {
			throw new AgentMailboxTargetError("invalid_agent_target", "target is invalid");
		}
		if (sender.rootThreadId !== root.threadId) {
			throw new AgentMailboxTargetError("agent_target_forbidden", "sender is outside the root tree");
		}
		if (normalized.startsWith("/")) {
			let path: AgentPath;
			try {
				path = parseAgentPath(normalized);
			} catch {
				throw new AgentMailboxTargetError("invalid_agent_target", "canonical target path is invalid");
			}
			if (path === rootAgentPath()) return root;
			const record = this.#options.threadStore.getByPath(root.threadId, path);
			if (!record) {
				throw new AgentMailboxTargetError("agent_target_not_found", "agent path does not exist");
			}
			return endpointFromRecord(record);
		}

		if (normalized === "root") return root;
		const thread = this.#options.threadStore.get(normalized);
		if (thread) {
			if (thread.rootThreadId !== root.threadId) {
				throw new AgentMailboxTargetError("agent_target_forbidden", "agent is outside the root tree");
			}
			return endpointFromRecord(thread);
		}
		const matches = this.#options.threadStore.list({ rootThreadId: root.threadId })
			.filter((record) => record.taskName === normalized || record.nickname === normalized);
		if (matches.length > 1) {
			throw new AgentMailboxTargetError("agent_target_ambiguous", "agent alias is ambiguous");
		}
		const match = matches[0];
		if (!match) throw new AgentMailboxTargetError("agent_target_not_found", "agent alias does not exist");
		return endpointFromRecord(match);
	}

	repair(receiverInput: AgentMailboxEndpoint): AgentMailboxRepairResult {
		const receiver = normalizeEndpoint(receiverInput);
		const queue = this.#options.queueForSession(receiver.sessionId);
		let repairedCount = 0;
		let committedCount = 0;
		let pendingCount = 0;
		let afterSequence = 0;
		while (true) {
			const items = this.#options.store.list({
				receiverThreadId: receiver.threadId,
				afterSequence,
				states: ["pending", "queued"],
				limit: 1_000,
			});
			if (items.length === 0) break;
			for (const item of items) {
				afterSequence = item.receiverSequence;
				if (item.rootThreadId !== receiver.rootThreadId
					|| item.receiverPath !== receiver.path
					|| item.receiverSessionId !== receiver.sessionId) {
					throw new AgentMailboxTargetError(
						"agent_target_forbidden",
						"persisted receiver identity does not match runtime",
					);
				}
				if (!queue) {
					pendingCount += 1;
					continue;
				}
				const outcome = this.#project(item, receiver);
				if (outcome) repairedCount += 1;
				const current = this.#options.store.get(item.messageId);
				if (current?.state === "committed") committedCount += 1;
				else if (current?.state === "pending") pendingCount += 1;
			}
			if (items.length < 1_000) break;
		}
		return Object.freeze({ receiver, repairedCount, committedCount, pendingCount });
	}

	markQueueRecordsCommitted(records: readonly QueuedInput[]): number {
		let committed = 0;
		for (const record of records) {
			if (record.source !== "agent_mailbox") continue;
			const item = this.#options.store.get(record.queueId);
			if (!item) continue;
			let current = item;
			if (current.state === "pending") {
				current = this.#options.store.transition({
					messageId: current.messageId,
					state: "queued",
				});
			}
			if (current.state === "queued") {
				this.#options.store.transition({
					messageId: current.messageId,
					state: "committed",
				});
				committed += 1;
			}
		}
		return committed;
	}

	#project(item: AgentMailboxRecord, receiver: AgentMailboxEndpoint): boolean {
		const queue = this.#options.queueForSession(receiver.sessionId);
		if (!queue) return false;
		const committedIds = this.#options.committedQueueIds(receiver.sessionId);
		if (committedIds.has(item.queueId)) {
			this.markQueueRecordsCommitted([mailboxQueueRecord(item)]);
			return true;
		}
		const active = activeQueueRecords(queue).some((record) => record.queueId === item.queueId);
		if (!active) {
			queue.enqueueInternalNotification({
				sessionId: receiver.sessionId,
				queueId: item.queueId,
				text: providerMailboxText(item),
				source: "agent_mailbox",
			});
		}
		if (item.state === "pending") {
			this.#options.store.transition({ messageId: item.messageId, state: "queued" });
			this.#emit("message_delivered", item);
		}
		return true;
	}

	#emit(kind: AgentCommunicationEvent["kind"], item: AgentMailboxRecord): void {
		if (!this.#options.onEvent) return;
		try {
			const receiver = this.#options.threadStore.get(item.receiverThreadId);
			void Promise.resolve(this.#options.onEvent(Object.freeze({
				type: "agent_communication",
				eventId: this.#options.createEventId?.() ?? randomUUID(),
				occurredAt: this.#options.clock?.() ?? new Date().toISOString(),
				kind,
				threadId: item.receiverThreadId,
				rootThreadId: item.rootThreadId,
				...(receiver ? { parentThreadId: receiver.parentThreadId } : {}),
				path: item.receiverPath,
				...(item.sourceCallId ? { sourceCallId: item.sourceCallId } : {}),
				messageId: item.messageId,
				senderThreadId: item.senderThreadId,
				senderPath: item.senderPath,
				receiverThreadId: item.receiverThreadId,
				receiverPath: item.receiverPath,
				receiverSequence: item.receiverSequence,
				triggerMode: item.triggerMode,
				payloadKind: item.payload.kind,
			}))).catch(() => undefined);
		} catch {
			// Communication projections cannot affect durable mailbox delivery.
		}
	}

	#validateRoot(input: AgentMailboxEndpoint): AgentMailboxEndpoint {
		const root = normalizeEndpoint(input);
		if (root.threadId !== root.rootThreadId || root.path !== rootAgentPath()) {
			throw new AgentMailboxTargetError("invalid_agent_target", "root endpoint is invalid");
		}
		return root;
	}

	#validateSender(
		input: AgentMailboxEndpoint,
		root: AgentMailboxEndpoint,
	): AgentMailboxEndpoint {
		const sender = normalizeEndpoint(input);
		if (sender.rootThreadId !== root.threadId) {
			throw new AgentMailboxTargetError("agent_target_forbidden", "sender is outside the root tree");
		}
		if (sender.threadId === root.threadId) {
			if (sender.path !== root.path || sender.sessionId !== root.sessionId) {
				throw new AgentMailboxTargetError("agent_target_forbidden", "root sender identity is invalid");
			}
			return sender;
		}
		const record = this.#options.threadStore.get(sender.threadId);
		if (!record
			|| record.rootThreadId !== root.threadId
			|| record.path !== sender.path
			|| record.threadId !== sender.threadId) {
			throw new AgentMailboxTargetError("agent_target_forbidden", "sender identity is invalid");
		}
		return sender;
	}
}

function endpointFromRecord(record: AgentThreadRecord): AgentMailboxEndpoint {
	return Object.freeze({
		threadId: record.threadId,
		rootThreadId: record.rootThreadId,
		path: record.path,
		sessionId: record.threadId,
	});
}

function normalizeEndpoint(input: AgentMailboxEndpoint): AgentMailboxEndpoint {
	return Object.freeze({
		threadId: agentThreadId(input.threadId),
		rootThreadId: agentThreadId(input.rootThreadId),
		path: parseAgentPath(input.path),
		sessionId: requiredIdentity(input.sessionId, "sessionId"),
	});
}

function providerMailboxText(item: AgentMailboxRecord): string {
	return `<agent-mailbox>\n${JSON.stringify({
		message_id: item.messageId,
		sequence: item.receiverSequence,
		kind: item.payload.kind,
		sender: item.senderPath,
		receiver: item.receiverPath,
		trigger_mode: item.triggerMode,
		payload: item.payload,
	})}\n</agent-mailbox>`;
}

function mailboxQueueRecord(item: AgentMailboxRecord): QueuedInput {
	return Object.freeze({
		queueId: item.queueId,
		sessionId: item.receiverSessionId,
		clientTurnId: item.messageId,
		targetTurnId: "turn_pending",
		kind: "pending_steer",
		state: "accepted",
		text: providerMailboxText(item),
		imagePaths: Object.freeze([]),
		source: "agent_mailbox",
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	});
}

function activeQueueRecords(queue: QueueCoordinator): readonly QueuedInput[] {
	const snapshot = queue.snapshot();
	return Object.freeze([
		...snapshot.pendingSteers,
		...snapshot.rejectedSteers,
		...snapshot.followUps,
	]);
}

function requiredIdentity(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > 256 || /[\0\r\n]/u.test(normalized)) {
		throw new AgentMailboxTargetError("invalid_agent_target", `${field} is invalid`);
	}
	return normalized;
}

import { setImmediate } from "node:timers/promises";
import { modelInputSha256 } from "@mycli/core";
import type { CanonicalConversationItem, ModelContextEvent } from "@mycli/core";
import type { ModelInputLedgerStore, TranscriptEventEnvelope, TranscriptEventRepository } from "@mycli/storage";
import { inheritedTrainingItems, loadTrainingConversationContext, type TrainingConversationContext } from "./context.ts";
import { TrainingMessageProjector, trainingToolDefinition } from "./messages.ts";
import { TrainingRedactor } from "./redaction.ts";
import type { TrainingRedactionOptions } from "./redaction.ts";
import { trainingReasoning } from "./reasoning.ts";
import type { SessionTrainingExportReport, TrainingExportWarning, TrainingMessage } from "./types.ts";

export interface SessionTrainingExportOptions extends TrainingRedactionOptions {
	readonly sessionId: string;
	readonly signal: AbortSignal;
}

export type TrainingExportStore = Pick<TranscriptEventRepository, "loadEventWindow"> & {
	readonly modelInputLedger: Pick<ModelInputLedgerStore, "listProviderRequestReferences" | "reconstructProviderStep"
		| "loadModelContextEvents" | "loadProviderRequestManifest" | "loadToolSetSnapshot">;
};

/** Stream a single conversation row, not cumulative samples or request/event archives. */
export async function exportSessionTrainingData(
	store: TrainingExportStore,
	options: SessionTrainingExportOptions,
	writeChunk: (chunk: string) => Promise<void>,
): Promise<SessionTrainingExportReport> {
	options.signal.throwIfAborted();
	const lastSequence = store.loadEventWindow(options.sessionId, { limit: 1, includeAncestors: true }).events.at(-1)?.sequenceNo ?? 0;
	const pages: number[] = [];
	const sessionTurns = new Map<string, Set<string>>();
	const turns = new Set<string>();
	const reasoningHashes = new Set<string>();
	const scanRedactor = new TrainingRedactor(options);
	let firstUser: Extract<TranscriptEventEnvelope, { eventType: "user_input" }> | undefined;
	let beforeSequence = lastSequence + 1;
	while (beforeSequence > 1) {
		await setImmediate(undefined, { signal: options.signal });
		const page = store.loadEventWindow(options.sessionId, { beforeSequence, limit: 256, includeAncestors: true });
		pages.push(beforeSequence);
		for (const event of page.events.toReversed()) {
			const includedTurns = sessionTurns.get(event.sessionId) ?? new Set<string>();
			if (event.turnId) includedTurns.add(event.turnId);
			sessionTurns.set(event.sessionId, includedTurns);
			if (event.eventType === "user_input") firstUser = event;
			if (event.turnId && (event.eventType === "user_input" || event.eventType === "turn_lifecycle")) turns.add(eventTurnKey(event));
			if (event.eventType === "assistant_output" || event.eventType === "assistant_tool_call_batch") {
				for (const block of trainingReasoning(event.payload.providerState, scanRedactor)) reasoningHashes.add(modelInputSha256([eventTurnKey(event), block.text]));
			}
		}
		if (!page.hasMore || page.events.length === 0) break;
		beforeSequence = page.events[0]!.sequenceNo;
	}
	const contexts = [...sessionTurns].reverse().map(([sessionId, includedTurns]) => ({ sessionId,
		context: loadTrainingConversationContext(store, sessionId, includedTurns) }));
	const context = contexts[0]?.context ?? loadTrainingConversationContext(store, options.sessionId);

	const redactor = new TrainingRedactor(options);
	const projector = new TrainingMessageProjector(redactor);
	const warnings = new Set<TrainingExportWarning>();
	if (contexts.some((entry) => entry.context.unavailable) || context.unavailable
		|| (firstUser && !context.initialRequest)) warnings.add("initial_context_unavailable");
	let messages = 0, toolCalls = 0, toolResults = 0, reasoningBlocks = 0, images = 0, bytes = 0;
	const write = async (chunk: string): Promise<void> => {
		options.signal.throwIfAborted();
		await writeChunk(chunk);
		bytes += Buffer.byteLength(chunk);
	};
	const emit = async (message: TrainingMessage | undefined): Promise<void> => {
		if (!message) return;
		await write(`${messages ? "," : ""}${JSON.stringify(message)}`);
		messages += 1;
		if (message.role === "assistant") { toolCalls += message.tool_calls?.length ?? 0; reasoningBlocks += message.reasoning?.length ?? 0; }
		if (message.role === "tool") toolResults += 1;
		if ("images" in message) images += message.images?.length ?? 0;
	};
	const updates = new Map<string, ModelContextEvent[]>();
	for (const entry of contexts) for (const event of entry.context.updates) {
		const key = JSON.stringify([entry.sessionId, event.turnId]);
		const list = updates.get(key) ?? [];
		list.push(event); updates.set(key, list);
	}
	const flushContext = async (turnId: string | undefined, through: string, all = false): Promise<void> => {
		if (!turnId) return;
		const list = updates.get(turnId);
		while (list?.length && (all || list[0]!.createdAt <= through)) {
			const event = list.shift()!;
			if (event.tombstone) projector.removeContext(event.sectionKey);
			else if (event.fragment) await emit(projector.context(event.sectionKey, event.fragment.role, event.fragment.content));
		}
	};
	await write(`{"schema_version":3,"source":${JSON.stringify({ session_id: redactor.text(options.sessionId) })},"messages":[`);
	let lastInstructions: string | undefined;
	const emitInitialContext = async (source: TrainingConversationContext): Promise<void> => {
		if (!source.initialRequest) return;
		if (source.initialRequest.instructions !== lastInstructions) {
			await emit({ role: "system", content: redactor.text(source.initialRequest.instructions) });
			lastInstructions = source.initialRequest.instructions;
		}
		for (const [index, text] of (source.initialRequest.developerInstructions ?? []).entries()) {
			await emit(projector.context(`initial-developer-${index}`, "developer", text));
		}
		if (source.updates.length === 0) {
			for (const item of source.initialRequest.items ?? []) if (item.type === "context") await emit(projector.item(item, "initial"));
		}
	};
	await emitInitialContext(context);
	const remainingContexts = new Map(contexts.slice(1).map((entry) => [entry.sessionId, entry.context]));
	for (const item of inheritedTrainingItems(context, firstUser ? { turnId: firstUser.turnId, text: firstUser.payload.text } : undefined)) {
		await emit(projector.item(item, "inherited"));
	}
	const pendingCalls = new Set<string>();
	for (const cursor of pages.toReversed()) {
		await setImmediate(undefined, { signal: options.signal });
		for (const event of store.loadEventWindow(options.sessionId, { beforeSequence: cursor, limit: 256, includeAncestors: true }).events) {
			if (event.sequenceNo > lastSequence) break;
			const nextContext = remainingContexts.get(event.sessionId);
			if (nextContext) {
				await emitInitialContext(nextContext);
				remainingContexts.delete(event.sessionId);
			}
			if (pendingCalls.size === 0 || event.eventType === "assistant_output" || event.eventType === "assistant_tool_call_batch") {
				await flushContext(eventTurnKey(event), event.createdAt);
			}
			const item = transcriptItem(event);
			if (item) await emit(projector.item(item, eventTurnKey(event)));
			if (item?.type === "assistant_tool_calls") for (const call of item.calls) pendingCalls.add(JSON.stringify([eventTurnKey(event), call.callId]));
			if (item?.type === "tool_result") pendingCalls.delete(JSON.stringify([eventTurnKey(event), item.callId]));
			if (event.eventType === "turn_lifecycle" && event.payload.phase !== "started") {
				pendingCalls.clear(); await flushContext(eventTurnKey(event), event.createdAt, true);
			}
			if (event.eventType === "display_activity" && event.payload.activityType === "reasoning" && event.payload.text) {
				const text = redactor.text(event.payload.text);
				if (!reasoningHashes.has(modelInputSha256([eventTurnKey(event), text]))) await emit({ role: "assistant", content: "", reasoning: [{ kind: "thinking", text }] });
			}
			if (event.eventType === "opaque_legacy") warnings.add("legacy_content_unavailable");
		}
	}
	for (const turnId of updates.keys()) await flushContext(turnId, "", true);
	const uniqueTools = new Map(contexts.flatMap((entry) => entry.context.tools.map((tool) => [modelInputSha256(tool), tool] as const)));
	const tools = [...uniqueTools.values()].map((tool) => trainingToolDefinition(tool, redactor));
	await write(`],"tools":${JSON.stringify(tools)}}\n`);
	return { schema_version: 3, turns: turns.size, messages, tool_calls: toolCalls, tool_results: toolResults,
		reasoning_blocks: reasoningBlocks, images, warnings: [...warnings], redactions: redactor.count, bytes_written: bytes };
}

function eventTurnKey(event: TranscriptEventEnvelope): string {
	return JSON.stringify([event.sessionId, event.turnId ?? "session"]);
}

function transcriptItem(event: TranscriptEventEnvelope): CanonicalConversationItem | undefined {
	switch (event.eventType) {
		case "user_input": return { type: "user", text: event.payload.text, ...(event.payload.images ? { images: event.payload.images } : {}) };
		case "assistant_output": return { type: "assistant", text: event.payload.text, ...(event.payload.providerState ? { providerState: event.payload.providerState } : {}) };
		case "assistant_tool_call_batch": return { type: "assistant_tool_calls", text: event.payload.text, calls: event.payload.calls,
			...(event.payload.providerState ? { providerState: event.payload.providerState } : {}) };
		case "tool_result": return { type: "tool_result", ...event.payload.result };
		case "context": return { type: "context", text: event.payload.text, metadata: event.payload.metadata };
		default: return undefined;
	}
}

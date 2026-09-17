import type { CanonicalConversationItem, ModelContextEvent, ProviderRequest, ToolDefinition } from "@mycli/core";
import { modelInputSha256 } from "@mycli/core";
import { StorageFailure } from "@mycli/storage";
import type { ProviderRequestReference } from "@mycli/storage";
import type { TrainingExportStore } from "./export.ts";

export interface TrainingConversationContext {
	readonly initialRequest?: ProviderRequest;
	readonly initialTurnId?: string;
	readonly updates: readonly ModelContextEvent[];
	readonly tools: readonly ToolDefinition[];
	readonly unavailable: boolean;
}

/** Read prompt/context and unique tool definitions, not a snapshot for every provider request. */
export function loadTrainingConversationContext(store: TrainingExportStore, sessionId: string): TrainingConversationContext {
	const ledger = store.modelInputLedger;
	const references = ledger.listProviderRequestReferences(sessionId);
	const first = references[0];
	let initialRequest: ProviderRequest | undefined;
	let unavailable = false;
	if (first) {
		try {
			const stored = ledger.reconstructProviderStep(first.requestId);
			if (stored.manifest.sessionId === sessionId && stored.manifest.turnId === first.turnId) initialRequest = stored.request;
			else unavailable = true;
		}
		catch (error) { if (!(error instanceof StorageFailure)) throw error; unavailable = true; }
	}
	const tools = new Map<string, ToolDefinition>();
	const snapshotIds = new Set<string>();
	for (const ref of references) {
		try {
			const manifest = ledger.loadProviderRequestManifest(ref.requestId);
			if (!manifest || manifest.sessionId !== sessionId) { unavailable = true; continue; }
			if (snapshotIds.has(manifest.toolSetSnapshotId)) continue;
			snapshotIds.add(manifest.toolSetSnapshotId);
			const snapshot = ledger.loadToolSetSnapshot(sessionId, manifest.toolSetSnapshotId);
			if (!snapshot) { unavailable = true; continue; }
			for (const tool of snapshot.tools) tools.set(modelInputSha256({ name: tool.name, description: tool.description, parameters: tool.inputSchema }), tool);
		} catch (error) { if (!(error instanceof StorageFailure)) throw error; unavailable = true; }
	}
	const steps = new Set(references.map(referenceKey));
	let updates: readonly ModelContextEvent[] = [];
	try { updates = ledger.loadModelContextEvents(sessionId).filter((event) => steps.has(referenceKey(event))); }
	catch (error) { if (!(error instanceof StorageFailure)) throw error; unavailable = true; }
	return { ...(initialRequest ? { initialRequest } : {}), ...(first ? { initialTurnId: first.turnId } : {}), updates, tools: [...tools.values()], unavailable };
}

/** A fork's first request can contain inherited messages that have no local transcript events. */
export function inheritedTrainingItems(context: TrainingConversationContext, firstUser: {
	readonly turnId?: string; readonly text: string;
} | undefined): readonly CanonicalConversationItem[] {
	if (!firstUser || firstUser.turnId !== context.initialTurnId || !context.initialRequest) return [];
	const request = context.initialRequest;
	const items = request.items ?? request.messages.map((message): CanonicalConversationItem => ({ type: message.role, text: message.content }));
	const index = items.findLastIndex((item) => item.type === "user" && item.text === firstUser.text);
	return index < 0 ? [] : items.slice(0, index).filter((item) => item.type !== "context");
}

function referenceKey(ref: Pick<ProviderRequestReference, "turnId" | "providerStep">): string {
	return JSON.stringify([ref.turnId, ref.providerStep]);
}

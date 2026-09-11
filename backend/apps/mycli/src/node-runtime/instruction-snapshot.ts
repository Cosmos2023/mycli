import { randomUUID } from "node:crypto";
import { modelInputSha256 } from "@mycli/core";
import type { InstructionSnapshot } from "@mycli/core";
import type { ModelInputLedgerStore } from "@mycli/storage";
import type { PackagedSystemPrompt } from "./system-prompt.ts";

interface ResolveSessionInstructionSnapshotInput {
	readonly sessionId: string;
	readonly ledger: ModelInputLedgerStore;
	readonly template: PackagedSystemPrompt;
	readonly clock: () => string;
	readonly createSnapshotId?: () => string;
}

export function resolveSessionInstructionSnapshot(
	input: ResolveSessionInstructionSnapshotInput,
): InstructionSnapshot {
	const existing = input.ledger.loadLatestInstructionSnapshot(input.sessionId);
	if (existing) return existing;
	const candidate = Object.freeze({
		snapshotId: input.createSnapshotId?.() ?? `instructions-${randomUUID()}`,
		version: input.template.version,
		source: input.template.source,
		content: input.template.content,
		contentSha256: modelInputSha256(input.template.content),
		createdAt: input.clock(),
	});
	if (candidate.contentSha256 !== input.template.contentSha256) {
		throw new TypeError("system prompt template hash does not match its content");
	}
	return input.ledger.loadOrCreateInstructionSnapshot(input.sessionId, candidate);
}

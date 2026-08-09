import type Database from "better-sqlite3";
import type {
	InstructionSnapshot,
	ModelContextEvent,
	ProviderInputTimelineEvent,
	ProviderRequest,
	ProviderRequestManifest,
	ToolSetSnapshot,
} from "@mycli/core";
import {
	assertRequestMatchesSnapshots,
	modelInputBlob,
	normalizeInstructionSnapshot,
	normalizeLifecycleEvent,
	normalizeModelContextEvent,
	normalizeProviderInputTimelineEvent,
	normalizeProviderRequest,
	normalizeProviderRequestManifest,
	normalizeToolSetSnapshot,
	validateManifestLogicalDigest,
} from "./model-input-validation.ts";
import type {
	ProviderStepLifecycleEvent,
	ProviderStepLifecycleState,
} from "./model-input-validation.ts";
import { StorageFailure } from "./session-store.ts";
import { stableJson } from "./stable-json.ts";

export type ModelInputLedgerFailpoint =
	| "after_instruction_snapshot"
	| "after_tool_set_snapshot"
	| "after_context_events"
	| "after_timeline_events"
	| "after_request_manifest"
	| "before_prepared_event"
	| "after_prepared_event";

export interface CommitProviderStepInput {
	readonly instructionSnapshot: InstructionSnapshot;
	readonly toolSetSnapshot: ToolSetSnapshot;
	readonly contextEvents: readonly ModelContextEvent[];
	readonly timelineEvents?: readonly ProviderInputTimelineEvent[];
	readonly manifest: ProviderRequestManifest;
	readonly request: ProviderRequest;
	readonly preparedEvent: ProviderStepLifecycleEvent;
}

export interface AppendProviderStepEventInput extends Omit<ProviderStepLifecycleEvent, "state"> {
	readonly state: Exclude<ProviderStepLifecycleState, "prepared">;
}

export interface CommittedProviderStep {
	readonly manifest: ProviderRequestManifest;
	readonly request: ProviderRequest;
}

export interface UnconfirmedProviderStep extends CommittedProviderStep {
	readonly latestEvent: ProviderStepLifecycleEvent;
}

export interface RecoverUnconfirmedProviderStepsInput {
	readonly sessionId: string;
	readonly createdAt: string;
	readonly createEventId: (requestId: string) => string;
}

export interface ModelInputLedgerStore {
	loadOrCreateInstructionSnapshot(
		sessionId: string,
		candidate: InstructionSnapshot,
	): InstructionSnapshot;
	commitProviderStep(input: CommitProviderStepInput): CommittedProviderStep;
	appendProviderStepEvent(input: AppendProviderStepEventInput): ProviderStepLifecycleEvent;
	requiresBootstrap(sessionId: string): boolean;
	loadInstructionSnapshot(sessionId: string, snapshotId: string): InstructionSnapshot | undefined;
	loadLatestInstructionSnapshot(sessionId: string): InstructionSnapshot | undefined;
	loadToolSetSnapshot(sessionId: string, snapshotId: string): ToolSetSnapshot | undefined;
	loadLatestToolSetSnapshot(sessionId: string): ToolSetSnapshot | undefined;
	loadModelContextEvents(sessionId: string): readonly ModelContextEvent[];
	loadProviderInputTimelineEvents(sessionId: string): readonly ProviderInputTimelineEvent[];
	loadProviderRequestManifest(requestId: string): ProviderRequestManifest | undefined;
	loadLatestProviderRequestManifest(sessionId: string): ProviderRequestManifest | undefined;
	loadProviderStepEvents(requestId: string): readonly ProviderStepLifecycleEvent[];
	loadUnconfirmedProviderSteps(sessionId: string): readonly UnconfirmedProviderStep[];
	recoverUnconfirmedProviderSteps(
		input: RecoverUnconfirmedProviderStepsInput,
	): readonly UnconfirmedProviderStep[];
	reconstructProviderStep(requestId: string): CommittedProviderStep;
}

export interface SQLiteModelInputLedgerOptions {
	readonly database: Database.Database;
	readonly write: <Result>(operation: () => Result) => Result;
	readonly failpoint?: (name: ModelInputLedgerFailpoint) => void;
}

interface BlobRow {
	readonly blob_id: unknown;
	readonly payload_json: unknown;
	readonly created_at: unknown;
}

interface SnapshotRow {
	readonly snapshot_id: unknown;
	readonly session_id: unknown;
	readonly blob_id: unknown;
	readonly content_sha256: unknown;
	readonly created_at: unknown;
}

interface ContextEventRow {
	readonly event_id: unknown;
	readonly session_id: unknown;
	readonly turn_id: unknown;
	readonly provider_step: unknown;
	readonly section_key: unknown;
	readonly blob_id: unknown;
	readonly supersedes_event_id: unknown;
	readonly tombstone: unknown;
	readonly created_at: unknown;
}

interface TimelineEventRow {
	readonly sequence_no: unknown;
	readonly event_id: unknown;
	readonly session_id: unknown;
	readonly window_id: unknown;
	readonly turn_id: unknown;
	readonly provider_step: unknown;
	readonly kind: unknown;
	readonly blob_id: unknown;
	readonly model_context_event_id: unknown;
	readonly created_at: unknown;
}

interface ManifestRow {
	readonly request_id: unknown;
	readonly session_id: unknown;
	readonly turn_id: unknown;
	readonly provider_step: unknown;
	readonly manifest_blob_id: unknown;
	readonly logical_request_blob_id: unknown;
	readonly request_signature: unknown;
	readonly logical_input_sha256: unknown;
	readonly logical_request_sha256: unknown;
	readonly previous_request_id: unknown;
	readonly boundary: unknown;
	readonly created_at: unknown;
}

interface LifecycleRow {
	readonly event_id: unknown;
	readonly request_id: unknown;
	readonly session_id: unknown;
	readonly state: unknown;
	readonly payload_json: unknown;
	readonly created_at: unknown;
}

const SNAPSHOT_COLUMNS = "snapshot_id, session_id, blob_id, content_sha256, created_at";
const CONTEXT_EVENT_COLUMNS = `
event_id, session_id, turn_id, provider_step, section_key, blob_id,
supersedes_event_id, tombstone, created_at
`;
const TIMELINE_EVENT_COLUMNS = `
sequence_no, event_id, session_id, window_id, turn_id, provider_step, kind,
blob_id, model_context_event_id, created_at
`;
const MANIFEST_COLUMNS = `
request_id, session_id, turn_id, provider_step, manifest_blob_id,
logical_request_blob_id, request_signature, logical_input_sha256,
logical_request_sha256, previous_request_id, boundary, created_at
`;
const LIFECYCLE_COLUMNS = "event_id, request_id, session_id, state, payload_json, created_at";

export class SQLiteModelInputLedger implements ModelInputLedgerStore {
	readonly #database: Database.Database;
	readonly #write: <Result>(operation: () => Result) => Result;
	readonly #failpoint: (name: ModelInputLedgerFailpoint) => void;

	constructor(options: SQLiteModelInputLedgerOptions) {
		this.#database = options.database;
		this.#write = options.write;
		this.#failpoint = options.failpoint ?? (() => undefined);
	}

	loadOrCreateInstructionSnapshot(
		sessionId: string,
		candidate: InstructionSnapshot,
	): InstructionSnapshot {
		return this.#write(() => {
			this.#requireIdentifier(sessionId, "session");
			this.#requireSession(sessionId);
			const existing = this.#loadLatestSnapshot(
				"instruction_snapshots",
				sessionId,
				normalizeInstructionSnapshot,
			);
			if (existing) return existing;
			const snapshot = normalizeInstructionSnapshot(candidate);
			this.#insertInstructionSnapshot(sessionId, snapshot);
			const persisted = this.#loadSnapshot(
				"instruction_snapshots",
				sessionId,
				snapshot.snapshotId,
				normalizeInstructionSnapshot,
			);
			if (!persisted) throw new StorageFailure("instruction snapshot was not persisted");
			return persisted;
		});
	}

	commitProviderStep(input: CommitProviderStepInput): CommittedProviderStep {
		return this.#write(() => {
			const instructions = normalizeInstructionSnapshot(input.instructionSnapshot);
			const toolSet = normalizeToolSetSnapshot(input.toolSetSnapshot);
			const contextEvents = Object.freeze(input.contextEvents.map(normalizeModelContextEvent));
			const timelineEvents = Object.freeze(
				(input.timelineEvents ?? []).map(normalizeProviderInputTimelineEvent),
			);
			const manifest = normalizeProviderRequestManifest(input.manifest);
			const request = normalizeProviderRequest(input.request);
			const preparedEvent = normalizeLifecycleEvent(input.preparedEvent);
			this.#validateCommitEnvelope(
				instructions,
				toolSet,
				contextEvents,
				timelineEvents,
				manifest,
				request,
				preparedEvent,
			);
			this.#requireSession(manifest.sessionId);
			const manifestExisted = this.#manifestRow(manifest.requestId) !== undefined;
			this.#assertContextEventBatch(manifest, contextEvents, manifestExisted);
			this.#assertTimelineEventBatch(manifest, timelineEvents, manifestExisted);
			this.#insertInstructionSnapshot(manifest.sessionId, instructions);
			this.#failpoint("after_instruction_snapshot");
			this.#insertToolSetSnapshot(manifest.sessionId, toolSet);
			this.#failpoint("after_tool_set_snapshot");
			for (const event of contextEvents) this.#insertContextEvent(event);
			this.#failpoint("after_context_events");
			for (const event of timelineEvents) this.#insertTimelineEvent(event);
			this.#failpoint("after_timeline_events");
			this.#validateManifestReferences(manifest, instructions, toolSet);
			this.#insertManifest(manifest, request);
			this.#failpoint("after_request_manifest");
			this.#failpoint("before_prepared_event");
			if (manifestExisted && !this.#lifecycleRow(preparedEvent.eventId)) {
				throw new StorageFailure("provider request manifest is missing its prepared event");
			}
			this.#insertLifecycleEvent(preparedEvent, true);
			this.#failpoint("after_prepared_event");
			return this.#reconstructProviderStep(manifest.requestId);
		});
	}

	appendProviderStepEvent(input: AppendProviderStepEventInput): ProviderStepLifecycleEvent {
		return this.#write(() => {
			const event = normalizeLifecycleEvent(input);
			if (event.state === "prepared") {
				throw new StorageFailure("prepared provider-step events require an atomic request commit");
			}
			this.#insertLifecycleEvent(event, false);
			return this.#loadLifecycleEvent(event.eventId);
		});
	}

	requiresBootstrap(sessionId: string): boolean {
		return this.#read(() => {
			this.#requireIdentifier(sessionId, "session");
			const row = this.#database.prepare(`
				SELECT 1 AS present
				FROM provider_request_manifests
				WHERE session_id = ?
				LIMIT 1
			`).get(sessionId) as { readonly present: unknown } | undefined;
			return row === undefined;
		});
	}

	loadInstructionSnapshot(
		sessionId: string,
		snapshotId: string,
	): InstructionSnapshot | undefined {
		return this.#read(() => this.#loadSnapshot(
			"instruction_snapshots",
			sessionId,
			snapshotId,
			normalizeInstructionSnapshot,
		));
	}

	loadLatestInstructionSnapshot(sessionId: string): InstructionSnapshot | undefined {
		return this.#read(() => this.#loadLatestSnapshot(
			"instruction_snapshots",
			sessionId,
			normalizeInstructionSnapshot,
		));
	}

	loadToolSetSnapshot(sessionId: string, snapshotId: string): ToolSetSnapshot | undefined {
		return this.#read(() => this.#loadSnapshot(
			"tool_set_snapshots",
			sessionId,
			snapshotId,
			normalizeToolSetSnapshot,
		));
	}

	loadLatestToolSetSnapshot(sessionId: string): ToolSetSnapshot | undefined {
		return this.#read(() => this.#loadLatestSnapshot(
			"tool_set_snapshots",
			sessionId,
			normalizeToolSetSnapshot,
		));
	}

	loadModelContextEvents(sessionId: string): readonly ModelContextEvent[] {
		return this.#read(() => {
			this.#requireIdentifier(sessionId, "session");
			const rows = this.#database.prepare(`
				SELECT ${CONTEXT_EVENT_COLUMNS}
				FROM model_context_events
				WHERE session_id = ?
				ORDER BY rowid
			`).all(sessionId) as readonly ContextEventRow[];
			return Object.freeze(rows.map((row) => this.#contextEvent(row)));
		});
	}

	loadProviderInputTimelineEvents(sessionId: string): readonly ProviderInputTimelineEvent[] {
		return this.#read(() => {
			this.#requireIdentifier(sessionId, "session");
			const rows = this.#database.prepare(`
				SELECT ${TIMELINE_EVENT_COLUMNS}
				FROM provider_input_timeline_events
				WHERE session_id = ?
				ORDER BY sequence_no
			`).all(sessionId) as readonly TimelineEventRow[];
			return Object.freeze(rows.map((row) => this.#timelineEvent(row)));
		});
	}

	loadProviderRequestManifest(requestId: string): ProviderRequestManifest | undefined {
		return this.#read(() => {
			this.#requireIdentifier(requestId, "provider request");
			const row = this.#manifestRow(requestId);
			return row ? this.#manifest(row) : undefined;
		});
	}

	loadLatestProviderRequestManifest(sessionId: string): ProviderRequestManifest | undefined {
		return this.#read(() => {
			this.#requireIdentifier(sessionId, "session");
			const row = this.#database.prepare(`
				SELECT ${MANIFEST_COLUMNS}
				FROM provider_request_manifests
				WHERE session_id = ?
				ORDER BY rowid DESC
				LIMIT 1
			`).get(sessionId) as ManifestRow | undefined;
			return row ? this.#manifest(row) : undefined;
		});
	}

	loadProviderStepEvents(requestId: string): readonly ProviderStepLifecycleEvent[] {
		return this.#read(() => {
			this.#requireIdentifier(requestId, "provider request");
			const rows = this.#database.prepare(`
				SELECT ${LIFECYCLE_COLUMNS}
				FROM provider_step_events
				WHERE request_id = ?
				ORDER BY sequence_no
			`).all(requestId) as readonly LifecycleRow[];
			return Object.freeze(rows.map((row) => lifecycleEvent(row)));
		});
	}

	loadUnconfirmedProviderSteps(sessionId: string): readonly UnconfirmedProviderStep[] {
		return this.#read(() => this.#unconfirmedProviderSteps(sessionId));
	}

	recoverUnconfirmedProviderSteps(
		input: RecoverUnconfirmedProviderStepsInput,
	): readonly UnconfirmedProviderStep[] {
		return this.#write(() => {
			const pending = this.#unconfirmedProviderSteps(input.sessionId);
			for (const step of pending) {
				if (step.latestEvent.state === "unknown") continue;
				this.#insertLifecycleEvent(normalizeLifecycleEvent({
					eventId: input.createEventId(step.manifest.requestId),
					requestId: step.manifest.requestId,
					sessionId: input.sessionId,
					state: "unknown",
					payload: Object.freeze({ recovered_after_restart: true }),
					createdAt: input.createdAt,
				}), false);
			}
			return this.#unconfirmedProviderSteps(input.sessionId);
		});
	}

	reconstructProviderStep(requestId: string): CommittedProviderStep {
		return this.#read(() => this.#reconstructProviderStep(requestId));
	}

	#validateCommitEnvelope(
		instructions: InstructionSnapshot,
		toolSet: ToolSetSnapshot,
		contextEvents: readonly ModelContextEvent[],
		timelineEvents: readonly ProviderInputTimelineEvent[],
		manifest: ProviderRequestManifest,
		request: ProviderRequest,
		preparedEvent: ProviderStepLifecycleEvent,
	): void {
		if (manifest.instructionSnapshotId !== instructions.snapshotId
			|| manifest.toolSetSnapshotId !== toolSet.snapshotId) {
			throw new StorageFailure("provider request manifest snapshot ids do not match");
		}
		const eventIds = new Set<string>();
		const sectionKeys = new Set<string>();
		for (const event of contextEvents) {
			if (event.sessionId !== manifest.sessionId || event.turnId !== manifest.turnId
				|| event.providerStep !== manifest.providerStep) {
				throw new StorageFailure("model context event does not belong to its provider step");
			}
			if (eventIds.has(event.eventId) || sectionKeys.has(event.sectionKey)) {
				throw new StorageFailure("provider step contains duplicate model context events");
			}
			eventIds.add(event.eventId);
			sectionKeys.add(event.sectionKey);
		}
		const timelineIds = new Set<string>();
		for (const event of timelineEvents) {
			if (event.sessionId !== manifest.sessionId || event.turnId !== manifest.turnId
				|| event.providerStep !== manifest.providerStep) {
				throw new StorageFailure("provider input timeline event does not belong to its provider step");
			}
			if (timelineIds.has(event.eventId)) {
				throw new StorageFailure("provider step contains duplicate timeline events");
			}
			timelineIds.add(event.eventId);
		}
		if (manifest.schemaVersion === 2) {
			const projectedIds = timelineEvents.map((event) => event.eventId);
			const appendedIds = projectedIds.length === 0
				? []
				: manifest.timelineEventIds.slice(-projectedIds.length);
			if (stableJson(appendedIds) !== stableJson(projectedIds)) {
				throw new StorageFailure("provider request timeline manifest does not include its appended events");
			}
		}
		if (preparedEvent.state !== "prepared"
			|| preparedEvent.requestId !== manifest.requestId
			|| preparedEvent.sessionId !== manifest.sessionId) {
			throw new StorageFailure("prepared provider-step event does not match its manifest");
		}
		validateManifestLogicalDigest(manifest, instructions, toolSet);
		assertRequestMatchesSnapshots(request, manifest, instructions, toolSet);
	}

	#insertInstructionSnapshot(sessionId: string, snapshot: InstructionSnapshot): void {
		const blobId = this.#putBlob(snapshot, snapshot.createdAt);
		const existing = this.#database.prepare(`
			SELECT ${SNAPSHOT_COLUMNS}
			FROM instruction_snapshots
			WHERE snapshot_id = ?
		`).get(snapshot.snapshotId) as SnapshotRow | undefined;
		if (existing) {
			this.#assertSnapshotRow(existing, sessionId, blobId, snapshot.contentSha256, snapshot.createdAt);
			return;
		}
		this.#database.prepare(`
			INSERT INTO instruction_snapshots (
				snapshot_id, session_id, blob_id, content_sha256, created_at
			) VALUES (?, ?, ?, ?, ?)
		`).run(snapshot.snapshotId, sessionId, blobId, snapshot.contentSha256, snapshot.createdAt);
	}

	#insertToolSetSnapshot(sessionId: string, snapshot: ToolSetSnapshot): void {
		const blobId = this.#putBlob(snapshot, snapshot.createdAt);
		const existing = this.#database.prepare(`
			SELECT ${SNAPSHOT_COLUMNS}
			FROM tool_set_snapshots
			WHERE snapshot_id = ?
		`).get(snapshot.snapshotId) as SnapshotRow | undefined;
		if (existing) {
			this.#assertSnapshotRow(existing, sessionId, blobId, snapshot.contentSha256, snapshot.createdAt);
			return;
		}
		this.#database.prepare(`
			INSERT INTO tool_set_snapshots (
				snapshot_id, session_id, blob_id, content_sha256, created_at
			) VALUES (?, ?, ?, ?, ?)
		`).run(snapshot.snapshotId, sessionId, blobId, snapshot.contentSha256, snapshot.createdAt);
	}

	#assertSnapshotRow(
		row: SnapshotRow,
		sessionId: string,
		blobId: string,
		contentSha256: string,
		createdAt: string,
	): void {
		if (row.session_id !== sessionId || row.blob_id !== blobId
			|| row.content_sha256 !== contentSha256 || row.created_at !== createdAt) {
			throw new StorageFailure("model-input snapshot id collides with different content");
		}
		this.#blob(blobId);
	}

	#insertContextEvent(event: ModelContextEvent): void {
		const blobId = this.#putBlob(event, event.createdAt);
		const existing = this.#contextEventRow(event.eventId);
		if (existing) {
			if (existing.session_id !== event.sessionId || existing.turn_id !== event.turnId
				|| existing.provider_step !== event.providerStep || existing.section_key !== event.sectionKey
				|| existing.blob_id !== blobId
				|| nullableText(existing.supersedes_event_id) !== event.supersedesEventId
				|| Boolean(existing.tombstone) !== event.tombstone
				|| existing.created_at !== event.createdAt) {
				throw new StorageFailure("model context event id collides with different content");
			}
			this.#blob(blobId);
			return;
		}
		const latest = this.#database.prepare(`
			SELECT ${CONTEXT_EVENT_COLUMNS}
			FROM model_context_events
			WHERE session_id = ? AND section_key = ?
			ORDER BY rowid DESC
			LIMIT 1
		`).get(event.sessionId, event.sectionKey) as ContextEventRow | undefined;
		const effective = latest?.tombstone === 0 ? latest : undefined;
		if (event.supersedesEventId !== undefined) {
			if (!effective || effective.event_id !== event.supersedesEventId) {
				throw new StorageFailure("model context supersession does not target the effective event");
			}
		} else if (effective) {
			throw new StorageFailure("model context update must supersede the effective event");
		}
		this.#database.prepare(`
			INSERT INTO model_context_events (
				event_id, session_id, turn_id, provider_step, section_key, blob_id,
				supersedes_event_id, tombstone, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			event.eventId,
			event.sessionId,
			event.turnId,
			event.providerStep,
			event.sectionKey,
			blobId,
			event.supersedesEventId ?? null,
			event.tombstone ? 1 : 0,
			event.createdAt,
		);
	}

	#assertContextEventBatch(
		manifest: ProviderRequestManifest,
		events: readonly ModelContextEvent[],
		manifestExisted: boolean,
	): void {
		const rows = this.#database.prepare(`
			SELECT ${CONTEXT_EVENT_COLUMNS}
			FROM model_context_events
			WHERE session_id = ? AND turn_id = ? AND provider_step = ?
			ORDER BY rowid
		`).all(
			manifest.sessionId,
			manifest.turnId,
			manifest.providerStep,
		) as readonly ContextEventRow[];
		if (rows.length === 0) return;
		if (!manifestExisted || stableJson(rows.map((row) => this.#contextEvent(row))) !== stableJson(events)) {
			throw new StorageFailure("provider step context events conflict with durable state");
		}
	}

	#insertTimelineEvent(event: ProviderInputTimelineEvent): void {
		const blobId = this.#putBlob(event, event.createdAt);
		const existing = this.#timelineEventRow(event.eventId);
		if (existing) {
			if (existing.session_id !== event.sessionId || existing.window_id !== event.windowId
				|| existing.turn_id !== event.turnId || existing.provider_step !== event.providerStep
				|| existing.kind !== event.kind || existing.blob_id !== blobId
				|| nullableText(existing.model_context_event_id) !== event.modelContextEventId
				|| existing.created_at !== event.createdAt) {
				throw new StorageFailure("provider input timeline event id collides with different content");
			}
			this.#blob(blobId);
			return;
		}
		if (event.modelContextEventId !== undefined) {
			const context = this.#contextEventRow(event.modelContextEventId);
			if (!context || context.session_id !== event.sessionId) {
				throw new StorageFailure("provider input timeline references unavailable model context");
			}
		}
		const latest = this.#database.prepare(`
			SELECT ${TIMELINE_EVENT_COLUMNS}
			FROM provider_input_timeline_events
			WHERE session_id = ?
			ORDER BY sequence_no DESC
			LIMIT 1
		`).get(event.sessionId) as TimelineEventRow | undefined;
		if (event.kind === "window_boundary") {
			if (latest?.window_id === event.windowId) {
				throw new StorageFailure("provider input timeline window boundary is duplicated");
			}
		} else if (!latest || latest.window_id !== event.windowId) {
			throw new StorageFailure("provider input timeline item has no active window boundary");
		}
		this.#database.prepare(`
			INSERT INTO provider_input_timeline_events (
				event_id, session_id, window_id, turn_id, provider_step, kind,
				blob_id, model_context_event_id, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			event.eventId,
			event.sessionId,
			event.windowId,
			event.turnId,
			event.providerStep,
			event.kind,
			blobId,
			event.modelContextEventId ?? null,
			event.createdAt,
		);
	}

	#assertTimelineEventBatch(
		manifest: ProviderRequestManifest,
		events: readonly ProviderInputTimelineEvent[],
		manifestExisted: boolean,
	): void {
		const rows = this.#database.prepare(`
			SELECT ${TIMELINE_EVENT_COLUMNS}
			FROM provider_input_timeline_events
			WHERE session_id = ? AND turn_id = ? AND provider_step = ?
			ORDER BY sequence_no
		`).all(
			manifest.sessionId,
			manifest.turnId,
			manifest.providerStep,
		) as readonly TimelineEventRow[];
		if (rows.length === 0) return;
		if (!manifestExisted || stableJson(rows.map((row) => this.#timelineEvent(row))) !== stableJson(events)) {
			throw new StorageFailure("provider step timeline events conflict with durable state");
		}
	}

	#validateManifestReferences(
		manifest: ProviderRequestManifest,
		instructions: InstructionSnapshot,
		toolSet: ToolSetSnapshot,
	): void {
		const references = new Set<string>();
		for (const reference of manifest.orderedItems) {
			const identity = `${reference.kind}:${reference.id}`;
			if (references.has(identity)) {
				throw new StorageFailure("provider request manifest contains duplicate references");
			}
			references.add(identity);
			if (reference.kind === "instruction_snapshot") {
				if (reference.id !== instructions.snapshotId
					|| reference.contentSha256 !== instructions.contentSha256) {
					throw new StorageFailure("provider request instruction reference does not match");
				}
			}
			if (reference.kind === "tool_set_snapshot") {
				if (reference.id !== toolSet.snapshotId
					|| reference.contentSha256 !== toolSet.contentSha256) {
					throw new StorageFailure("provider request tool-set reference does not match");
				}
			}
			if (reference.kind === "context_event") {
				const eventRow = this.#contextEventRow(reference.id);
				if (!eventRow || eventRow.session_id !== manifest.sessionId || Boolean(eventRow.tombstone)) {
					throw new StorageFailure("provider request references unavailable model context");
				}
				const event = this.#contextEvent(eventRow);
				if (!event.fragment || event.fragment.contentSha256 !== reference.contentSha256
					|| (reference.role !== undefined && event.fragment.role !== reference.role)) {
					throw new StorageFailure("provider request model context reference does not match");
				}
			}
			if (reference.kind === "provider_timeline_event") {
				const eventRow = this.#timelineEventRow(reference.id);
				if (!eventRow || eventRow.session_id !== manifest.sessionId) {
					throw new StorageFailure("provider request references unavailable timeline event");
				}
				const event = this.#timelineEvent(eventRow);
				if (!event.item || event.contentSha256 !== reference.contentSha256
					|| (reference.role !== undefined && timelineItemRole(event.item) !== reference.role)) {
					throw new StorageFailure("provider request timeline reference does not match");
				}
			}
		}
		if (manifest.schemaVersion === 2) {
			const rows = this.#database.prepare(`
				SELECT ${TIMELINE_EVENT_COLUMNS}
				FROM provider_input_timeline_events
				WHERE session_id = ? AND window_id = ?
				ORDER BY sequence_no
			`).all(manifest.sessionId, manifest.timelineWindowId) as readonly TimelineEventRow[];
			const eventIds = rows.map((row) => String(row.event_id));
			if (stableJson(eventIds) !== stableJson(manifest.timelineEventIds)) {
				throw new StorageFailure("provider request timeline event order does not match its window");
			}
			const modelVisibleIds = rows
				.filter((row) => row.kind !== "window_boundary")
				.map((row) => String(row.event_id));
			const referencedIds = manifest.orderedItems
				.filter((reference) => reference.kind === "provider_timeline_event")
				.map((reference) => reference.id);
			if (stableJson(modelVisibleIds) !== stableJson(referencedIds)) {
				throw new StorageFailure("provider request manifest does not replay its complete timeline window");
			}
		}
	}

	#insertManifest(manifest: ProviderRequestManifest, request: ProviderRequest): void {
		const manifestBlobId = this.#putBlob(manifest, manifest.createdAt);
		const requestBlobId = this.#putBlob(request, manifest.createdAt);
		const existing = this.#manifestRow(manifest.requestId);
		if (existing) {
			if (existing.session_id !== manifest.sessionId || existing.turn_id !== manifest.turnId
				|| existing.provider_step !== manifest.providerStep
				|| existing.manifest_blob_id !== manifestBlobId
				|| existing.logical_request_blob_id !== requestBlobId
				|| existing.request_signature !== manifest.requestSignature
				|| existing.logical_input_sha256 !== manifest.logicalInputSha256
				|| existing.logical_request_sha256 !== requestBlobId
				|| nullableText(existing.previous_request_id) !== manifest.previousManifestId
				|| nullableText(existing.boundary) !== manifestBoundaryColumn(manifest.boundary)
				|| existing.created_at !== manifest.createdAt) {
				throw new StorageFailure("provider request id collides with different content");
			}
			this.#blob(manifestBlobId);
			this.#blob(requestBlobId);
			return;
		}
		const latest = this.#database.prepare(`
			SELECT ${MANIFEST_COLUMNS}
			FROM provider_request_manifests
			WHERE session_id = ?
			ORDER BY rowid DESC
			LIMIT 1
		`).get(manifest.sessionId) as ManifestRow | undefined;
		if (!latest) {
			if (manifest.boundary !== "bootstrap" || manifest.previousManifestId !== undefined) {
				throw new StorageFailure("first provider request requires a bootstrap boundary");
			}
		} else {
			if (manifest.boundary === "bootstrap") {
				throw new StorageFailure("bootstrap boundary is only valid for the first provider request");
			}
			if (manifest.previousManifestId !== latest.request_id) {
				throw new StorageFailure("provider request does not extend the latest durable manifest");
			}
		}
		this.#database.prepare(`
			INSERT INTO provider_request_manifests (
				request_id, session_id, turn_id, provider_step, manifest_blob_id,
				logical_request_blob_id, request_signature, logical_input_sha256,
				logical_request_sha256, previous_request_id, boundary, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			manifest.requestId,
			manifest.sessionId,
			manifest.turnId,
			manifest.providerStep,
			manifestBlobId,
			requestBlobId,
			manifest.requestSignature,
			manifest.logicalInputSha256,
			requestBlobId,
			manifest.previousManifestId ?? null,
			manifestBoundaryColumn(manifest.boundary) ?? null,
			manifest.createdAt,
		);
	}

	#insertLifecycleEvent(event: ProviderStepLifecycleEvent, committing: boolean): void {
		const existing = this.#lifecycleRow(event.eventId);
		if (existing) {
			if (stableJson(lifecycleEvent(existing)) !== stableJson(event)) {
				throw new StorageFailure("provider-step event id collides with different content");
			}
			return;
		}
		const manifest = this.#manifestRow(event.requestId);
		if (!manifest || manifest.session_id !== event.sessionId) {
			throw new StorageFailure("provider-step event references an unavailable request");
		}
		const priorRows = this.#database.prepare(`
			SELECT ${LIFECYCLE_COLUMNS}
			FROM provider_step_events
			WHERE request_id = ?
			ORDER BY sequence_no
		`).all(event.requestId) as readonly LifecycleRow[];
		if (event.state === "prepared") {
			if (!committing || priorRows.length > 0) {
				throw new StorageFailure("prepared provider-step event must be first and atomically committed");
			}
		} else {
			const latest = priorRows.at(-1);
			if (!latest || !validLifecycleTransition(String(latest.state), event.state)) {
				throw new StorageFailure("invalid provider-step lifecycle transition");
			}
		}
		this.#database.prepare(`
			INSERT INTO provider_step_events (
				event_id, request_id, session_id, state, payload_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?)
		`).run(
			event.eventId,
			event.requestId,
			event.sessionId,
			event.state,
			stableJson(event.payload),
			event.createdAt,
		);
	}

	#putBlob(value: unknown, createdAt: string): string {
		const blob = modelInputBlob(value);
		const existing = this.#database.prepare(`
			SELECT blob_id, payload_json, created_at
			FROM model_input_blobs
			WHERE blob_id = ?
		`).get(blob.id) as BlobRow | undefined;
		if (existing) {
			if (existing.payload_json !== blob.json) {
				throw new StorageFailure("model-input blob hash collides with different content");
			}
			return blob.id;
		}
		this.#database.prepare(`
			INSERT INTO model_input_blobs (blob_id, payload_json, created_at)
			VALUES (?, ?, ?)
		`).run(blob.id, blob.json, createdAt);
		return blob.id;
	}

	#loadSnapshot<Value>(
		table: "instruction_snapshots" | "tool_set_snapshots",
		sessionId: string,
		snapshotId: string,
		normalize: (value: Value) => Value,
	): Value | undefined {
		this.#requireIdentifier(sessionId, "session");
		this.#requireIdentifier(snapshotId, "model-input snapshot");
		const row = this.#database.prepare(`
			SELECT ${SNAPSHOT_COLUMNS}
			FROM ${table}
			WHERE session_id = ? AND snapshot_id = ?
		`).get(sessionId, snapshotId) as SnapshotRow | undefined;
		return row ? this.#snapshot(row, normalize) : undefined;
	}

	#loadLatestSnapshot<Value>(
		table: "instruction_snapshots" | "tool_set_snapshots",
		sessionId: string,
		normalize: (value: Value) => Value,
	): Value | undefined {
		this.#requireIdentifier(sessionId, "session");
		const row = this.#database.prepare(`
			SELECT ${SNAPSHOT_COLUMNS}
			FROM ${table}
			WHERE session_id = ?
			ORDER BY rowid DESC
			LIMIT 1
		`).get(sessionId) as SnapshotRow | undefined;
		return row ? this.#snapshot(row, normalize) : undefined;
	}

	#snapshot<Value>(row: SnapshotRow, normalize: (value: Value) => Value): Value {
		const value = normalize(this.#blob(String(row.blob_id)) as Value);
		const snapshot = value as Value & {
			readonly snapshotId: string;
			readonly contentSha256: string;
			readonly createdAt: string;
		};
		if (row.snapshot_id !== snapshot.snapshotId || row.content_sha256 !== snapshot.contentSha256
			|| row.created_at !== snapshot.createdAt) {
			throw new StorageFailure("model-input snapshot row does not match its immutable blob");
		}
		return value;
	}

	#contextEvent(row: ContextEventRow): ModelContextEvent {
		const event = normalizeModelContextEvent(this.#blob(String(row.blob_id)) as ModelContextEvent);
		if (row.event_id !== event.eventId || row.session_id !== event.sessionId
			|| row.turn_id !== event.turnId || row.provider_step !== event.providerStep
			|| row.section_key !== event.sectionKey
			|| nullableText(row.supersedes_event_id) !== event.supersedesEventId
			|| Boolean(row.tombstone) !== event.tombstone || row.created_at !== event.createdAt) {
			throw new StorageFailure("model context event row does not match its immutable blob");
		}
		return event;
	}

	#timelineEvent(row: TimelineEventRow): ProviderInputTimelineEvent {
		const event = normalizeProviderInputTimelineEvent(
			this.#blob(String(row.blob_id)) as ProviderInputTimelineEvent,
		);
		if (row.event_id !== event.eventId || row.session_id !== event.sessionId
			|| row.window_id !== event.windowId || row.turn_id !== event.turnId
			|| row.provider_step !== event.providerStep || row.kind !== event.kind
			|| nullableText(row.model_context_event_id) !== event.modelContextEventId
			|| row.created_at !== event.createdAt) {
			throw new StorageFailure("provider input timeline row does not match its immutable blob");
		}
		return event;
	}

	#manifest(row: ManifestRow): ProviderRequestManifest {
		const manifest = normalizeProviderRequestManifest(
			this.#blob(String(row.manifest_blob_id)) as ProviderRequestManifest,
		);
		if (row.request_id !== manifest.requestId || row.session_id !== manifest.sessionId
			|| row.turn_id !== manifest.turnId || row.provider_step !== manifest.providerStep
			|| row.request_signature !== manifest.requestSignature
			|| row.logical_input_sha256 !== manifest.logicalInputSha256
			|| nullableText(row.previous_request_id) !== manifest.previousManifestId
				|| nullableText(row.boundary) !== manifestBoundaryColumn(manifest.boundary)
				|| row.created_at !== manifest.createdAt) {
			throw new StorageFailure("provider request manifest row does not match its immutable blob");
		}
		return manifest;
	}

	#reconstructProviderStep(requestId: string): CommittedProviderStep {
		this.#requireIdentifier(requestId, "provider request");
		const row = this.#manifestRow(requestId);
		if (!row) throw new StorageFailure("provider request manifest does not exist");
		const manifest = this.#manifest(row);
		const request = normalizeProviderRequest(
			this.#blob(String(row.logical_request_blob_id)) as ProviderRequest,
		);
		const requestBlob = modelInputBlob(request);
		if (row.logical_request_sha256 !== requestBlob.id
			|| row.logical_request_blob_id !== requestBlob.id) {
			throw new StorageFailure("logical provider request row does not match its immutable blob");
		}
		const instructions = this.#loadSnapshot(
			"instruction_snapshots",
			manifest.sessionId,
			manifest.instructionSnapshotId,
			normalizeInstructionSnapshot,
		);
		const toolSet = this.#loadSnapshot(
			"tool_set_snapshots",
			manifest.sessionId,
			manifest.toolSetSnapshotId,
			normalizeToolSetSnapshot,
		);
		if (!instructions || !toolSet) {
			throw new StorageFailure("provider request snapshots are unavailable");
		}
		validateManifestLogicalDigest(manifest, instructions, toolSet);
		assertRequestMatchesSnapshots(request, manifest, instructions, toolSet);
		this.#validateManifestReferences(manifest, instructions, toolSet);
		const events = this.loadProviderStepEvents(manifest.requestId);
		if (events[0]?.state !== "prepared") {
			throw new StorageFailure("provider request is not durably prepared");
		}
		return Object.freeze({ manifest, request });
	}

	#unconfirmedProviderSteps(sessionId: string): readonly UnconfirmedProviderStep[] {
		this.#requireIdentifier(sessionId, "session");
		const rows = this.#database.prepare(`
			SELECT ${LIFECYCLE_COLUMNS}
			FROM provider_step_events AS event
			WHERE event.session_id = ?
				AND event.sequence_no = (
					SELECT MAX(latest.sequence_no)
					FROM provider_step_events AS latest
					WHERE latest.request_id = event.request_id
				)
				AND event.state IN ('prepared', 'dispatch_started', 'unknown')
			ORDER BY event.sequence_no
		`).all(sessionId) as readonly LifecycleRow[];
		return Object.freeze(rows.map((row) => Object.freeze({
			...this.#reconstructProviderStep(String(row.request_id)),
			latestEvent: lifecycleEvent(row),
		})));
	}

	#blob(blobId: string): unknown {
		const row = this.#database.prepare(`
			SELECT blob_id, payload_json, created_at
			FROM model_input_blobs
			WHERE blob_id = ?
		`).get(blobId) as BlobRow | undefined;
		if (!row || typeof row.payload_json !== "string") {
			throw new StorageFailure("model-input blob does not exist");
		}
		let value: unknown;
		try {
			value = JSON.parse(row.payload_json) as unknown;
		} catch {
			throw new StorageFailure("model-input blob contains invalid JSON");
		}
		const canonical = modelInputBlob(value);
		if (row.blob_id !== canonical.id || row.payload_json !== canonical.json) {
			throw new StorageFailure("model-input blob content hash does not match");
		}
		return value;
	}

	#manifestRow(requestId: string): ManifestRow | undefined {
		return this.#database.prepare(`
			SELECT ${MANIFEST_COLUMNS}
			FROM provider_request_manifests
			WHERE request_id = ?
		`).get(requestId) as ManifestRow | undefined;
	}

	#contextEventRow(eventId: string): ContextEventRow | undefined {
		return this.#database.prepare(`
			SELECT ${CONTEXT_EVENT_COLUMNS}
			FROM model_context_events
			WHERE event_id = ?
		`).get(eventId) as ContextEventRow | undefined;
	}

	#timelineEventRow(eventId: string): TimelineEventRow | undefined {
		return this.#database.prepare(`
			SELECT ${TIMELINE_EVENT_COLUMNS}
			FROM provider_input_timeline_events
			WHERE event_id = ?
		`).get(eventId) as TimelineEventRow | undefined;
	}

	#lifecycleRow(eventId: string): LifecycleRow | undefined {
		return this.#database.prepare(`
			SELECT ${LIFECYCLE_COLUMNS}
			FROM provider_step_events
			WHERE event_id = ?
		`).get(eventId) as LifecycleRow | undefined;
	}

	#loadLifecycleEvent(eventId: string): ProviderStepLifecycleEvent {
		const row = this.#lifecycleRow(eventId);
		if (!row) throw new StorageFailure("provider-step lifecycle event does not exist");
		return lifecycleEvent(row);
	}

	#requireSession(sessionId: string): void {
		const row = this.#database.prepare(`
			SELECT 1 AS present FROM sessions WHERE session_id = ?
		`).get(sessionId) as { readonly present: unknown } | undefined;
		if (!row) throw new StorageFailure("model-input session does not exist");
	}

	#requireIdentifier(value: string, label: string): void {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
			throw new StorageFailure(`${label} id is invalid`);
		}
	}

	#read<Result>(operation: () => Result): Result {
		try {
			return operation();
		} catch (error) {
			if (error instanceof StorageFailure) throw error;
			throw new StorageFailure("model-input ledger read failed");
		}
	}
}

function lifecycleEvent(row: LifecycleRow): ProviderStepLifecycleEvent {
	if (typeof row.payload_json !== "string") {
		throw new StorageFailure("provider-step lifecycle payload is invalid");
	}
	let payload: unknown;
	try {
		payload = JSON.parse(row.payload_json) as unknown;
	} catch {
		throw new StorageFailure("provider-step lifecycle payload is invalid");
	}
	return normalizeLifecycleEvent({
		eventId: String(row.event_id),
		requestId: String(row.request_id),
		sessionId: String(row.session_id),
		state: String(row.state) as ProviderStepLifecycleState,
		payload: payload as ProviderStepLifecycleEvent["payload"],
		createdAt: String(row.created_at),
	});
}

function validLifecycleTransition(
	current: string,
	next: Exclude<ProviderStepLifecycleState, "prepared">,
): boolean {
	if (current === "prepared") {
		return next === "dispatch_started" || next === "failed" || next === "unknown";
	}
	if (current === "dispatch_started") {
		return next === "acknowledged" || next === "failed" || next === "unknown";
	}
	if (current === "unknown") return next === "acknowledged" || next === "failed";
	return false;
}

function nullableText(value: unknown): string | undefined {
	return value === null || value === undefined ? undefined : String(value);
}

function manifestBoundaryColumn(
	boundary: ProviderRequestManifest["boundary"],
): "bootstrap" | "continuation_reset" | "compaction" | undefined {
	if (boundary === "legacy_bootstrap" || boundary === "source_reset") return "continuation_reset";
	return boundary;
}

function timelineItemRole(
	item: ProviderInputTimelineEvent["item"],
): "developer" | "user" | undefined {
	if (item?.type === "user") return "user";
	if (item?.type === "context") return item.metadata.role ?? "user";
	return undefined;
}

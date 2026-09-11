import { createHash } from "node:crypto";
import { StorageFailure } from "../../sessions/session-store.ts";
import { stableJson } from "../../stable-json.ts";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export interface V10TranscriptSourceHashRow {
	readonly sequence_no: unknown;
	readonly session_id: unknown;
	readonly event_id: unknown;
	readonly turn_id: unknown;
	readonly event_type: unknown;
	readonly provider_index: unknown;
	readonly model_visible: unknown;
	readonly payload_json: unknown;
	readonly created_at: unknown;
}

export interface V10ModelInputSourceHashRow {
	readonly blob_id: unknown;
	readonly payload_json: unknown;
	readonly created_at: unknown;
}

export function v10TranscriptSourceHash(row: V10TranscriptSourceHashRow): string {
	return sourceHash({
		sequenceNo: row.sequence_no,
		sessionId: row.session_id,
		eventId: row.event_id,
		turnId: row.turn_id,
		eventType: row.event_type,
		providerIndex: row.provider_index,
		modelVisible: row.model_visible,
		payloadJson: row.payload_json,
		createdAt: row.created_at,
	});
}

export function v10ModelInputSourceHash(row: V10ModelInputSourceHashRow): string {
	return sourceHash({
		blobId: row.blob_id,
		payloadJson: row.payload_json,
		createdAt: row.created_at,
	});
}

function sourceHash(value: unknown): string {
	const digest = createHash("sha256").update(stableJson(value)).digest("hex");
	if (!HASH_PATTERN.test(digest)) {
		throw new StorageFailure("content-blob migration source hash is invalid");
	}
	return digest;
}

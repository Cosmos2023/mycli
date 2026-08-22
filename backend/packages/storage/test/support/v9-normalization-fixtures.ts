import Database from "better-sqlite3";
import { SQLiteSessionStore } from "../../src/index.ts";

export const LEGACY_SCHEMA_VERSIONS = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9] as const);

export type LegacySchemaVersion = (typeof LEGACY_SCHEMA_VERSIONS)[number];

export const MALFORMED_CONVERSATION_PAYLOAD = '{"role":"user","content":';
export const MALFORMED_HISTORY_PAYLOAD = '{"id":';
export const MALFORMED_ROLLOUT_PAYLOAD = '["not-a-rollout"';
export const OPAQUE_VALID_CONVERSATION_PAYLOAD = JSON.stringify({
	role: "legacy_event",
	payload: { shape: "preserve-verbatim" },
});
export const OPAQUE_VALID_HISTORY_PAYLOAD = JSON.stringify({
	id: "opaque-history",
	type: "future_activity",
	payload: { shape: "preserve-verbatim" },
});

export const RICH_V9_SESSION_IDS = Object.freeze({
	node: "fixture-node-shape",
	python: "fixture-python-shape",
	conversationOnly: "fixture-conversation-only",
	historyOnly: "fixture-history-only",
	repeatedCompaction: "fixture-repeated-compaction",
	forkParent: "fixture-fork-parent",
	forkChild: "fixture-fork-child",
	activeRecovery: "fixture-active-recovery",
	malformedConversation: "fixture-malformed-conversation",
	malformedHistory: "fixture-malformed-history",
	malformedRollout: "fixture-malformed-rollout",
	opaqueConversation: "fixture-opaque-conversation",
	opaqueHistory: "fixture-opaque-history",
	copiedRealProjectionFailures: Object.freeze([
		"fixture-copied-real-failure-1",
		"fixture-copied-real-failure-2",
		"fixture-copied-real-failure-3",
	] as const),
});

export interface LegacyNormalizationFixtureOptions {
	readonly dbPath: string;
	readonly workspaceRoot: string;
}

export interface VersionedLegacyNormalizationFixtureOptions
	extends LegacyNormalizationFixtureOptions {
	readonly sourceSchemaVersion: LegacySchemaVersion;
}

export interface LegacyNormalizationFixture {
	readonly dbPath: string;
	readonly workspaceRoot: string;
	readonly sourceSchemaVersion: LegacySchemaVersion;
}

const NOW = "2026-08-14T00:00:00.000Z";
const REQUEST_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const IMAGE_DATA = "Zml4dHVyZS1pbWFnZQ==";

export function createVersionedLegacyNormalizationFixture(
	options: VersionedLegacyNormalizationFixtureOptions,
): LegacyNormalizationFixture {
	const sessionId = `fixture-schema-v${options.sourceSchemaVersion}`;
	const store = new SQLiteSessionStore({ dbPath: options.dbPath, clock: () => NOW });
	try {
		seedCompletedTurn(store, options.workspaceRoot, sessionId, "version", "legacy version payload");
	} finally {
		store.close();
	}
	if (options.sourceSchemaVersion !== 9) {
		downgradeV9Fixture(options.dbPath, options.sourceSchemaVersion);
	}
	return Object.freeze({
		dbPath: options.dbPath,
		workspaceRoot: options.workspaceRoot,
		sourceSchemaVersion: options.sourceSchemaVersion,
	});
}

export function createRichV9NormalizationFixture(
	options: LegacyNormalizationFixtureOptions,
): LegacyNormalizationFixture {
	const store = new SQLiteSessionStore({ dbPath: options.dbPath, clock: () => NOW });
	try {
		seedNodeShape(store, options.workspaceRoot);
		seedRepeatedCompaction(store, options.workspaceRoot);
		seedFork(store, options.workspaceRoot);
		seedActiveRecovery(store, options.workspaceRoot);
	} finally {
		store.close();
	}

	const database = new Database(options.dbPath);
	try {
		seedPythonShape(database, options.workspaceRoot);
		seedOneSidedSessions(database, options.workspaceRoot);
		seedMalformedAndOpaqueRows(database, options.workspaceRoot);
		seedCopiedRealProjectionFailures(database, options.workspaceRoot);
	} finally {
		database.close();
	}
	return Object.freeze({
		dbPath: options.dbPath,
		workspaceRoot: options.workspaceRoot,
		sourceSchemaVersion: 9,
	});
}

function seedNodeShape(store: SQLiteSessionStore, workspaceRoot: string): void {
	const sessionId = RICH_V9_SESSION_IDS.node;
	store.reserveTurn({
		sessionId,
		clientTurnId: "node-client",
		clientUserMessageId: "node-user",
		turnId: "node-turn",
		requestFingerprint: REQUEST_FINGERPRINT,
		workspaceRoot,
		threadId: sessionId,
		userText: "inspect two files with an image",
		imagePaths: ["fixture-image.png"],
		images: [{ mediaType: "image/png", data: IMAGE_DATA }],
		startedAt: NOW,
	});
	store.appendAssistantToolCalls({
		sessionId,
		clientTurnId: "node-client",
		assistantText: "I will inspect both files.",
		calls: [
			{ callId: "node-call-read", name: "Read", argumentsJson: '{"path":"a.ts"}' },
			{ callId: "node-call-grep", name: "Grep", argumentsJson: '{"pattern":"TODO"}' },
		],
		responseId: "node-response",
	});
	for (const [callId, toolName, output] of [
		["node-call-read", "Read", "node read output"],
		["node-call-grep", "Grep", "node grep output"],
	] as const) {
		store.appendToolResult({
			sessionId,
			clientTurnId: "node-client",
			result: { callId, toolName, output, success: true },
			summary: `${toolName} complete`,
		});
	}
	store.completeTurn({
		sessionId,
		clientTurnId: "node-client",
		assistantText: "Both files were inspected.",
		usage: { input_tokens: 120, output_tokens: 40 },
		responseId: "node-response-final",
		completedAt: NOW,
	});
}

function seedRepeatedCompaction(store: SQLiteSessionStore, workspaceRoot: string): void {
	const sessionId = RICH_V9_SESSION_IDS.repeatedCompaction;
	seedCompletedTurn(store, workspaceRoot, sessionId, "first", "first visible turn");
	store.commitCompaction({
		sessionId,
		replacementMessages: [pythonMessage("user", "[compact-summary]\nfirst summary")],
		summary: "first summary",
		checkpoint: compactCheckpoint(1, "fixture-window-1", `${sessionId}-turn-first`, "first summary"),
	});
	seedCompletedTurn(store, workspaceRoot, sessionId, "second", "second visible turn");
	store.commitCompaction({
		sessionId,
		replacementMessages: [pythonMessage("user", "[compact-summary]\nsecond summary")],
		summary: "second summary",
		checkpoint: compactCheckpoint(2, "fixture-window-2", `${sessionId}-turn-second`, "second summary"),
	});
}

function seedFork(store: SQLiteSessionStore, workspaceRoot: string): void {
	seedCompletedTurn(
		store,
		workspaceRoot,
		RICH_V9_SESSION_IDS.forkParent,
		"parent",
		"parent turn",
	);
	store.forkSession({
		sourceSessionId: RICH_V9_SESSION_IDS.forkParent,
		targetSessionId: RICH_V9_SESSION_IDS.forkChild,
		forkPoint: 2,
	});
}

function seedActiveRecovery(store: SQLiteSessionStore, workspaceRoot: string): void {
	const sessionId = RICH_V9_SESSION_IDS.activeRecovery;
	store.reserveTurn({
		sessionId,
		clientTurnId: "active-client",
		clientUserMessageId: "active-user",
		turnId: "active-turn",
		requestFingerprint: REQUEST_FINGERPRINT,
		workspaceRoot,
		threadId: sessionId,
		userText: "write the recovery fixture",
		startedAt: NOW,
	});
	store.appendAssistantToolCalls({
		sessionId,
		clientTurnId: "active-client",
		assistantText: "",
		calls: [{
			callId: "active-call",
			name: "Write",
			argumentsJson: '{"file_path":"fixture.txt","content":"fixture"}',
		}],
		responseId: "active-response",
	});
	const toolCall = {
		name: "Write",
		arguments: { file_path: "fixture.txt", content: "fixture" },
		reason: "",
		call_id: "active-call",
	} as const;
	store.saveApprovalSuspension({
		sessionId,
		workspaceRoot,
		threadId: sessionId,
		pendingDecision: {
			kind: "pending_decision",
			version: 1,
			payload: {
				tool_call: toolCall,
				kind: "needs_choice",
				reason: "Approval required",
				preview: "Write fixture.txt",
				options: ["approve_once", "reject"],
			},
		},
		suspendedTurn: {
			kind: "suspended_turn",
			version: 1,
			payload: {
				user_message: "write the recovery fixture",
				conversation: [pythonMessage("user", "write the recovery fixture")],
				suspend_reason: "approval_required",
				pending_approval: {
					tool_call: toolCall,
					reason: "Approval required",
					preview: "Write fixture.txt",
				},
				session_id: sessionId,
				client_turn_id: "active-client",
				client_user_message_id: "active-user",
				turn_id: "active-turn",
				provider_protocol: "responses",
				remaining_tool_calls: [],
				continuation: {
					assistant_text: "",
					response_id: "active-response",
					usage: {},
				},
			},
		},
		turnRecord: {
			turn_id: "active-turn",
			client_turn_id: "active-client",
			user_message: "write the recovery fixture",
			status: "waiting_approval",
			stop_reason: "approval_required",
			updated_at: NOW,
		},
		checkpoint: {
			sessionId,
			clientTurnId: "active-client",
			turnId: "active-turn",
			decisionId: "active-call",
			callId: "active-call",
			toolName: "Write",
			status: "waiting",
			updatedAt: NOW,
		},
	});
}

function seedCompletedTurn(
	store: SQLiteSessionStore,
	workspaceRoot: string,
	sessionId: string,
	suffix: string,
	userText: string,
): void {
	store.reserveTurn({
		sessionId,
		clientTurnId: `${sessionId}-client-${suffix}`,
		clientUserMessageId: `${sessionId}-user-${suffix}`,
		turnId: `${sessionId}-turn-${suffix}`,
		requestFingerprint: REQUEST_FINGERPRINT,
		workspaceRoot,
		threadId: sessionId,
		userText,
		startedAt: NOW,
	});
	store.completeTurn({
		sessionId,
		clientTurnId: `${sessionId}-client-${suffix}`,
		assistantText: `${userText} answer`,
		usage: {},
		completedAt: NOW,
	});
}

function seedPythonShape(database: Database.Database, workspaceRoot: string): void {
	const sessionId = RICH_V9_SESSION_IDS.python;
	insertSession(database, sessionId, workspaceRoot);
	const messages = [
		{
			role: "user",
			content: "Python unicode payload: \u4f60\u597d",
			tool_call_id: null,
			response_id: null,
			metadata: { turn_id: "python-turn", source: "python_runtime" },
			blocks: [],
			tool_calls: [],
		},
		{
			role: "assistant",
			content: "Reading from Python.",
			tool_call_id: null,
			response_id: "python-response",
			metadata: { turn_id: "python-turn", source: "python_runtime" },
			blocks: [{
				type: "tool_call",
				text: null,
				tool_name: "Read",
				tool_arguments: { path: "python.py" },
				call_id: "python-call",
				provider_id: null,
				metadata: {},
			}],
			tool_calls: [{
				name: "Read",
				arguments: { path: "python.py" },
				reason: "model requested tool",
				call_id: "python-call",
			}],
		},
		{
			role: "tool",
			content: "python tool output",
			tool_call_id: "python-call",
			response_id: null,
			metadata: { turn_id: "python-turn", tool_name: "Read", success: true },
			blocks: [],
			tool_calls: [],
		},
		pythonMessage("assistant", "Python turn complete."),
	];
	for (const [index, message] of messages.entries()) {
		insertConversation(database, sessionId, index, JSON.stringify(message));
	}
	const history = [
		pythonHistory("python-user", "python-turn", "user_message", "Python unicode payload: \u4f60\u597d"),
		pythonHistory("python-call", "python-turn", "tool_call", "", {
			tool_name: "Read",
			call_id: "python-call",
			metadata: { arguments: { path: "python.py" }, source: "python_runtime" },
		}),
		pythonHistory("python-result", "python-turn", "tool_result", "Read complete", {
			tool_name: "Read",
			call_id: "python-call",
			metadata: { transcript_content: "python tool output", success: true },
		}),
		pythonHistory("python-assistant", "python-turn", "assistant_message", "Python turn complete."),
	];
	for (const item of history) insertHistory(database, sessionId, String(item.id), JSON.stringify(item));
	insertRollout(database, sessionId, "python-turn", JSON.stringify({
		thread_id: sessionId,
		turn_id: "python-turn",
		status: "completed",
		started_at: NOW,
		completed_at: NOW,
		stop_reason: "assistant_completed",
		events: [],
		continuation_state: { response_id: "python-response", usage: {} },
	}));
}

function seedOneSidedSessions(database: Database.Database, workspaceRoot: string): void {
	insertSession(database, RICH_V9_SESSION_IDS.conversationOnly, workspaceRoot);
	insertConversation(
		database,
		RICH_V9_SESSION_IDS.conversationOnly,
		0,
		JSON.stringify(pythonMessage("user", "conversation without readable history")),
	);

	insertSession(database, RICH_V9_SESSION_IDS.historyOnly, workspaceRoot);
	const history = pythonHistory(
		"history-only-user",
		"history-only-turn",
		"user_message",
		"history without provider conversation",
	);
	insertHistory(database, RICH_V9_SESSION_IDS.historyOnly, String(history.id), JSON.stringify(history));
}

function seedMalformedAndOpaqueRows(database: Database.Database, workspaceRoot: string): void {
	insertSession(database, RICH_V9_SESSION_IDS.malformedConversation, workspaceRoot);
	insertConversation(
		database,
		RICH_V9_SESSION_IDS.malformedConversation,
		0,
		MALFORMED_CONVERSATION_PAYLOAD,
	);

	insertSession(database, RICH_V9_SESSION_IDS.malformedHistory, workspaceRoot);
	insertHistory(database, RICH_V9_SESSION_IDS.malformedHistory, "malformed-history", MALFORMED_HISTORY_PAYLOAD);

	insertSession(database, RICH_V9_SESSION_IDS.malformedRollout, workspaceRoot);
	insertRollout(database, RICH_V9_SESSION_IDS.malformedRollout, "malformed-turn", MALFORMED_ROLLOUT_PAYLOAD);

	insertSession(database, RICH_V9_SESSION_IDS.opaqueConversation, workspaceRoot);
	insertConversation(
		database,
		RICH_V9_SESSION_IDS.opaqueConversation,
		0,
		OPAQUE_VALID_CONVERSATION_PAYLOAD,
	);

	insertSession(database, RICH_V9_SESSION_IDS.opaqueHistory, workspaceRoot);
	insertHistory(
		database,
		RICH_V9_SESSION_IDS.opaqueHistory,
		"opaque-history",
		OPAQUE_VALID_HISTORY_PAYLOAD,
	);
}

function seedCopiedRealProjectionFailures(database: Database.Database, workspaceRoot: string): void {
	// The real-copy baseline retained only the bounded error class. These sanitized rows keep
	// three distinct unprojectable structures without copying session ids or transcript content.
	const payloads = [
		{ role: "assistant", content: null, blocks: [], tool_calls: [] },
		{ role: "tool", content: "legacy result", tool_call_id: null, blocks: [], tool_calls: [] },
		{ role: "system", content: "legacy system item", blocks: [], tool_calls: [] },
	] as const;
	for (const [index, sessionId] of RICH_V9_SESSION_IDS.copiedRealProjectionFailures.entries()) {
		insertSession(database, sessionId, workspaceRoot);
		insertConversation(database, sessionId, 0, JSON.stringify(payloads[index]));
		const history = pythonHistory(
			`${sessionId}-history`,
			`${sessionId}-turn`,
			"user_message",
			"sanitized readable fallback",
		);
		insertHistory(database, sessionId, String(history.id), JSON.stringify(history));
	}
}

function insertSession(database: Database.Database, sessionId: string, workspaceRoot: string): void {
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, 'active')
	`).run(sessionId, workspaceRoot, sessionId, NOW, NOW, NOW);
}

function insertConversation(
	database: Database.Database,
	sessionId: string,
	messageIndex: number,
	payloadJson: string,
): void {
	database.prepare(`
		INSERT INTO conversation_messages (session_id, message_index, payload_json)
		VALUES (?, ?, ?)
	`).run(sessionId, messageIndex, payloadJson);
}

function insertHistory(
	database: Database.Database,
	sessionId: string,
	itemId: string,
	payloadJson: string,
): void {
	database.prepare(`
		INSERT INTO history_items (session_id, item_id, payload_json)
		VALUES (?, ?, ?)
	`).run(sessionId, itemId, payloadJson);
}

function insertRollout(
	database: Database.Database,
	sessionId: string,
	turnId: string,
	payloadJson: string,
): void {
	database.prepare(`
		INSERT INTO turn_rollouts (session_id, turn_id, payload_json)
		VALUES (?, ?, ?)
	`).run(sessionId, turnId, payloadJson);
}

function pythonMessage(role: "user" | "assistant", content: string) {
	return {
		role,
		content,
		tool_call_id: null,
		response_id: null,
		metadata: {},
		blocks: [],
		tool_calls: [],
	};
}

function pythonHistory(
	id: string,
	turnId: string,
	type: "user_message" | "assistant_message" | "tool_call" | "tool_result",
	text: string,
	overrides: Readonly<Record<string, unknown>> = {},
) {
	return {
		id,
		thread_id: "python-thread",
		turn_id: turnId,
		type,
		text,
		tool_name: null,
		call_id: null,
		metadata: {},
		...overrides,
	};
}

function compactCheckpoint(
	windowNumber: number,
	windowId: string,
	turnId: string,
	summary: string,
) {
	return {
		version: 1,
		turn_id: turnId,
		reason: "context_limit",
		phase: "pre_turn",
		window_number: windowNumber,
		window_id: windowId,
		history_item_count: windowNumber * 2,
		input_history_hash: `sha256:input-${windowNumber}`,
		replacement_history_hash: `sha256:replacement-${windowNumber}`,
		replacement_messages: [pythonMessage("user", `[compact-summary]\n${summary}`)],
		status: "completed",
	};
}

function downgradeV9Fixture(dbPath: string, version: Exclude<LegacySchemaVersion, 9>): void {
	const database = new Database(dbPath);
	try {
		database.pragma("foreign_keys = OFF");
		restoreLegacySearchProjection(database);
		if (version <= 7) dropAgentEffectSchema(database);
		if (version <= 6) dropShellOutputSchema(database);
		if (version <= 5) dropProviderTimelineSchema(database);
		if (version <= 4) dropModelInputSchema(database);
		if (version <= 3) database.exec("DROP TABLE IF EXISTS agent_mailbox_items");
		if (version === 2) dropV3AgentSchema(database);
		database.prepare("UPDATE schema_version SET version = ?").run(version);
	} finally {
		database.close();
	}
}

function dropAgentEffectSchema(database: Database.Database): void {
	database.exec(`
		DROP TRIGGER IF EXISTS agent_effect_attempt_outcomes_no_delete;
		DROP TRIGGER IF EXISTS agent_effect_attempt_outcomes_no_update;
		DROP TRIGGER IF EXISTS agent_effect_attempts_no_delete;
		DROP TRIGGER IF EXISTS agent_effect_attempts_no_update;
		DROP TABLE IF EXISTS agent_effect_attempt_outcomes;
		DROP TABLE IF EXISTS agent_effect_attempts;
	`);
}

function dropShellOutputSchema(database: Database.Database): void {
	database.exec(`
		DROP TRIGGER IF EXISTS shell_output_chunks_no_update;
		DROP TABLE IF EXISTS shell_output_chunks;
	`);
}

function dropProviderTimelineSchema(database: Database.Database): void {
	database.exec(`
		DROP TRIGGER IF EXISTS provider_input_timeline_events_no_delete;
		DROP TRIGGER IF EXISTS provider_input_timeline_events_no_update;
		DROP TABLE IF EXISTS provider_input_timeline_events;
	`);
}

function dropModelInputSchema(database: Database.Database): void {
	database.exec(`
		DROP TRIGGER IF EXISTS provider_step_events_no_delete;
		DROP TRIGGER IF EXISTS provider_step_events_no_update;
		DROP TRIGGER IF EXISTS provider_request_manifests_no_delete;
		DROP TRIGGER IF EXISTS provider_request_manifests_no_update;
		DROP TRIGGER IF EXISTS model_context_events_no_delete;
		DROP TRIGGER IF EXISTS model_context_events_no_update;
		DROP TRIGGER IF EXISTS tool_set_snapshots_no_delete;
		DROP TRIGGER IF EXISTS tool_set_snapshots_no_update;
		DROP TRIGGER IF EXISTS instruction_snapshots_no_delete;
		DROP TRIGGER IF EXISTS instruction_snapshots_no_update;
		DROP TRIGGER IF EXISTS model_input_blobs_no_delete;
		DROP TRIGGER IF EXISTS model_input_blobs_no_update;
		DROP TABLE IF EXISTS provider_step_events;
		DROP TABLE IF EXISTS provider_request_manifests;
		DROP TABLE IF EXISTS model_context_events;
		DROP TABLE IF EXISTS tool_set_snapshots;
		DROP TABLE IF EXISTS instruction_snapshots;
		DROP TABLE IF EXISTS model_input_blobs;
	`);
}

function dropV3AgentSchema(database: Database.Database): void {
	database.exec(`
		DROP TABLE IF EXISTS agent_runtime_leases;
		DROP TABLE IF EXISTS agent_spawn_edges;
		DROP TABLE IF EXISTS agent_threads;
		DROP TABLE IF EXISTS runtime_turns;
		CREATE TABLE runtime_turns (
			session_id TEXT NOT NULL,
			client_turn_id TEXT NOT NULL,
			turn_id TEXT NOT NULL,
			request_fingerprint TEXT NOT NULL,
			status TEXT NOT NULL,
			error_code TEXT,
			result_json TEXT,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			PRIMARY KEY (session_id, client_turn_id),
			FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
		);
	`);
}

export function restoreLegacySearchProjection(database: Database.Database): void {
	database.exec(`
		DROP TRIGGER IF EXISTS conversation_messages_fts_insert;
		DROP TRIGGER IF EXISTS conversation_messages_fts_delete;
		DROP TRIGGER IF EXISTS conversation_messages_fts_update;
		DROP TRIGGER IF EXISTS history_items_fts_insert;
		DROP TRIGGER IF EXISTS history_items_fts_delete;
		DROP TRIGGER IF EXISTS history_items_fts_update;
		DROP TABLE IF EXISTS conversation_messages_fts;
		DROP TABLE IF EXISTS history_items_fts;

		CREATE VIRTUAL TABLE conversation_messages_fts USING fts5(
			session_id UNINDEXED,
			message_index UNINDEXED,
			content
		);
		CREATE TRIGGER conversation_messages_fts_insert
		AFTER INSERT ON conversation_messages BEGIN
			INSERT INTO conversation_messages_fts(rowid, session_id, message_index, content)
			VALUES (new.rowid, new.session_id, new.message_index, new.payload_json);
		END;
		CREATE TRIGGER conversation_messages_fts_delete
		AFTER DELETE ON conversation_messages BEGIN
			DELETE FROM conversation_messages_fts WHERE rowid = old.rowid;
		END;
		CREATE TRIGGER conversation_messages_fts_update
		AFTER UPDATE ON conversation_messages BEGIN
			DELETE FROM conversation_messages_fts WHERE rowid = old.rowid;
			INSERT INTO conversation_messages_fts(rowid, session_id, message_index, content)
			VALUES (new.rowid, new.session_id, new.message_index, new.payload_json);
		END;

		CREATE VIRTUAL TABLE history_items_fts USING fts5(
			session_id UNINDEXED,
			item_id UNINDEXED,
			sequence_no UNINDEXED,
			content
		);
		CREATE TRIGGER history_items_fts_insert
		AFTER INSERT ON history_items BEGIN
			INSERT INTO history_items_fts(rowid, session_id, item_id, sequence_no, content)
			VALUES (
				new.rowid,
				new.session_id,
				new.item_id,
				new.sequence_no,
				COALESCE(json_extract(new.payload_json, '$.text'), new.payload_json)
			);
		END;
		CREATE TRIGGER history_items_fts_delete
		AFTER DELETE ON history_items BEGIN
			DELETE FROM history_items_fts WHERE rowid = old.rowid;
		END;
		CREATE TRIGGER history_items_fts_update
		AFTER UPDATE ON history_items BEGIN
			DELETE FROM history_items_fts WHERE rowid = old.rowid;
			INSERT INTO history_items_fts(rowid, session_id, item_id, sequence_no, content)
			VALUES (
				new.rowid,
				new.session_id,
				new.item_id,
				new.sequence_no,
				COALESCE(json_extract(new.payload_json, '$.text'), new.payload_json)
			);
		END;

		INSERT INTO conversation_messages_fts(rowid, session_id, message_index, content)
		SELECT rowid, session_id, message_index, payload_json FROM conversation_messages;
		INSERT INTO history_items_fts(rowid, session_id, item_id, sequence_no, content)
		SELECT rowid, session_id, item_id, sequence_no,
		       COALESCE(json_extract(payload_json, '$.text'), payload_json)
		FROM history_items;
	`);
}

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import process from "node:process";
import type { QueuedInput } from "../../backend/packages/core/src/index.ts";
import {
	projectTranscript,
	SQLiteSessionStore,
	type RuntimeStateKey,
} from "../../backend/packages/storage/src/index.ts";
import { selectProviderContinuation } from "../../backend/packages/runtime/src/provider-continuation.ts";
import Database from "better-sqlite3";

type JsonObject = Record<string, unknown>;

interface Command {
	readonly action: "write" | "read" | "read_invalid";
	readonly db_path: string;
	readonly fixture_path: string;
}

interface Fixture {
	readonly version: number;
	readonly workspace_root: string;
	readonly cases: readonly FixtureCase[];
	readonly invalid_cases: readonly FixtureCase[];
}

interface FixtureCase extends JsonObject {
	readonly id: string;
	readonly session_id: string;
	readonly state_key: string | null;
	readonly expect?: string;
	readonly payload?: unknown;
	readonly expected_error?: string;
}

const NOW = "2026-08-05T00:00:00.000Z";
const STATE_KEYS = new Set<RuntimeStateKey>([
	"input_queue",
	"pending_decision",
	"suspended_turn",
	"turn_record",
	"compact_checkpoint",
	"context_baseline",
	"responses_continuation_state",
	"provider_timeline",
	"node_effect_checkpoint",
]);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
	if (!line.trim()) continue;
	const command = parseCommand(JSON.parse(line) as unknown);
	const fixture = JSON.parse(await readFile(command.fixture_path, "utf8")) as Fixture;
	if (fixture.version !== 1) throw new Error("unsupported M5 parity fixture version");
	let result: readonly JsonObject[];
	if (command.action === "write") {
		writeCases(command.db_path, fixture);
		result = readCases(command.db_path, fixture);
	} else if (command.action === "read") {
		result = readCases(command.db_path, fixture);
	} else {
		result = readInvalidCases(command.db_path, fixture);
	}
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

function writeCases(dbPath: string, fixture: Fixture): void {
	const store = new SQLiteSessionStore({ dbPath, clock: () => NOW });
	try {
		for (const scenario of fixture.cases) {
			if (scenario.expect === "catalog_replay_summary") {
				writeCatalogCase(store, scenario, fixture.workspace_root);
			} else if (scenario.expect === "history_committed_once") {
				writeCommittedQueueCase(store, scenario, fixture.workspace_root);
			} else if (scenario.expect === "deduplicate_original_user") {
				writeLegacyApprovalCase(store, dbPath, scenario, fixture.workspace_root);
			} else {
				writeStateCases(store, scenario, fixture.workspace_root);
			}
			for (const summary of arrayValue(scenario.summaries)) {
				store.appendSessionSummary({
					sessionId: scenario.session_id,
					workspaceRoot: fixture.workspace_root,
					threadId: scenario.session_id,
					summary: requiredString(summary, "summary"),
				});
			}
		}
	} finally {
		store.close();
	}
}

function writeCatalogCase(
	store: SQLiteSessionStore,
	scenario: FixtureCase,
	workspaceRoot: string,
): void {
	const conversation = arrayValue(scenario.conversation).map(recordValue);
	const userText = requiredString(conversation[0]?.content, "catalog user text");
	const assistantText = requiredString(conversation[1]?.content, "catalog assistant text");
	store.reserveTurn({
		sessionId: scenario.session_id,
		clientTurnId: "client-catalog",
		turnId: "turn-catalog",
		requestFingerprint: `sha256:${"c".repeat(64)}`,
		workspaceRoot,
		threadId: scenario.session_id,
		userText,
		startedAt: NOW,
	});
	store.completeTurn({
		sessionId: scenario.session_id,
		clientTurnId: "client-catalog",
		assistantText,
		usage: {},
		completedAt: "2026-08-05T00:00:01.000Z",
	});
}

function writeCommittedQueueCase(
	store: SQLiteSessionStore,
	scenario: FixtureCase,
	workspaceRoot: string,
): void {
	const rawRecord = recordValue(scenario.committed_input);
	const record = queuedInput(rawRecord);
	const finalPayload = recordValue(scenario.payload);
	store.saveState({
		sessionId: scenario.session_id,
		workspaceRoot,
		threadId: scenario.session_id,
		key: "input_queue",
		payload: {
			...finalPayload,
			revision: 1,
			pending_steers: [rawRecord],
		},
	});
	store.commitQueuedInputs({
		sessionId: scenario.session_id,
		turnId: requiredString(rawRecord.target_turn_id, "target_turn_id"),
		records: [record],
	});
}

function writeLegacyApprovalCase(
	store: SQLiteSessionStore,
	dbPath: string,
	scenario: FixtureCase,
	workspaceRoot: string,
): void {
	store.importLegacyConversation({
		sessionId: scenario.session_id,
		workspaceRoot,
		threadId: scenario.session_id,
		messages: [{ role: "user", content: "legacy fixture request" }],
	});
	const database = new Database(dbPath);
	try {
		const insertHistory = database.prepare(`
			INSERT INTO history_items (session_id, item_id, payload_json)
			VALUES (?, ?, ?)
		`);
		for (const raw of arrayValue(scenario.history_items)) {
			const item = recordValue(raw);
			insertHistory.run(
				scenario.session_id,
				requiredString(item.id, "history id"),
				JSON.stringify(item),
			);
		}
		const insertRollout = database.prepare(`
			INSERT INTO turn_rollouts (session_id, turn_id, payload_json)
			VALUES (?, ?, ?)
		`);
		for (const raw of arrayValue(scenario.turn_rollouts)) {
			const rollout = recordValue(raw);
			insertRollout.run(
				scenario.session_id,
				requiredString(rollout.turn_id, "rollout turn id"),
				JSON.stringify(rollout),
			);
		}
	} finally {
		database.close();
	}
}

function writeStateCases(
	store: SQLiteSessionStore,
	scenario: FixtureCase,
	workspaceRoot: string,
): void {
	const states = Array.isArray(scenario.states)
		? scenario.states.map(recordValue)
		: scenario.state_key
			? [{ state_key: scenario.state_key, payload: scenario.payload }]
			: [];
	for (const state of states) {
		store.saveState({
			sessionId: scenario.session_id,
			workspaceRoot,
			threadId: scenario.session_id,
			key: runtimeStateKey(state.state_key),
			payload: state.payload,
		});
	}
}

function readCases(dbPath: string, fixture: Fixture): readonly JsonObject[] {
	const store = new SQLiteSessionStore({ dbPath, clock: () => NOW });
	try {
		return fixture.cases.map((scenario): JsonObject => {
			switch (scenario.expect) {
				case "catalog_replay_summary": {
					const conversation = store.loadConversationItems(scenario.session_id);
					return {
						id: scenario.id,
						conversation_roles: conversation.flatMap((item) => (
							item.type === "user" || item.type === "assistant" ? [item.type] : []
						)),
						history_types: store.loadHistoryItems(scenario.session_id).map(
							(item) => item.type,
						),
						summary_count: store.loadSessionSummaries(scenario.session_id).length,
					};
				}
				case "pending_once":
				case "history_committed_once": {
					const queue = recordValue(store.loadState(scenario.session_id, "input_queue"));
					const pending = arrayValue(queue.pending_steers).map(recordValue);
					return {
						id: scenario.id,
						revision: queue.revision,
						pending_ids: pending.map((item) => item.queue_id),
						committed_ids: [...store.loadCommittedQueueIds(scenario.session_id)].sort(),
						optional_fields_preserved: queue.python_optional_queue === "preserved"
							&& pending.every(
								(item) => item.python_optional_record === "preserved",
							),
					};
				}
				case "reemit_choice": {
					const decision = recordValue(store.loadState(scenario.session_id, "pending_decision"));
					const suspended = recordValue(store.loadState(scenario.session_id, "suspended_turn"));
					const effect = recordValue(store.loadState(
						scenario.session_id,
						"node_effect_checkpoint",
					));
					const toolCall = recordValue(decision.tool_call);
					return {
						id: scenario.id,
						decision_id: toolCall.call_id,
						effect_status: effect.status,
						suspend_reason: suspended.suspend_reason,
						conversation_user_count: arrayValue(suspended.conversation)
							.map(recordValue)
							.filter((message) => message.role === "user").length,
						optional_fields_preserved: decision.python_optional_decision === "preserved",
					};
				}
				case "deduplicate_original_user": {
					const history = store.loadHistoryItems(scenario.session_id);
					const normalized = projectTranscript(
						history,
						store.loadTurnRollouts(scenario.session_id),
					);
					return {
						id: scenario.id,
						raw_user_count: history.filter((item) => item.type === "user_message").length,
						normalized_user_count: normalized.filter(
							(item) => item.type === "user_message",
						).length,
						normalized_history_ids: normalized.map((item) => item.id),
					};
				}
				case "interrupt_unknown": {
					const effect = recordValue(store.loadState(
						scenario.session_id,
						"node_effect_checkpoint",
					));
					return {
						id: scenario.id,
						effect_status: effect.status,
						recovery: "effect_outcome_unknown",
						execute_count: 0,
					};
				}
				case "replacement_visible": {
					const checkpoint = recordValue(store.loadState(
						scenario.session_id,
						"compact_checkpoint",
					));
					return {
						id: scenario.id,
						window_number: checkpoint.window_number,
						replacement_roles: arrayValue(checkpoint.replacement_messages)
							.map((item) => recordValue(item).role),
						summary_count: store.loadSessionSummaries(scenario.session_id).length,
						optional_fields_preserved: checkpoint.python_optional_checkpoint === "preserved",
					};
				}
				case "full_replay": {
					const continuation = recordValue(store.loadState(
						scenario.session_id,
						"responses_continuation_state",
					));
					const decision = selectProviderContinuation({
						protocol: "responses",
						persisted: continuation,
						requestSignature: requiredString(
							continuation.request_signature,
							"request signature",
						),
						model: requiredString(continuation.model, "model"),
						historyBoundary: requiredString(
							continuation.history_boundary,
							"history boundary",
						),
					});
					return {
						id: scenario.id,
						eligible: continuation.eligible,
						failure_reason: continuation.failure_reason,
						request_mode: decision.kind,
						optional_fields_preserved: continuation.python_optional_continuation
							=== "preserved",
					};
				}
				default:
					throw new Error(`unknown M5 fixture expectation: ${String(scenario.expect)}`);
			}
		});
	} finally {
		store.close();
	}
}

function readInvalidCases(dbPath: string, fixture: Fixture): readonly JsonObject[] {
	const store = new SQLiteSessionStore({ dbPath, clock: () => NOW });
	try {
		return fixture.invalid_cases.map((scenario) => {
			let errorCode: string | null = null;
			try {
				store.loadState(scenario.session_id, runtimeStateKey(scenario.state_key));
			} catch (error) {
				errorCode = error instanceof Error && "code" in error
					? String((error as Error & { readonly code: unknown }).code)
					: "session_state_invalid";
			}
			return { id: scenario.id, error_code: errorCode };
		});
	} finally {
		store.close();
	}
}

function queuedInput(value: JsonObject): QueuedInput {
	return Object.freeze({
		queueId: requiredString(value.queue_id, "queue_id"),
		sessionId: requiredString(value.session_id, "session_id"),
		clientTurnId: requiredString(value.client_turn_id, "client_turn_id"),
		targetTurnId: value.target_turn_id === null
			? null
			: requiredString(value.target_turn_id, "target_turn_id"),
		kind: "pending_steer",
		state: "accepted",
		text: requiredString(value.text, "text"),
		imagePaths: Object.freeze(arrayValue(value.image_paths).map(
			(item) => requiredString(item, "image path"),
		)),
		source: requiredString(value.source, "source"),
		createdAt: requiredString(value.created_at, "created_at"),
		updatedAt: requiredString(value.updated_at, "updated_at"),
	});
}

function parseCommand(value: unknown): Command {
	const record = recordValue(value);
	const action = record.action;
	if (action !== "write" && action !== "read" && action !== "read_invalid") {
		throw new Error("invalid M5 parity helper action");
	}
	return {
		action,
		db_path: requiredString(record.db_path, "db_path"),
		fixture_path: requiredString(record.fixture_path, "fixture_path"),
	};
}

function runtimeStateKey(value: unknown): RuntimeStateKey {
	if (typeof value !== "string" || !STATE_KEYS.has(value as RuntimeStateKey)) {
		throw new Error("invalid runtime state key in M5 fixture");
	}
	return value as RuntimeStateKey;
}

function recordValue(value: unknown): JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as JsonObject
		: {};
}

function arrayValue(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${name} must be a non-empty string`);
	}
	return value;
}

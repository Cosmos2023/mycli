import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import { SQLiteSessionStore } from "../../src/index.ts";

export interface SessionScenario {
	readonly session_id: string;
	readonly workspace_root: string;
	readonly thread_id: string;
	readonly client_turn_id: string;
	readonly turn_id: string;
	readonly request_fingerprint: string;
	readonly started_at: string;
	readonly completed_at: string;
	readonly user_text: string;
	readonly assistant_text: string | null;
	readonly response_id: string | null;
	readonly usage: Readonly<Record<string, number>>;
	readonly status: "completed" | "interrupted";
	readonly error_code: "interrupted" | null;
	readonly stop_reason: "assistant_completed" | "interrupted";
}

export interface SessionFixture {
	readonly schema_version: number;
	readonly sessions: readonly SessionScenario[];
}

export async function loadSessionFixture(): Promise<SessionFixture> {
	return JSON.parse(await readFile(
		new URL("../../../../tests/fixtures/node_runtime_m2/session_records.json", import.meta.url),
		"utf8",
	)) as SessionFixture;
}

export function writeNodeSessions(dbPath: string, fixture: SessionFixture): void {
	const store = new SQLiteSessionStore({ dbPath });
	try {
		for (const scenario of fixture.sessions) {
			store.reserveTurn({
				sessionId: scenario.session_id,
				clientTurnId: scenario.client_turn_id,
				clientUserMessageId: scenario.client_turn_id,
				turnId: scenario.turn_id,
				requestFingerprint: scenario.request_fingerprint,
				workspaceRoot: scenario.workspace_root,
				threadId: scenario.thread_id,
				userText: scenario.user_text,
				startedAt: scenario.started_at,
			});
			if (scenario.status === "completed") {
				store.completeTurn({
					sessionId: scenario.session_id,
					clientTurnId: scenario.client_turn_id,
					assistantText: scenario.assistant_text ?? "",
					usage: scenario.usage,
					...(scenario.response_id ? { responseId: scenario.response_id } : {}),
					completedAt: scenario.completed_at,
				});
			} else {
				store.failTurn({
					sessionId: scenario.session_id,
					clientTurnId: scenario.client_turn_id,
					code: "interrupted",
					message: "turn interrupted",
					completedAt: scenario.completed_at,
				});
			}
		}
	} finally {
		store.close();
	}
}

export function readNodeSessions(dbPath: string, fixture: SessionFixture): unknown[] {
	const store = new SQLiteSessionStore({ dbPath });
	let conversations: Readonly<Record<string, readonly unknown[]>>;
	try {
		conversations = Object.fromEntries(fixture.sessions.map((scenario) => [
			scenario.session_id,
			store.loadConversation(scenario.session_id),
		]));
	} finally {
		store.close();
	}
	const database = new Database(dbPath, { readonly: true });
	try {
		return fixture.sessions.map((scenario) => ({
			session_id: scenario.session_id,
			conversation: conversations[scenario.session_id],
			raw_conversation: payloadRows(database, "conversation_messages", scenario.session_id),
			history_items: payloadRows(database, "history_items", scenario.session_id),
			turn_rollouts: payloadRows(database, "turn_rollouts", scenario.session_id),
		}));
	} finally {
		database.close();
	}
}

export function expectedSharedRecords(fixture: SessionFixture): unknown[] {
	return fixture.sessions.map((scenario) => {
		const userMessage = {
			role: "user",
			content: scenario.user_text,
			tool_call_id: null,
			response_id: null,
			metadata: {
				turn_id: scenario.turn_id,
				client_turn_id: scenario.client_turn_id,
				client_user_message_id: scenario.client_turn_id,
				source: "submit",
			},
			blocks: [],
			tool_calls: [],
		};
		const userHistory = {
			id: `${scenario.turn_id}:user:${scenario.client_turn_id}`,
			thread_id: scenario.thread_id,
			turn_id: scenario.turn_id,
			type: "user_message",
			text: scenario.user_text,
			tool_name: null,
			call_id: null,
			metadata: {
				client_turn_id: scenario.client_turn_id,
				client_user_message_id: scenario.client_turn_id,
				source: "submit",
				image_paths: [],
			},
		};
		const rawConversation: unknown[] = [userMessage];
		const conversation: unknown[] = [{ role: "user", content: scenario.user_text }];
		const historyItems: unknown[] = [userHistory];
		let continuationState: Record<string, unknown> = {};
		if (scenario.status === "completed") {
			rawConversation.push({
				role: "assistant",
				content: scenario.assistant_text,
				tool_call_id: null,
				response_id: scenario.response_id,
				metadata: { turn_id: scenario.turn_id, source: "node_runtime" },
				blocks: [],
				tool_calls: [],
			});
			conversation.push({ role: "assistant", content: scenario.assistant_text });
			historyItems.push({
				id: `${scenario.turn_id}:assistant:1`,
				thread_id: scenario.thread_id,
				turn_id: scenario.turn_id,
				type: "assistant_message",
				text: scenario.assistant_text,
				tool_name: null,
				call_id: null,
				metadata: { source: "node_runtime", response_id: scenario.response_id },
			});
			continuationState = { response_id: scenario.response_id, usage: scenario.usage };
		}
		return {
			session_id: scenario.session_id,
			conversation,
			raw_conversation: rawConversation,
			history_items: historyItems,
			turn_rollouts: [{
				thread_id: scenario.thread_id,
				turn_id: scenario.turn_id,
				status: scenario.status,
				started_at: scenario.started_at,
				completed_at: scenario.completed_at,
				stop_reason: scenario.stop_reason,
				events: [],
				continuation_state: continuationState,
			}],
		};
	});
}

export function readNodeRuntimeTurns(
	dbPath: string,
	fixture: SessionFixture,
): Array<RuntimeTurnRecord | undefined> {
	const store = new SQLiteSessionStore({ dbPath });
	try {
		return fixture.sessions.map((scenario) => store.loadTurn(
			scenario.session_id,
			scenario.client_turn_id,
		));
	} finally {
		store.close();
	}
}

function payloadRows(database: Database.Database, table: string, sessionId: string): unknown[] {
	const order = table === "conversation_messages" ? "message_index" : "sequence_no";
	return database.prepare(
		`SELECT payload_json FROM ${table} WHERE session_id = ? ORDER BY ${order}`,
	).all(sessionId).map((row) => JSON.parse(String((row as { payload_json: unknown }).payload_json)) as unknown);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
	const [action, dbPath] = process.argv.slice(2);
	if (!dbPath || (action !== "read" && action !== "write")) {
		throw new Error("usage: parity-helper <read|write> <db-path>");
	}
	const fixture = await loadSessionFixture();
	if (action === "write") writeNodeSessions(dbPath, fixture);
	process.stdout.write(`${JSON.stringify(readNodeSessions(dbPath, fixture))}\n`);
}

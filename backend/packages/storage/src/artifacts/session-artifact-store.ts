import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { TranscriptItem } from "../projections/transcript-projector.ts";
import {
	SessionArtifactPaths,
	subagentRunId,
} from "./session-artifact-paths.ts";
import { stableJson } from "../stable-json.ts";

export type SessionArtifactEventType =
	| "conversation.saved"
	| "subagent.updated"
	| "agent.lifecycle"
	| "agent.progress"
	| "agent.usage"
	| "agent.communication";

export interface AppendSessionArtifactEventInput {
	readonly sessionId: string;
	readonly type: SessionArtifactEventType;
	readonly payload?: Readonly<Record<string, unknown>>;
}

export interface WriteTaskOutputInput {
	readonly sessionId: string;
	readonly taskId: string;
	readonly output: string;
}

export interface WriteSubagentSnapshotInput {
	readonly parentSessionId: string;
	readonly childSessionId: string;
	readonly parentTurnId: string;
	readonly profileId: string;
	readonly threadId?: string;
	readonly rootThreadId?: string;
	readonly parentThreadId?: string;
	readonly agentPath?: string;
	readonly taskName?: string;
	readonly nickname?: string;
	readonly lifecycleKind?: string;
	readonly status: "queued" | "running" | "completed" | "failed" | "interrupted";
	readonly mode?: "foreground" | "background";
	readonly description?: string;
	readonly report?: string;
	readonly toolCalls?: number;
	readonly error?: string;
	readonly startedAt?: string;
	readonly completedAt?: string;
	readonly contextDiagnostics?: Readonly<Record<string, unknown>>;
	readonly messages: readonly TranscriptItem[];
}

export interface SessionSubagentSnapshot {
	readonly schema_version: 1;
	readonly run_id: string;
	readonly parent_session_id: string;
	readonly child_session_id: string;
	readonly parent_turn_id: string;
	readonly role: string;
	readonly thread_id: string;
	readonly root_thread_id?: string;
	readonly parent_thread_id?: string;
	readonly agent_path?: string;
	readonly task_name?: string;
	readonly nickname?: string;
	readonly lifecycle_kind?: string;
	readonly status: WriteSubagentSnapshotInput["status"];
	readonly mode?: WriteSubagentSnapshotInput["mode"];
	readonly description?: string;
	readonly report?: string;
	readonly tool_calls: number;
	readonly error?: string;
	readonly started_at?: string;
	readonly completed_at?: string;
	readonly context_diagnostics: Readonly<Record<string, unknown>>;
	readonly messages: readonly TranscriptItem[];
	readonly file_changes: readonly never[];
}

export interface SessionSubagentIndexEntry {
	readonly run_id: string;
	readonly child_session_id: string;
	readonly parent_turn_id: string;
	readonly role: string;
	readonly thread_id: string;
	readonly root_thread_id?: string;
	readonly parent_thread_id?: string;
	readonly agent_path?: string;
	readonly task_name?: string;
	readonly nickname?: string;
	readonly lifecycle_kind?: string;
	readonly description?: string;
	readonly status: WriteSubagentSnapshotInput["status"];
	readonly mode?: WriteSubagentSnapshotInput["mode"];
	readonly summary: string;
	readonly tool_calls: number;
	readonly error?: string;
	readonly started_at?: string;
	readonly completed_at?: string;
	readonly path: string;
}

export interface SessionArtifactOperations {
	rename(source: string, target: string): Promise<void>;
}

export type SessionArtifactFailpoint =
	| "task_output_before_write"
	| "task_output_before_rename"
	| "subagent_before_write"
	| "subagent_before_rename";

export interface SessionArtifactStoreOptions {
	readonly homeDir: string;
	readonly clock?: () => string;
	readonly operations?: Partial<SessionArtifactOperations>;
	readonly failpoint?: (name: SessionArtifactFailpoint) => void;
}

const TASK_OUTPUT_MAX_CHARS = 131_072;
const SUBAGENT_TEXT_MAX_CHARS = 131_072;
const SUBAGENT_INDEX_SUMMARY_MAX_CHARS = 160;

export class SessionArtifactStore {
	readonly paths: SessionArtifactPaths;
	readonly #clock: () => string;
	readonly #operations: SessionArtifactOperations;
	readonly #failpoint: (name: SessionArtifactFailpoint) => void;

	constructor(options: SessionArtifactStoreOptions) {
		this.paths = new SessionArtifactPaths(options.homeDir);
		this.#clock = options.clock ?? (() => new Date().toISOString());
		this.#operations = { rename: options.operations?.rename ?? rename };
		this.#failpoint = options.failpoint ?? (() => undefined);
	}

	async appendEvent(input: AppendSessionArtifactEventInput): Promise<void> {
		const path = this.paths.eventsPath(input.sessionId);
		await mkdir(dirname(path), { recursive: true });
		const event = {
			...(input.payload ?? {}),
			type: input.type,
			session_id: input.sessionId,
			created_at: this.#clock(),
		};
		const handle = await open(path, "a", 0o600);
		try {
			await handle.writeFile(`${stableJson(event)}\n`, "utf8");
		} finally {
			await handle.close();
		}
	}

	taskOutputPath(sessionId: string, taskId: string): string {
		return this.paths.taskOutputPath(sessionId, taskId);
	}

	async writeTaskOutput(input: WriteTaskOutputInput): Promise<string> {
		const output = boundedString(input.output, TASK_OUTPUT_MAX_CHARS, "task output");
		const target = this.paths.taskOutputPath(input.sessionId, input.taskId);
		await this.#atomicWrite(
			target,
			output,
			"task_output_before_write",
			"task_output_before_rename",
		);
		return target;
	}

	async writeSubagentSnapshot(
		input: WriteSubagentSnapshotInput,
	): Promise<SessionSubagentIndexEntry> {
		const payload = subagentPayload(input);
		const target = this.paths.subagentSnapshotPath(input.parentSessionId, input.childSessionId);
		await this.#atomicWrite(
			target,
			`${JSON.stringify(payload, null, 2)}\n`,
			"subagent_before_write",
			"subagent_before_rename",
		);
		return sessionSubagentIndexEntry(payload);
	}

	async #atomicWrite(
		target: string,
		content: string,
		beforeWrite: SessionArtifactFailpoint,
		beforeRename: SessionArtifactFailpoint,
	): Promise<void> {
		await mkdir(dirname(target), { recursive: true });
		const temporary = `${target}.${randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporary, "wx", 0o600);
			this.#failpoint(beforeWrite);
			await handle.writeFile(content, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			this.#failpoint(beforeRename);
			await this.#operations.rename(temporary, target);
		} finally {
			await handle?.close().catch(() => undefined);
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}
}

export function sessionSubagentIndexEntry(
	input: WriteSubagentSnapshotInput | SessionSubagentSnapshot,
): SessionSubagentIndexEntry {
	const payload = "schema_version" in input ? input : subagentPayload(input);
	return Object.freeze({
		run_id: payload.run_id,
		child_session_id: payload.child_session_id,
		parent_turn_id: payload.parent_turn_id,
		role: payload.role,
		thread_id: payload.thread_id,
		...(payload.root_thread_id === undefined ? {} : { root_thread_id: payload.root_thread_id }),
		...(payload.parent_thread_id === undefined ? {} : { parent_thread_id: payload.parent_thread_id }),
		...(payload.agent_path === undefined ? {} : { agent_path: payload.agent_path }),
		...(payload.task_name === undefined ? {} : { task_name: payload.task_name }),
		...(payload.nickname === undefined ? {} : { nickname: payload.nickname }),
		...(payload.lifecycle_kind === undefined ? {} : { lifecycle_kind: payload.lifecycle_kind }),
		...(payload.description === undefined ? {} : { description: payload.description }),
		status: payload.status,
		...(payload.mode === undefined ? {} : { mode: payload.mode }),
		summary: (payload.report ?? "").trim().slice(0, SUBAGENT_INDEX_SUMMARY_MAX_CHARS),
		tool_calls: payload.tool_calls,
		...(payload.error === undefined ? {} : { error: payload.error }),
		...(payload.started_at === undefined ? {} : { started_at: payload.started_at }),
		...(payload.completed_at === undefined ? {} : { completed_at: payload.completed_at }),
		path: `subagents/${payload.run_id}.json`,
	});
}

function subagentPayload(input: WriteSubagentSnapshotInput): SessionSubagentSnapshot {
	const runId = subagentRunId(input.childSessionId);
	return Object.freeze({
		schema_version: 1,
		run_id: runId,
		parent_session_id: input.parentSessionId,
		child_session_id: input.childSessionId,
		parent_turn_id: boundedString(input.parentTurnId, 256, "parent turn id"),
		role: boundedString(input.profileId, 64, "profile id"),
		thread_id: boundedString(input.threadId ?? input.childSessionId, 256, "thread id"),
		...(input.rootThreadId === undefined ? {} : {
			root_thread_id: boundedString(input.rootThreadId, 256, "root thread id"),
		}),
		...(input.parentThreadId === undefined ? {} : {
			parent_thread_id: boundedString(input.parentThreadId, 256, "parent thread id"),
		}),
		...(input.agentPath === undefined ? {} : {
			agent_path: boundedString(input.agentPath, 512, "agent path"),
		}),
		...(input.taskName === undefined ? {} : {
			task_name: boundedString(input.taskName, 64, "task name"),
		}),
		...(input.nickname === undefined ? {} : {
			nickname: boundedString(input.nickname, 64, "nickname"),
		}),
		...(input.lifecycleKind === undefined ? {} : {
			lifecycle_kind: boundedString(input.lifecycleKind, 64, "lifecycle kind"),
		}),
		status: input.status,
		...(input.mode ? { mode: input.mode } : {}),
		...(input.description === undefined ? {} : {
			description: boundedString(input.description, 2_048, "description"),
		}),
		...(input.report === undefined ? {} : {
			report: boundedString(input.report, SUBAGENT_TEXT_MAX_CHARS, "report"),
		}),
		tool_calls: nonNegativeInteger(input.toolCalls ?? 0, "tool calls"),
		...(input.error === undefined ? {} : {
			error: boundedString(input.error, 4_096, "error"),
		}),
		...(input.startedAt ? { started_at: boundedString(input.startedAt, 64, "started at") } : {}),
		...(input.completedAt ? {
			completed_at: boundedString(input.completedAt, 64, "completed at"),
		} : {}),
		context_diagnostics: Object.freeze({ ...(input.contextDiagnostics ?? {}) }),
		messages: Object.freeze([...input.messages]),
		file_changes: Object.freeze([]),
	});
}

function boundedString(value: unknown, maximum: number, field: string): string {
	if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
		throw new TypeError(`invalid ${field}`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`invalid ${field}`);
	return value as number;
}

import assert from "node:assert/strict";
import test from "node:test";
import { TURN_INTERRUPTED_NOTICE, turnInterruptedNoticeId, projectGatewayToolRecord } from "@mycli/contracts";
import {
	projectTranscript,
	TRANSCRIPT_TEXT_MAX_CHARS,
} from "../../src/index.ts";
import { sanitizeTranscriptItem } from "../../src/projections/transcript-projector.ts";

test("Read ranges survive transcript projection without exposing private tool metadata", () => {
	const projected = projectTranscript([
		{ ...historyItem("read-call", "turn", "tool_call", "Read", {
			arguments: { file_path: "src/app.ts", offset: 10, limit: 20, private: "private-argument" },
		}), tool_name: "Read", call_id: "read" },
		{ ...historyItem("read-result", "turn", "tool_result", "Read src/app.ts", {
			path: "src/app.ts", success: true, actualStartLine: 10, actualEndLine: 29,
			shownLines: 20, totalLines: 120, dedup: false, sha256: "private-digest",
		}), tool_name: "Read", call_id: "read" },
	], []);
	assert.equal(projected.length, 1);
	const restored = sanitizeTranscriptItem(projected[0]);
	assert.ok(restored);
	const record = projectGatewayToolRecord({ text: "Read", metadata: { ...restored.metadata, tool_name: "Read" } });
	assert.equal(record.summary_preview, "Lines 10-29 of 120");
	assert.doesNotMatch(JSON.stringify(projected), /private-argument|private-digest/u);
});

test("terminal interactions retain bounded input and process state across call/result projection", () => {
	const projected = projectTranscript([
		{ ...historyItem("call-item", "turn-1", "tool_call", "WriteStdin", {
			arguments: { session_id: "shell-1", chars: "token=private-input\n" },
		}), tool_name: "WriteStdin", call_id: "input-call" },
		{ ...historyItem("result-item", "turn-1", "tool_result", "Shell is running", {
			success: true, terminal_interaction: { shell_id: "shell-1", kind: "input", input_preview: '"token=private-input"',
				command_preview: "node wait.cjs", interaction_succeeded: true, process_running: true },
		}), tool_name: "WriteStdin", call_id: "input-call" },
	], []);
	assert.equal(projected.length, 1);
	const interaction = projected[0]?.metadata?.terminal_interaction as Record<string, unknown>;
	assert.equal(interaction.kind, "input");
	assert.equal(interaction.command_preview, "node wait.cjs");
	assert.equal(interaction.process_running, true);
	assert.equal(interaction.interaction_succeeded, true);
	assert.doesNotMatch(JSON.stringify(projected), /private-input/u);
	assert.deepEqual(sanitizeTranscriptItem(projected[0])?.metadata?.terminal_interaction, interaction);
});

test("suppresses only legacy synthetic approval-resume user rows", () => {
	const projected = projectTranscript([
		historyItem("original", "turn-original", "user_message", "change it"),
		historyItem("synthetic", "turn-approval", "user_message", "change it"),
	], [approvalRollout("turn-approval")]);

	assert.deepEqual(userTexts(projected), ["change it"]);
});

test("keeps independent repeated and queued user messages", () => {
	const projected = projectTranscript([
		historyItem("original", "turn-original", "user_message", "change it"),
		historyItem("repeated", "turn-repeated", "user_message", "change it"),
		historyItem("queued", "turn-approval", "user_message", "queued follow-up", {
			queued: true,
		}),
		historyItem("synthetic", "turn-approval", "user_message", "change it"),
	], [approvalRollout("turn-approval")]);

	assert.deepEqual(userTexts(projected), ["change it", "change it", "queued follow-up"]);
});

test("places delayed interruption notices after their own user turns", () => {
	const turns = ["turn-1", "turn-2", "turn-3"];
	const inputs = turns.map((turnId) => historyItem(`${turnId}:user`, turnId, "user_message", "same input"));
	const notices = turns.map((turnId) => historyItem(
		turnInterruptedNoticeId(turnId), turnId, "warning", TURN_INTERRUPTED_NOTICE,
		{ event_kind: "turn_interrupted", interrupted_turn_id: turnId, status: "interrupted" },
	));
	const history = [...inputs, ...notices];
	const originalHistory = structuredClone(history);
	const projected = projectTranscript(history, turns.map((turn_id) => ({ turn_id, status: "interrupted" })));

	assert.deepEqual(projected.map((item) => item.id), turns.flatMap((turnId) => [
		`${turnId}:user`, turnInterruptedNoticeId(turnId),
	]));
	assert.deepEqual(projected.map((item) => item.turn_id), turns.flatMap((turnId) => [turnId, turnId]));
	assert.deepEqual(projected.map(sanitizeTranscriptItem).map((item) => item?.turn_id),
		projected.map((item) => item.turn_id));
	assert.deepEqual(history, originalHistory);
});

test("keeps one interruption after merged turn content without moving ordinary warnings", () => {
	const noticeId = turnInterruptedNoticeId("turn-1");
	const projected = projectTranscript([
		historyItem("user-1", "turn-1", "user_message", "run the command"),
		{
			...historyItem("call-1", "turn-1", "tool_call", "Run command"),
			tool_name: "Shell", call_id: "shell-1",
		},
		historyItem("user-2", "turn-2", "user_message", "continue"),
		historyItem("ordinary-warning", "turn-2", "warning", "Command needs attention"),
		historyItem("legacy-notice", "turn-1", "warning", TURN_INTERRUPTED_NOTICE, {
			event_kind: "turn_interrupted",
		}),
		{
			...historyItem("result-1", "turn-1", "tool_result", "stopped", { success: false }),
			tool_name: "Shell", call_id: "shell-1",
		},
		historyItem(noticeId, "turn-1", "warning", TURN_INTERRUPTED_NOTICE),
	], [{ turn_id: "turn-1", status: "interrupted" }]);

	assert.deepEqual(projected.map((item) => item.id), [
		"user-1", "call-1", noticeId, "user-2", "ordinary-warning",
	]);
	assert.equal(projected[1]?.output, "stopped");
	assert.equal(projected[1]?.turn_id, "turn-1");
});

test("anchors synthesized interruptions after merged tools and retains unanchored notices", () => {
	const orphanId = turnInterruptedNoticeId("turn-orphan");
	const projected = projectTranscript([
		historyItem("user-1", "turn-1", "user_message", "run the command"),
		{
			...historyItem("call-1", "turn-1", "tool_call", "Run command"),
			tool_name: "Shell", call_id: "shell-1",
		},
		historyItem("user-2", "turn-2", "user_message", "continue"),
		{
			...historyItem("result-1", "turn-1", "tool_result", "stopped", { success: false }),
			tool_name: "Shell", call_id: "shell-1",
		},
		historyItem(orphanId, "turn-orphan", "warning", TURN_INTERRUPTED_NOTICE),
	], [{ turn_id: "turn-1", status: "interrupted" }]);

	assert.deepEqual(projected.map((item) => item.id), [
		"user-1", "call-1", turnInterruptedNoticeId("turn-1"), "user-2", orphanId,
	]);
});

test("suppresses internal task notifications without hiding tool lifecycle rows", () => {
	const projected = projectTranscript([
		historyItem(
			"task-notification",
			"turn-1",
			"user_message",
			"<task-notification>private child result</task-notification>",
			{ source: "task_notification" },
		),
		{
			...historyItem("wait-call", "turn-1", "tool_call", "Wait for activity"),
			tool_name: "wait_agent",
			call_id: "call-wait",
		},
		{
			...historyItem("wait-result", "turn-1", "tool_result", "Agent activity available", {
				success: true,
			}),
			tool_name: "wait_agent",
			call_id: "call-wait",
		},
	], []);

	assert.equal(projected.length, 1);
	assert.equal(projected[0]?.type, "tool");
	assert.equal(projected[0]?.tool_name, "wait_agent");
	assert.equal(projected[0]?.status, "completed");
	assert.equal(JSON.stringify(projected).includes("private child result"), false);
});

test("suppresses provider-only agent mailbox rows", () => {
	const projected = projectTranscript([
		{
			id: "mailbox-1",
			type: "user_message",
			text: "<agent-mailbox>internal</agent-mailbox>",
			metadata: { source: "agent_mailbox" },
		},
		{
			id: "user-1",
			type: "user_message",
			text: "visible",
			metadata: { source: "submit" },
		},
	], []);
	assert.deepEqual(projected.map((item) => item.text), ["visible"]);
});

test("merges tool calls and results with stable ids and bounded visible metadata", () => {
	const oversized = `${"head".repeat(1_500)}${"tail".repeat(1_500)}`;
	const projected = projectTranscript([
		{
			...historyItem("call-item", "turn-1", "tool_call", "Write notes", {
				arguments: { path: "notes.txt", content: "private body" },
				provider_blob: "provider-private",
			}),
			tool_name: "Write",
			call_id: "call-1",
		},
		{
			...historyItem("result-item", "turn-1", "tool_result", "wrote notes", {
				transcript_content: oversized,
				success: true,
				provider_metadata: { response_id: "private-response" },
				file_changes: [{ path: "notes.txt", kind: "add", diff: "+hello" }],
			}),
			tool_name: "Write",
			call_id: "call-1",
		},
	], []);

	assert.equal(projected.length, 1);
	const tool = projected[0];
	assert.equal(tool?.id, "call-item");
	assert.equal(tool?.type, "tool");
	assert.equal(tool?.call_id, "call-1");
	assert.equal(tool?.status, "completed");
	assert.equal(tool?.output?.length, TRANSCRIPT_TEXT_MAX_CHARS);
	assert.match(tool?.output ?? "", /output omitted/u);
	assert.equal(tool?.truncated, true);
	assert.ok((tool?.omitted_chars ?? 0) > 0);
	assert.deepEqual(tool?.metadata?.file_changes, [
		{ path: "notes.txt", kind: "add", diff: "+hello" },
	]);
	assert.equal("provider_blob" in (tool?.metadata ?? {}), false);
	assert.equal("provider_metadata" in (tool?.metadata ?? {}), false);
	assert.equal(JSON.stringify(tool).includes("private body"), false);
});

test("repairs legacy Node tool preambles and projects a safe Skill name", () => {
	const preamble = "我来先加载仓库分析的指南，同时看一下工作区的基本状态。";
	const projected = projectTranscript([
		{
			...historyItem("skill-call", "turn-1", "tool_call", preamble, {
				source: "node_runtime",
				response_id: "response-tools",
				arguments: { name: "repository-analysis", reason: "private rationale" },
			}),
			tool_name: "Skill",
			call_id: "call-skill",
		},
		{
			...historyItem("shell-call", "turn-1", "tool_call", preamble, {
				source: "node_runtime",
				response_id: "response-tools",
				arguments: { command: "git status --short" },
			}),
			tool_name: "Shell",
			call_id: "call-shell",
		},
		{
			...historyItem("skill-result", "turn-1", "tool_result", "Activated skill", {
				success: true,
			}),
			tool_name: "Skill",
			call_id: "call-skill",
		},
		{
			...historyItem("shell-result", "turn-1", "tool_result", "status output", {
				success: true,
			}),
			tool_name: "Shell",
			call_id: "call-shell",
		},
	], []);

	assert.deepEqual(projected.map((item) => item.type), [
		"assistant_message",
		"tool",
		"tool",
	]);
	assert.equal(projected[0]?.text, preamble);
	assert.equal(projected[1]?.text, undefined);
	assert.equal(projected[1]?.metadata?.skill_name, "repository-analysis");
	assert.equal(projected[2]?.text, undefined);
	assert.equal(projected[2]?.command, "git status --short");
	assert.equal(JSON.stringify(projected).includes("private rationale"), false);
});

test("projects only the parent shell id from legacy polling tool arguments", () => {
	const projected = projectTranscript([
		{
			...historyItem("write-stdin", "turn-1", "tool_call", "", {
				arguments: {
					session_id: "c4b19812",
					chars: "private input",
				},
			}),
			tool_name: "WriteStdin",
			call_id: "call-write-stdin",
		},
		{
			...historyItem("shell-output", "turn-1", "tool_call", "", {
				arguments: { shell_id: "shell-output-id", cursor: 10 },
			}),
			tool_name: "ShellOutput",
			call_id: "call-shell-output",
		},
		{
			...historyItem("bash-output", "turn-1", "tool_call", "", {
				arguments: { bash_id: "bash-output-id", cursor: 20 },
			}),
			tool_name: "BashOutput",
			call_id: "call-bash-output",
		},
		{
			...historyItem("write-stdin-result", "turn-1", "tool_result", "poll output", {
				success: true,
			}),
			tool_name: "WriteStdin",
			call_id: "call-write-stdin",
		},
	], []);

	assert.equal(projected.length, 3);
	assert.equal(projected[0]?.metadata?.shell_id, "c4b19812");
	assert.equal(projected[1]?.metadata?.shell_id, "shell-output-id");
	assert.equal(projected[2]?.metadata?.shell_id, "bash-output-id");
	assert.deepEqual(projected.map((item) => item.status), ["completed", "running", "running"]);
	assert.equal(JSON.stringify(projected).includes("private input"), false);
	assert.equal(projected.some((item) => "arguments" in (item.metadata ?? {})), false);
});

test("merges shell snapshots into the originating tool and marks historical running state stale", () => {
	const completed = projectTranscript([
		{
			...historyItem("call-item", "turn-1", "tool_call", "Run tests", {
				arguments: { command: "private command" },
			}),
			tool_name: "run_shell",
			call_id: "call-shell-1",
		},
		{
			...historyItem("shell:call-shell-1:a1b2c3d4", "turn-1", "shell_session", "", {
				shell_id: "a1b2c3d4",
				command_preview: "npm test",
				process_state: "completed",
				terminal_state: "completed",
				exit_code: 0,
				output: "10 passed\n",
				background: true,
				tty: false,
				yielded: true,
			}),
			tool_name: "run_shell",
			call_id: "call-shell-1",
		},
		{
			...historyItem("result-item", "turn-1", "tool_result", "generic result", {
				success: true,
			}),
			tool_name: "run_shell",
			call_id: "call-shell-1",
		},
	], []);
	const running = projectTranscript([{
		...historyItem("shell:call-shell-2:e5f6a7b8", "turn-2", "shell_session", "", {
			shell_id: "e5f6a7b8",
			command_preview: "npm run dev",
			process_state: "running_background",
			output: "ready\n",
			background: true,
			tty: true,
			yielded: true,
		}),
		tool_name: "Shell",
		call_id: "call-shell-2",
	}], []);

	assert.equal(completed.length, 1);
	assert.equal(completed[0]?.id, "call-item");
	assert.equal(completed[0]?.status, "completed");
	assert.equal(completed[0]?.command, "npm test");
	assert.equal(completed[0]?.output, "10 passed\n");
	assert.equal(completed[0]?.exit_code, 0);
	assert.equal(completed[0]?.metadata?.shell_id, "a1b2c3d4");
	assert.equal(JSON.stringify(completed).includes("private command"), false);
	assert.equal(running[0]?.status, "stale");
	assert.equal(running[0]?.metadata?.process_state, "stale");
});

test("projects reasoning summaries and unknown visible items without provider metadata", () => {
	const projected = projectTranscript([
		historyItem("reasoning", "turn-1", "reasoning", "Inspecting the repository", {
			provider_blob: "raw chain of thought",
			encrypted_content: "private",
		}),
		historyItem("future", "turn-1", "future_visible_event", "A future visible notice", {
			provider_payload: { secret: true },
		}),
		historyItem("internal", "turn-1", "capability", "internal provider capability"),
	], []);

	assert.deepEqual(projected.map((item) => [item.type, item.text]), [
		["reasoning_summary", "Inspecting the repository"],
		["status", "A future visible notice"],
	]);
	assert.equal(JSON.stringify(projected).includes("raw chain of thought"), false);
	assert.equal(JSON.stringify(projected).includes("internal provider capability"), false);
});

test("projects plan metadata only for plan update items", () => {
	const planMetadata = {
		source: "update_plan",
		explanation: "Start implementation",
		completed: 0,
		total: 1,
		items: [{ id: "step-1", text: "Wire runtime", status: "in_progress" }],
	};
	const projected = projectTranscript([
		historyItem("plan", "turn-1", "plan_update", "Updated Plan", planMetadata),
		historyItem("notice", "turn-1", "warning", "Visible warning", planMetadata),
	], []);

	assert.deepEqual(projected[0]?.metadata, planMetadata);
	assert.equal(projected[1]?.metadata, undefined);
});

test("applies pagination after approval normalization", () => {
	const projected = projectTranscript([
		historyItem("first", "turn-1", "user_message", "first"),
		historyItem("synthetic", "turn-approval", "user_message", "synthetic"),
		historyItem("second", "turn-2", "assistant_message", "second"),
		historyItem("third", "turn-3", "warning", "third"),
	], [approvalRollout("turn-approval")], { before: 3, limit: 2 });

	assert.deepEqual(projected.map((item) => item.id), ["second", "third"]);
});

function historyItem(
	id: string,
	turnId: string,
	type: string,
	text: string,
	metadata: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
	return {
		id,
		thread_id: "s1",
		turn_id: turnId,
		type,
		text,
		tool_name: null,
		call_id: null,
		metadata,
	};
}

function approvalRollout(turnId: string): Readonly<Record<string, unknown>> {
	return {
		thread_id: "s1",
		turn_id: turnId,
		status: "completed",
		started_at: "2026-08-04T00:00:00.000Z",
		events: [{
			event_id: `${turnId}:approval`,
			kind: "turn_item",
			created_at: "2026-08-04T00:00:01.000Z",
			payload: { type: "approval_resolution" },
		}],
	};
}

function userTexts(items: readonly { readonly type: string; readonly text?: string }[]): string[] {
	return items
		.filter((item) => item.type === "user_message")
		.map((item) => item.text ?? "");
}

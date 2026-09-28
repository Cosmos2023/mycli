import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NODE_RUNTIME_CONTEXT_DEFAULTS } from "@mycli/config";
import type { ModelProvider } from "@mycli/providers";
import { openRuntimeSessionStore } from "@mycli/storage";
import { GoalTool, UPDATE_GOAL_TOOL_DEFINITION, WRITE_TOOL_DEFINITION } from "@mycli/tools";
import { NodeTurnRuntime, SessionGoalService } from "../../src/index.ts";

for (const status of ["paused", "complete"] as const) {
	for (const stopDuringHook of [false, true]) {
		test(`goal ${status} fences later tools ${stopDuringHook ? "after an awaited hook" : "in the same batch"}`, async (t) => {
			const root = await mkdtemp(join(tmpdir(), "mycli-goal-batch-"));
			const store = openRuntimeSessionStore({ dbPath: join(root, "sessions.db") });
			const goal = new SessionGoalService({ store: store.goals, sessionId: "session", workspaceRoot: root, threadId: "session" });
			t.after(async () => { goal.close(); store.close(); await rm(root, { recursive: true, force: true }); });
			goal.create({ objective: "Stop after current work" });
			const goalTool = new GoalTool("update", "session", goal);
			const executed: string[] = [];
			const postHooks: string[] = [];
			let requests = 0;
			const provider: ModelProvider = { stream: async function* () {
				requests++;
				yield { type: "usage", usage: { input_tokens: 10, output_tokens: 2 } };
				if (requests === 1) {
					if (!stopDuringHook) yield { type: "tool_call", callId: "stop", name: "update_goal", argumentsJson: JSON.stringify({ status }) };
					yield { type: "tool_call", callId: "write", name: "Write", argumentsJson: '{"file_path":"after-stop.txt","content":"unexpected"}' };
				} else yield { type: "text_delta", text: "Finished." };
				yield { type: "completed", responseId: `response-${requests}` };
			} };
			const runtime = new NodeTurnRuntime({ sessionId: "session", workspaceRoot: root, threadId: "session", instructions: "Fixture", store, goal,
				resolveConfig: () => ({ ...NODE_RUNTIME_CONTEXT_DEFAULTS, workspaceRoot: root, homeDir: root, provider: "openai", protocol: "responses", model: "gpt-test",
					apiBaseUrl: "https://example.invalid/v1", apiKey: "test", authRef: "openai", sessionId: "session", sessionsDbPath: join(root, "sessions.db"),
					maxPromptTokens: 100_000, requestMaxRetries: 0, streamMaxRetries: 0, thinkingEnabled: false, reasoningEffort: "none", supportsImages: true,
					webSearchMode: "disabled", requestPermissionsToolEnabled: false, updatesCheckOnStartup: false }),
				createProvider: () => provider, createTurnId: () => "turn", clock: () => new Date().toISOString(), sleep: async () => {}, random: () => 0.5,
				planTools: () => [UPDATE_GOAL_TOOL_DEFINITION, WRITE_TOOL_DEFINITION],
				loadLocalImages: () => [],
				hookRunner: { run: async (invocation) => {
					if (invocation.point === "pre_tool_use" && invocation.toolName === "Write" && stopDuringHook) goal.updateFromTool(status, "turn");
					if (invocation.point === "post_tool_use") postHooks.push(invocation.toolName!);
					return [];
				} },
				toolRouter: { execute: async (call, options) => {
					executed.push(call.name);
					assert.equal(call.name, "update_goal", "Write must never reach the router");
					return { ...await goalTool.execute(JSON.parse(call.argumentsJson), options), callId: call.callId, toolName: call.name };
				} }, publishLifecycle: () => {} });
			const result = await runtime.submit({ clientTurnId: "human", message: "Stop the goal" }, () => {}, { signal: new AbortController().signal });
			assert.equal(result.status, "completed");
			assert.deepEqual(executed, stopDuringHook ? [] : ["update_goal"]);
			assert.deepEqual(postHooks, stopDuringHook ? [] : ["update_goal"]);
			assert.equal(goal.get()?.status, status);
			assert.equal(requests, 2, "final response remains possible");
			const skipped = store.loadConversationItems("session").find((item) => item.type === "tool_result" && item.callId === "write");
			assert.ok(skipped?.type === "tool_result" && !skipped.success);
			assert.match(skipped.output, /not executed/);
		});
	}
}

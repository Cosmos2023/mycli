import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { packagedSystemPrompt } from "../../backend/apps/mycli/src/node-runtime/system-prompt.ts";
import {
	gradePromptResponse, loadPromptCases, promptEvaluationRequest, runPromptEvaluation,
} from "../run-system-prompt-evaluation.mjs";

const CONFIG = { provider: "openai", protocol: "responses", model: "evaluation-model" };

test("loads hash-pinned behavior scenarios and rejects fixture drift", async (t) => {
	const corpus = await loadPromptCases();
	assert.deepEqual(corpus.cases.map((item) => item.id), [
		"initial-preamble", "repeated-shell-wait", "status-keeps-task", "independent-approvals",
		"missing-skill-fallback", "natural-skill-announcement", "existing-write-grant",
	]);
	const root = await mkdtemp(join(tmpdir(), "mycli-prompt-corpus-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = new URL("../../tests/fixtures/system-prompt-evaluation/", import.meta.url);
	await writeFile(join(root, "manifest.json"), await readFile(new URL("manifest.json", source)));
	await writeFile(join(root, "cases.json"), "{}\n");
	await assert.rejects(loadPromptCases(pathToFileURL(`${root}/`)), /fixture_drift/u);
});

test("evaluation uses the packaged prompt, real tool schemas, and runtime context assembly", async () => {
	const { cases } = await loadPromptCases();
	for (const task of cases) {
		const request = promptEvaluationRequest(task, CONFIG);
		assert.equal(request.instructions, packagedSystemPrompt().content);
		assert.deepEqual(request.tools.map((tool) => tool.name).sort(), [...task.tools].sort());
		assert.equal(request.webSearchMode, "disabled");
		assert.ok(request.items.some((item) => item.type === "context"
			&& item.metadata.role === "developer" && item.metadata.kind === "permissions"));
		assert.deepEqual(request.items.filter((item) => item.type === "user"), task.items.filter((item) => item.type === "user"));
		if (task.skills) assert.ok(request.items.some((item) => item.type === "context"
			&& item.metadata.kind === "skill_catalog" && item.text.includes("How to use skills:")));
	}
});

test("grades required next actions and distinguishes text before tools from a late announcement", async () => {
	const { cases } = await loadPromptCases();
	for (const task of cases) {
		assert.equal(gradePromptResponse(task, passingEvents(task)).passed, true, task.id);
		assert.equal(gradePromptResponse(task, [{ type: "text_delta", text: "done" }, { type: "completed" }]).passed, false);
		assert.equal(gradePromptResponse(task, passingEvents(task).filter((event) => event.type !== "completed")).passed, false);
	}
	const initial = cases[0];
	const events = passingEvents(initial);
	assert.equal(gradePromptResponse(initial, [events[1], events[0], events[2]]).passed, false);
	assert.equal(gradePromptResponse(initial, [...events, events[1]]).passed, false);
	assert.equal(gradePromptResponse(initial, [{ ...events[1], argumentsJson: "invalid" }, ...events]).passed, false);
	assert.equal(gradePromptResponse(initial, [events[0], {
		...events[1], argumentsJson: JSON.stringify({ ...initial.expected.calls[0].arguments, invented_parameter: true }),
	}, events[2]]).passed, false);
	const natural = cases.find((task) => task.id === "natural-skill-announcement");
	assert.equal(gradePromptResponse(natural, [{ type: "text_delta", text: "Using using-superpowers to confirm execution rules. " },
		...passingEvents(natural)]).passed, false);
	const waiting = cases.find((task) => task.id === "repeated-shell-wait");
	const omittedEmptyInput = passingEvents(waiting);
	omittedEmptyInput[1].argumentsJson = JSON.stringify({ session_id: "eval-shell-1" });
	assert.equal(gradePromptResponse(waiting, omittedEmptyInput).passed, true);
});

test("evaluation records scores without executing proposed tools or retaining response bodies", async () => {
	const { cases } = await loadPromptCases();
	let requests = 0;
	const report = await runPromptEvaluation({ cases, config: CONFIG, provider: {
		stream: async function* () {
			const task = cases[requests++];
			yield* passingEvents(task);
		},
	} });
	assert.equal(requests, cases.length);
	assert.equal(report.passed, cases.length);
	assert.equal(report.prompt_version, packagedSystemPrompt().version);
	assert.doesNotMatch(JSON.stringify(report), /private-response|argumentsJson|README\.md/u);
});

test("evaluation bounds output and times out a waiting provider without leaking failures", async () => {
	const { cases } = await loadPromptCases();
	let closed = false;
	const excessive = await runPromptEvaluation({ cases: cases.slice(0, 1), config: CONFIG, provider: {
		stream: async function* () {
			try { yield { type: "text_delta", text: "private-response".repeat(30_000) }; }
			finally { closed = true; }
		},
	} });
	assert.equal(closed, true);
	assert.equal(excessive.cases[0].error_code, "output_limit");
	const timeout = await runPromptEvaluation({ cases: cases.slice(0, 1), config: CONFIG, timeoutMs: 10, provider: {
		stream: async function* (_request, { signal }) {
			await delay(60_000, undefined, { signal });
			yield { type: "completed" };
		},
	} });
	assert.equal(timeout.cases[0].error_code, "interrupted_or_timeout");
	assert.doesNotMatch(JSON.stringify([excessive, timeout]), /private-response/u);
});

function passingEvents(task) {
	return [
		{ type: "text_delta", text: "\u6211\u4f1a\u7ee7\u7eed\u6838\u5bf9\u7ed3\u679c\u3002 private-response" },
		...task.expected.calls.map((call, index) => ({ type: "tool_call", callId: `call-${index}`,
			name: call.name, argumentsJson: JSON.stringify(call.arguments) })),
		{ type: "completed" },
	];
}

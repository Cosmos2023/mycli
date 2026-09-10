import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	loadSystemPromptTemplate,
	packagedSystemPrompt,
	SYSTEM_PROMPT_SOURCE,
	SYSTEM_PROMPT_VERSION,
} from "../src/node-runtime/system-prompt.ts";

test("Node system prompt exactly matches its canonical source asset", () => {
	const sourceTemplate = readFileSync(new URL(
		"../src/assets/system.md",
		import.meta.url,
	), "utf8").trim();
	const content = loadSystemPromptTemplate();

	assert.equal(content, sourceTemplate);
	assert.deepEqual(packagedSystemPrompt(), {
		version: SYSTEM_PROMPT_VERSION,
		source: SYSTEM_PROMPT_SOURCE,
		content,
		contentSha256: createHash("sha256").update(content).digest("hex"),
	});
});

test("complete Node system prompt contains the workflow contract", () => {
	const prompt = loadSystemPromptTemplate();
	for (const section of [
		"# Identity",
		"# Tool Discipline",
		"# Tool Calls And Scheduling",
		"# Dirty Worktree Safety",
		"# Autonomy And Persistence",
		"# Verification",
		"# Final Answers",
	]) {
		assert.ok(prompt.includes(section), `missing ${section}`);
	}
	assert.doesNotMatch(prompt, /Do not repeat the same tool call with the same arguments/u);
	assert.match(prompt, /Use `update_plan` to publish the complete current plan/u);
	assert.match(prompt, /issue them together in the same response/u);
	assert.match(prompt, /Built-in `Read`, `Shell`, `web_fetch`, and `tool_search` calls support parallel execution/u);
	assert.match(prompt, /Never parallelize `Write`, `Edit`, `Patch`, `WriteStdin`, `update_plan`, `request_permissions`, or `AskUserQuestion` calls/u);
	assert.match(prompt, /Independent `Shell` calls may be submitted together in the same response, including calls with `sandbox_permissions="require_escalated"`/u);
	assert.match(prompt, /include a concise `justification` in the user's language/u);
	assert.match(prompt, /When a Shell call uses `sandbox_permissions="require_escalated"`/u);
	assert.match(prompt, /Omit `justification` for ordinary Shell calls/u);
	assert.match(prompt, /do not issue extra calls solely to add or improve this display text/u);
	assert.match(prompt, /Answering one approval advances to the next without waiting for the approved command to finish/u);
	assert.match(prompt, /Do not combine them into one command merely to obtain a single approval/u);
	assert.match(prompt, /Each command that requires approval must wait for its own approval before executing/u);
	assert.match(prompt, /remain responsible for its lifecycle and track it as outstanding/u);
	assert.match(prompt, /call `wait_agent`; do not poll with shell commands/u);
	assert.match(prompt, /Read and integrate each relevant report before giving the final answer/u);
	assert.match(prompt, /After compaction or resume, use `list_agents`/u);
});

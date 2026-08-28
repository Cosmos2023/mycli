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
	assert.ok(prompt.length > 8_000);
	assert.match(prompt, /Use `update_plan` to publish the complete current plan/u);
	assert.match(prompt, /issue them together in the same response/u);
	assert.match(prompt, /Built-in `Read`, `Shell`, `web_fetch`, and `tool_search` calls support parallel execution/u);
	assert.match(prompt, /Never parallelize `Write`, `Edit`, `Patch`, `WriteStdin`, planning, permission, or user-interaction calls/u);
	assert.match(prompt, /remain responsible for its lifecycle and track it as outstanding/u);
	assert.match(prompt, /call `wait_agent`; do not poll with shell commands/u);
	assert.match(prompt, /Read and integrate each relevant report before giving the final answer/u);
	assert.match(prompt, /After compaction or resume, use `list_agents`/u);
});

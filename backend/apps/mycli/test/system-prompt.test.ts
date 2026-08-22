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
		"# Dirty Worktree Safety",
		"# Autonomy And Persistence",
		"# Verification",
		"# Final Answers",
	]) {
		assert.ok(prompt.includes(section), `missing ${section}`);
	}
	assert.ok(prompt.length > 8_000);
	assert.match(prompt, /Use `update_plan` to publish the complete current plan/u);
});

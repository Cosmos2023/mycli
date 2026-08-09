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

test("Node system prompt exactly matches the canonical Python template", () => {
	const pythonTemplate = readFileSync(new URL(
		"../../../../src/mycli/prompts/templates/system.md",
		import.meta.url,
	), "utf8").trim();
	const pythonModule = readFileSync(new URL(
		"../../../../src/mycli/prompts/system.py",
		import.meta.url,
	), "utf8");
	const content = loadSystemPromptTemplate();

	assert.equal(content, pythonTemplate);
	assert.match(
		pythonModule,
		new RegExp(`SYSTEM_PROMPT_VERSION = ["']${SYSTEM_PROMPT_VERSION}["']`, "u"),
	);
	assert.deepEqual(packagedSystemPrompt(), {
		version: SYSTEM_PROMPT_VERSION,
		source: SYSTEM_PROMPT_SOURCE,
		content,
		contentSha256: createHash("sha256").update(content).digest("hex"),
	});
});

test("complete Node system prompt contains the Python workflow contract", () => {
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
});

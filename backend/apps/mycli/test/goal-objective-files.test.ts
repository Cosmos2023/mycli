import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GoalObjectiveFiles } from "../src/node-runtime/goal-objective-files.ts";

function fixture(t: { after(fn: () => void): void }): { homeDir: string; files: GoalObjectiveFiles } {
	const homeDir = mkdtempSync(join(tmpdir(), "mycli-goal-files-"));
	t.after(() => rmSync(homeDir, { recursive: true, force: true }));
	return { homeDir, files: new GoalObjectiveFiles({ homeDir }) };
}

test("oversized goal objectives are filed once and keep their full text", (t) => {
	const { homeDir, files } = fixture(t);
	const objective = "Keep every requirement intact. ".repeat(20);

	const path = files.pathFor({ goalId: "goal-1", objective });
	const rewritten = files.pathFor({ goalId: "goal-1", objective });

	assert.equal(rewritten, path);
	assert.equal(path, join(homeDir, ".mycli", "attachments", "goals", "goal-1.md"));
	assert.equal(readFileSync(path, "utf8"), `${objective}\n`);

	const edited = files.pathFor({ goalId: "goal-1", objective: "Shorter objective" });
	assert.equal(edited, path);
	assert.equal(readFileSync(path, "utf8"), "Shorter objective\n");
});

test("goal objective files keep unsafe goal ids inside the attachments directory", (t) => {
	const { homeDir, files } = fixture(t);

	const path = files.pathFor({ goalId: "../../escape", objective: "Objective" });

	assert.equal(path, join(homeDir, ".mycli", "attachments", "goals", ".._.._escape.md"));
	assert.equal(readFileSync(path, "utf8"), "Objective\n");
});

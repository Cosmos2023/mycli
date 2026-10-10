import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Materializes oversized goal objectives under the home directory, Codex-style, so the model
 * reads the objective from a file instead of carrying it through every provider step.
 */
export class GoalObjectiveFiles {
	private readonly written = new Map<string, string>();

	constructor(private readonly options: { readonly homeDir: string }) {}

	/** Writes the objective once per change and returns the absolute path for the reference. */
	pathFor(input: { readonly goalId: string; readonly objective: string }): string {
		const directory = join(this.options.homeDir, ".mycli", "attachments", "goals");
		const path = join(directory, `${objectiveFileStem(input.goalId)}.md`);
		if (this.written.get(path) !== input.objective) {
			mkdirSync(directory, { recursive: true });
			writeFileSync(path, `${input.objective}\n`, "utf8");
			this.written.set(path, input.objective);
		}
		return path;
	}
}

function objectiveFileStem(goalId: string): string {
	const stem = goalId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120);
	return stem || "goal";
}

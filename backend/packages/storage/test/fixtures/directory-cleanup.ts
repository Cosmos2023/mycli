import { rm } from "node:fs/promises";
import { after, type TestContext } from "node:test";

const directories = new Set<string>();

// The file-level hook runs after per-test connections and child processes close.
// Windows cannot remove their live databases or working directories.
after(async () => {
	const failures: unknown[] = [];
	for (const directory of directories) {
		try {
			await rm(directory, { recursive: true, force: true });
		} catch (error) {
			failures.push(error);
		}
	}
	directories.clear();
	if (failures.length > 0) throw new AggregateError(failures, "Fixture directory cleanup failed");
});

export function removeFixtureDirectoryAfterTests(t: TestContext, directory: string): void {
	t.after(() => { directories.add(directory); });
}

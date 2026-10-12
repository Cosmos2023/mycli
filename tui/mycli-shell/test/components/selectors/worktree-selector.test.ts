import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { WorktreeSelectorComponent } from "../../../src/components/selectors/worktree-selector.ts";

const DOWN = "\u001b[B";
const ENTER = "\r";

test("the worktree picker creates a checkout, lists managed ones and resumes their session", async () => {
	const started: unknown[] = [];
	const resumed: string[] = [];
	const selector = new WorktreeSelectorComponent({
		onLoad: async () => [
			{
				path: "/home/.mycli/worktrees/repo-feature",
				name: "feature",
				branch: "feature",
				sessionId: "session-1",
				sessionTitle: "Feature work",
			},
			{ path: "/home/.mycli/worktrees/repo-hotfix", name: "hotfix", branch: "hotfix", current: true },
		],
		onStart: async (request) => { started.push(request); },
		onResume: async (sessionId) => { resumed.push(sessionId); },
		onRemove: async () => undefined,
		onCancel: () => undefined,
	});
	await settle();

	const menu = text(selector);
	assert.match(menu, /New worktree/u);
	assert.match(menu, /Browse worktrees/u);
	assert.match(menu, /2 managed checkouts/u);

	// A bare name field falls back to the gateway's generated name.
	selector.handleInput(ENTER);
	assert.match(text(selector), /Worktree name/u);
	selector.handleInput(ENTER);
	await settle();
	assert.deepEqual(started, [{}]);

	selector.handleInput(DOWN);
	selector.handleInput(ENTER);
	const browse = text(selector);
	assert.match(browse, /Feature work/u);
	assert.match(browse, /branch feature · \/home\/\.mycli\/worktrees\/repo-feature/u);
	assert.match(browse, /hotfix/u);

	selector.handleInput(ENTER);
	assert.match(text(selector), /Resume session in this worktree/u);
	selector.handleInput(ENTER);
	await settle();
	assert.deepEqual(resumed, ["session-1"]);
});

test("the worktree picker refuses to delete the checkout the session runs in", async () => {
	const removed: string[] = [];
	const selector = new WorktreeSelectorComponent({
		onLoad: async () => [
			{ path: "/home/.mycli/worktrees/repo-feature", name: "feature", current: true },
		],
		onStart: async () => undefined,
		onResume: async () => undefined,
		onRemove: async (path) => { removed.push(path); },
		onCancel: () => undefined,
	});
	await settle();

	selector.handleInput(DOWN);
	selector.handleInput(ENTER);
	selector.handleInput(ENTER);
	const actions = text(selector);
	assert.match(actions, /Switch to another checkout before deleting/u);
	assert.match(actions, /Delete worktree \(unavailable\)/u);

	// The disabled delete row cannot be confirmed, so the checkout stays on disk.
	selector.handleInput(DOWN);
	selector.handleInput(ENTER);
	await settle();
	assert.deepEqual(removed, []);
});

function text(selector: WorktreeSelectorComponent): string {
	return selector.render(80).map(stripVTControlCharacters).join("\n");
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

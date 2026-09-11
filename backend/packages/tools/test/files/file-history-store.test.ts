import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as tools from "../../src/index.ts";

interface HistoryStore {
	capture(input: {
		readonly sessionId: string;
		readonly turnId: string;
		readonly toolName: string;
		readonly path: string;
	}): Promise<{ readonly snapshotId: string } | undefined>;
	complete(snapshotId: string): Promise<void>;
	discard(snapshotId: string): Promise<void>;
	listSnapshots(input: { readonly sessionId: string; readonly limit?: number }): Promise<readonly {
		readonly snapshotId: string;
		readonly turnId: string;
		readonly toolName: string;
		readonly path: string;
	}[]>;
	undoLatest(input: { readonly sessionId: string }): Promise<{
		readonly snapshotId?: string;
		readonly restoredPaths: readonly string[];
		readonly deletedPaths: readonly string[];
		readonly error?: string;
	}>;
}

type HistoryStoreConstructor = new (options: {
	readonly homeDir: string;
	readonly workspaceRoot: string;
}) => HistoryStore;

test("persists and restores the latest completed file mutation", async (t) => {
	const fixture = await historyFixture(t);
	await writeFile(fixture.target, "before\n", "utf8");
	const history = createHistory(fixture);
	const captured = await history.capture({
		sessionId: "session-1",
		turnId: "turn-1",
		toolName: "Write",
		path: "a.txt",
	});
	assert.ok(captured);
	await writeFile(fixture.target, "after\n", "utf8");
	await history.complete(captured.snapshotId);
	assert.deepEqual(await history.listSnapshots({ sessionId: "session-1" }), [{
		snapshotId: captured.snapshotId,
		turnId: "turn-1",
		toolName: "Write",
		path: "a.txt",
	}]);

	const reopened = createHistory(fixture);
	const result = await reopened.undoLatest({ sessionId: "session-1" });

	assert.equal(result.snapshotId, captured.snapshotId);
	assert.deepEqual(result.restoredPaths, ["a.txt"]);
	assert.deepEqual(result.deletedPaths, []);
	assert.equal(await readFile(fixture.target, "utf8"), "before\n");
	const second = await reopened.undoLatest({ sessionId: "session-1" });
	assert.equal(second.error, "No file history snapshots.");
	assert.deepEqual(await reopened.listSnapshots({ sessionId: "session-1" }), []);
});

test("undo deletes a file created by the completed mutation", async (t) => {
	const fixture = await historyFixture(t);
	const history = createHistory(fixture);
	const captured = await history.capture({
		sessionId: "session-created",
		turnId: "turn-created",
		toolName: "Write",
		path: "created.txt",
	});
	assert.ok(captured);
	const created = join(fixture.workspaceRoot, "created.txt");
	await writeFile(created, "created\n", "utf8");
	await history.complete(captured.snapshotId);

	const result = await history.undoLatest({ sessionId: "session-created" });

	assert.deepEqual(result.deletedPaths, ["created.txt"]);
	await assert.rejects(() => readFile(created), /ENOENT/u);
});

test("undo refuses to overwrite a file changed after the snapshot", async (t) => {
	const fixture = await historyFixture(t);
	await writeFile(fixture.target, "before\n", "utf8");
	const history = createHistory(fixture);
	const captured = await history.capture({
		sessionId: "session-conflict",
		turnId: "turn-conflict",
		toolName: "Edit",
		path: "a.txt",
	});
	assert.ok(captured);
	await writeFile(fixture.target, "after\n", "utf8");
	await history.complete(captured.snapshotId);
	await writeFile(fixture.target, "manual change\n", "utf8");

	const result = await history.undoLatest({ sessionId: "session-conflict" });

	assert.equal(result.error, "Cannot rewind a.txt: changed after snapshot.");
	assert.equal(await readFile(fixture.target, "utf8"), "manual change\n");
});

test("skips sensitive and oversized files without creating recoverable history", async (t) => {
	const fixture = await historyFixture(t);
	await writeFile(join(fixture.workspaceRoot, ".env"), "SECRET=value\n", "utf8");
	await writeFile(fixture.target, "x".repeat(1_000_001), "utf8");
	const history = createHistory(fixture);

	assert.equal(await history.capture({
		sessionId: "session-safe",
		turnId: "turn-safe",
		toolName: "Write",
		path: ".env",
	}), undefined);
	assert.equal(await history.capture({
		sessionId: "session-safe",
		turnId: "turn-safe",
		toolName: "Write",
		path: "a.txt",
	}), undefined);
	assert.equal((await history.undoLatest({ sessionId: "session-safe" })).error, "No file history snapshots.");
});

function createHistory(fixture: Awaited<ReturnType<typeof historyFixture>>): HistoryStore {
	const Constructor = Reflect.get(tools, "FileHistoryStore") as HistoryStoreConstructor | undefined;
	assert.equal(typeof Constructor, "function", "FileHistoryStore must be exported");
	return new Constructor!({ homeDir: fixture.homeDir, workspaceRoot: fixture.workspaceRoot });
}

async function historyFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly target: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-file-history-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	await mkdir(homeDir);
	await mkdir(workspaceRoot);
	return { root, homeDir, workspaceRoot, target: join(workspaceRoot, "a.txt") };
}

import assert from "node:assert/strict";
import {
	chmod,
	mkdtemp,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as tools from "../src/index.ts";

interface MutationOutcome {
	readonly path: string;
	readonly status: "created" | "overwritten" | "unchanged" | "edited";
	readonly matches?: number;
	readonly diff: string;
	readonly addedLines: number;
	readonly removedLines: number;
}

interface MutationRuntime {
	write(input: {
		readonly path: string;
		readonly content: string;
		readonly history?: { readonly turnId: string; readonly toolName: string };
		readonly signal: AbortSignal;
	}): Promise<MutationOutcome>;
	replace(input: {
		readonly path: string;
		readonly oldString: string;
		readonly newString: string;
		readonly replaceAll: boolean;
		readonly history?: { readonly turnId: string; readonly toolName: string };
		readonly signal: AbortSignal;
	}): Promise<MutationOutcome>;
}

interface SnapshotStore {
	record(snapshot: {
		readonly path: string;
		readonly sha256: string;
		readonly mtimeNs: string;
		readonly size: number;
		readonly capturedAt: string;
	}): void;
	latest(path: string): {
		readonly path: string;
		readonly sha256: string;
		readonly mtimeNs: string;
		readonly size: number;
		readonly capturedAt: string;
	} | undefined;
}

type RuntimeConstructor = new (options: {
	readonly workspaceRoot: string;
	readonly snapshots: SnapshotStore;
	readonly sessionId?: string;
	readonly history?: {
		capture(input: Readonly<Record<string, string>>): Promise<{ readonly snapshotId: string } | undefined>;
		complete(snapshotId: string): Promise<void>;
		discard(snapshotId: string): Promise<void>;
	};
}) => MutationRuntime;
type SnapshotStoreConstructor = new () => SnapshotStore;

test("writes complete content and preserves the existing permission mode", async (t) => {
	const fixture = await mutationFixture(t, "old\n");
	await chmod(fixture.target, 0o640);
	const result = await createRuntime(fixture.root).write({
		path: "a.txt",
		content: "new\n",
		signal: signal(),
	});

	assert.equal(result.status, "overwritten");
	assert.equal(result.path, "a.txt");
	assert.equal(await readFile(fixture.target, "utf8"), "new\n");
	assert.equal((await stat(fixture.target)).mode & 0o777, 0o640);
	assert.equal(result.addedLines, 1);
	assert.equal(result.removedLines, 1);
});

test("returns unchanged without retaining a temporary file", async (t) => {
	const fixture = await mutationFixture(t, "same\n");
	const result = await createRuntime(fixture.root).write({
		path: "a.txt",
		content: "same\n",
		signal: signal(),
	});

	assert.equal(result.status, "unchanged");
	assert.equal(result.diff, "");
	assert.deepEqual(await readdir(fixture.root), ["a.txt"]);
});

test("records only completed mutations in optional durable file history", async (t) => {
	const fixture = await mutationFixture(t, "old\n");
	const snapshots = new (Reflect.get(tools, "FileSnapshotStore") as SnapshotStoreConstructor)();
	const events: string[] = [];
	const history = {
		capture: async (input: Readonly<Record<string, string>>) => {
			events.push(`capture:${input.sessionId}:${input.turnId}:${input.toolName}:${input.path}`);
			return { snapshotId: "snapshot-1" };
		},
		complete: async (snapshotId: string) => { events.push(`complete:${snapshotId}`); },
		discard: async (snapshotId: string) => { events.push(`discard:${snapshotId}`); },
	};
	const Runtime = Reflect.get(tools, "FileMutationRuntime") as unknown as RuntimeConstructor;
	const runtime = new Runtime({
		workspaceRoot: fixture.root,
		snapshots,
		sessionId: "session-1",
		history,
	});

	await runtime.write({
		path: "a.txt",
		content: "new\n",
		history: { turnId: "turn-1", toolName: "Write" },
		signal: signal(),
	});
	await runtime.write({
		path: "a.txt",
		content: "new\n",
		history: { turnId: "turn-2", toolName: "Write" },
		signal: signal(),
	});

	assert.deepEqual(events, [
		"capture:session-1:turn-1:Write:a.txt",
		"complete:snapshot-1",
	]);
});

test("does not fail a completed mutation when history finalization fails", async (t) => {
	const fixture = await mutationFixture(t, "old\n");
	const snapshots = new (Reflect.get(tools, "FileSnapshotStore") as SnapshotStoreConstructor)();
	const Runtime = Reflect.get(tools, "FileMutationRuntime") as unknown as RuntimeConstructor;
	const runtime = new Runtime({
		workspaceRoot: fixture.root,
		snapshots,
		sessionId: "session-1",
		history: {
			capture: async () => ({ snapshotId: "snapshot-1" }),
			complete: async () => { throw new Error("private history path"); },
			discard: async () => undefined,
		},
	});

	const result = await runtime.write({
		path: "a.txt",
		content: "new\n",
		history: { turnId: "turn-1", toolName: "Write" },
		signal: signal(),
	});

	assert.equal(result.status, "overwritten");
	assert.equal(await readFile(fixture.target, "utf8"), "new\n");
});

test("rejects secret-like content without changing the target", async (t) => {
	const fixture = await mutationFixture(t, "old\n");
	await assert.rejects(
		() => createRuntime(fixture.root).write({
			path: "a.txt",
			content: "API_KEY = 'sk-1234567890abcdef'",
			signal: signal(),
		}),
		hasMutationKind("secret_like_content"),
	);
	assert.equal(await readFile(fixture.target, "utf8"), "old\n");
});

test("rejects binary and invalid UTF-8 targets without changing bytes", async (t) => {
	const fixture = await mutationFixture(t, "old\n");
	for (const scenario of [
		{ bytes: Buffer.from([0, 1, 2]), kind: "binary_file" },
		{ bytes: Buffer.from([0xff, 0xfe, 0xfd]), kind: "invalid_encoding" },
	] as const) {
		await writeFile(fixture.target, scenario.bytes);
		await assert.rejects(
			() => createRuntime(fixture.root).write({ path: "a.txt", content: "new\n", signal: signal() }),
			hasMutationKind(scenario.kind),
		);
		assert.deepEqual(await readFile(fixture.target), scenario.bytes);
	}
});

test("enforces content and replacement-target byte limits", async (t) => {
	const fixture = await mutationFixture(t, "old\n");
	await assert.rejects(
		() => createRuntime(fixture.root).write({
			path: "a.txt",
			content: "x".repeat(1_000_001),
			signal: signal(),
		}),
		hasMutationKind("content_too_large"),
	);
	await writeFile(fixture.target, "x".repeat(1_000_001), "utf8");
	const runtime = createRuntime(fixture.root);
	await assert.rejects(
		() => runtime.replace({
			path: "a.txt",
			oldString: "x",
			newString: "y",
			replaceAll: false,
			signal: signal(),
		}),
		hasMutationKind("file_too_large"),
	);
});

test("Write overwrites the content present when it executes", async (t) => {
	const fixture = await mutationFixture(t, "current\n");
	const result = await createRuntime(fixture.root).write({
		path: "a.txt",
		content: "new\n",
		signal: signal(),
	});

	assert.equal(result.status, "overwritten");
	assert.equal(await readFile(fixture.target, "utf8"), "new\n");
});

test("exact replacement reads current content on every execution", async (t) => {
	const fixture = await mutationFixture(t, "value = 1\n");
	const runtime = createRuntime(fixture.root);
	const first = await runtime.replace({
		path: "a.txt",
		oldString: "1",
		newString: "2",
		replaceAll: false,
		signal: signal(),
	});
	const second = await runtime.replace({
		path: "a.txt",
		oldString: "2",
		newString: "3",
		replaceAll: false,
		signal: signal(),
	});

	assert.equal(first.status, "edited");
	assert.equal(first.matches, 1);
	assert.equal(second.status, "edited");
	assert.equal(second.matches, 1);
	assert.equal(await readFile(fixture.target, "utf8"), "value = 3\n");
});

test("aborts before commit and leaves no temporary file", async (t) => {
	const fixture = await mutationFixture(t, "old\n");
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		() => createRuntime(fixture.root).write({ path: "a.txt", content: "new\n", signal: controller.signal }),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
	assert.equal(await readFile(fixture.target, "utf8"), "old\n");
	assert.deepEqual(await readdir(fixture.root), ["a.txt"]);
});

function createRuntime(workspaceRoot: string): MutationRuntime {
	return createRuntimeAndSnapshots(workspaceRoot).runtime;
}

function createRuntimeAndSnapshots(workspaceRoot: string): {
	readonly runtime: MutationRuntime;
	readonly snapshots: SnapshotStore;
} {
	const Runtime = Reflect.get(tools, "FileMutationRuntime") as unknown as RuntimeConstructor | undefined;
	const Store = Reflect.get(tools, "FileSnapshotStore") as SnapshotStoreConstructor | undefined;
	assert.equal(typeof Runtime, "function", "FileMutationRuntime must be exported");
	assert.equal(typeof Store, "function", "FileSnapshotStore must be exported");
	const snapshots = new Store!();
	return { runtime: new Runtime!({ workspaceRoot, snapshots }), snapshots };
}

function hasMutationKind(kind: string): (error: unknown) => boolean {
	return (error) => error instanceof Error
		&& "kind" in error
		&& error.kind === kind
		&& !error.message.includes("API_KEY");
}

function signal(): AbortSignal {
	return new AbortController().signal;
}

async function mutationFixture(t: test.TestContext, content: string): Promise<{
	readonly root: string;
	readonly target: string;
}> {
	const parent = await mkdtemp(join(tmpdir(), "mycli-mutation-runtime-"));
	t.after(async () => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "workspace");
	const target = join(root, "a.txt");
	await mkdir(root);
	await writeFile(target, content, "utf8");
	return { root, target };
}

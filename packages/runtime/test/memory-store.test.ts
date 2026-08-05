import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	symlink,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
	MemoryStore,
	MemoryStoreError,
	type MemoryAtomicFileHandle,
} from "../src/memory-store.ts";

test("derives the Python-compatible memory directory from the real workspace", async (t) => {
	const fixture = await createFixture(t);
	const linkedWorkspace = join(fixture.root, "workspace-link");
	await symlink(fixture.workspace, linkedWorkspace);
	const resolved = await realpath(fixture.workspace);
	const projectKey = resolved
		.replace(/^\/+|\/+$/gu, "")
		.replace(/[^a-zA-Z0-9_.-]+/gu, "-")
		.replace(/^-+|-+$/gu, "") || "default";

	const store = new MemoryStore({
		homeDir: fixture.home,
		workspaceRoot: linkedWorkspace,
	});

	assert.equal(
		await store.directory(),
		join(fixture.home, ".mycli", "projects", projectKey, "memory"),
	);
});

test("bounds MEMORY.md by original line and UTF-8 byte counts with an explicit notice", async (t) => {
	const fixture = await createFixture(t);
	const store = fixture.store;
	const memoryDir = await store.directory();
	const raw = Array.from({ length: 205 }, (_, index) => `${index}:${"界".repeat(100)}`).join("\n");
	await writeFile(join(memoryDir, "MEMORY.md"), raw, "utf8");

	const loaded = await store.loadEntrypoint();

	assert.equal(loaded.lineCount, 205);
	assert.equal(loaded.byteCount, Buffer.byteLength(raw.trim(), "utf8"));
	assert.equal(loaded.wasLineTruncated, true);
	assert.equal(loaded.wasByteTruncated, true);
	assert.match(loaded.content, /WARNING: MEMORY\.md is 205 lines and \d+ bytes/u);
	assert.match(loaded.content, /Only part of it was loaded/u);
});

test("scans at most 200 newest topics and reads only the first 30 frontmatter lines", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	for (let index = 0; index < 201; index += 1) {
		await writeFile(
			join(memoryDir, `topic-${String(index).padStart(3, "0")}.md`),
			index === 200
				? ["---", ...Array.from({ length: 29 }, () => "ignored: value"), "type: user", "---", "body"].join("\n")
				: "---\nname: topic\ndescription: desc\ntype: project\n---\nbody\n",
			"utf8",
		);
	}

	const memories = await fixture.store.scan();

	assert.equal(memories.length, 200);
	const limitedHeader = memories.find((memory) => memory.filename === "topic-200.md");
	assert.equal(limitedHeader?.kind, undefined);
	assert.equal(limitedHeader?.content, "body");
	assert.equal(memories.every((memory) => memory.filename !== "topic-000.md"), true);
});

test("accepts only valid file kinds and decodes topic files as strict UTF-8", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	for (const kind of ["user", "feedback", "project", "reference"] as const) {
		await writeFile(
			join(memoryDir, `${kind}.md`),
			`---\nname: ${kind}\ndescription: ${kind}\ntype: ${kind}\n---\n${kind} body\n`,
			"utf8",
		);
	}
	await writeFile(
		join(memoryDir, "unknown.md"),
		"---\nname: unknown\ntype: session_summary\n---\nunknown body\n",
		"utf8",
	);

	const memories = await fixture.store.scan();
	assert.deepEqual(
		memories.filter((memory) => memory.kind).map((memory) => memory.kind).sort(),
		["feedback", "project", "reference", "user"],
	);
	assert.equal(memories.find((memory) => memory.filename === "unknown.md")?.kind, undefined);

	await writeFile(join(memoryDir, "invalid.md"), Buffer.from([0xff, 0xfe, 0x61]));
	await assert.rejects(
		() => fixture.store.scan(),
		(error: unknown) => error instanceof MemoryStoreError
			&& error.kind === "memory_invalid_utf8"
			&& !error.message.includes("unknown body"),
	);
});

test("rejects a topic symlink escaping the real memory root without leaking its body", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	const outside = join(fixture.root, "outside-secret.md");
	await writeFile(outside, "private-memory-body", "utf8");
	await symlink(outside, join(memoryDir, "escaped.md"));

	await assert.rejects(
		() => fixture.store.scan(),
		(error: unknown) => error instanceof MemoryStoreError
			&& error.kind === "memory_path_escape"
			&& !error.message.includes("private-memory-body")
			&& !JSON.stringify(error.diagnostics).includes("private-memory-body"),
	);
});

test("rejects an escaping MEMORY.md symlink before loading its body", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	const outside = join(fixture.root, "outside-index.md");
	await writeFile(outside, "private-index-body", "utf8");
	await symlink(outside, join(memoryDir, "MEMORY.md"));

	await assert.rejects(
		() => fixture.store.loadEntrypoint(),
		(error: unknown) => memoryPathEscapeWithoutBody(error, "private-index-body"),
	);
});

test("rejects escaping MEMORY.md reads during remember without leaving a topic", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	const outside = join(fixture.root, "outside-index.md");
	await writeFile(outside, "private-index-body", "utf8");
	await symlink(outside, join(memoryDir, "MEMORY.md"));

	await assert.rejects(
		() => fixture.store.remember({
			kind: "user",
			name: "Concurrent Preference",
			description: "preference",
			content: "private topic body",
		}),
		(error: unknown) => memoryPathEscapeWithoutBody(error, "private-index-body"),
	);
	assert.deepEqual(await readdir(memoryDir), ["MEMORY.md"]);
});

test("rejects escaping MEMORY.md reads during forget before deleting a topic", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	const topic = join(memoryDir, "release.md");
	await writeFile(topic, "---\nname: release\ntype: project\n---\nrelease body\n", "utf8");
	const outside = join(fixture.root, "outside-index.md");
	await writeFile(outside, "private-index-body", "utf8");
	await symlink(outside, join(memoryDir, "MEMORY.md"));

	await assert.rejects(
		() => fixture.store.forget("release.md"),
		(error: unknown) => memoryPathEscapeWithoutBody(error, "private-index-body"),
	);
	assert.equal(await readFile(topic, "utf8"), "---\nname: release\ntype: project\n---\nrelease body\n");
});

test("rejects a memory-root symlink swap before an atomic write", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	const movedMemoryDir = `${memoryDir}-moved`;
	const outside = join(fixture.root, "outside-memory");
	await mkdir(outside);
	await rename(memoryDir, movedMemoryDir);
	await symlink(outside, memoryDir);

	await assert.rejects(
		() => fixture.store.remember({
			kind: "project",
			name: "Release",
			description: "release",
			content: "release body",
		}),
		(error: unknown) => error instanceof MemoryStoreError
			&& error.kind === "memory_path_escape",
	);
	assert.deepEqual(await readdir(outside), []);
});

test("does not unlink an outside sentinel when the root swaps after topic rename", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	const movedMemoryDir = `${memoryDir}-moved`;
	const outside = join(fixture.root, "outside-memory-after-rename");
	await mkdir(outside);
	const sentinel = join(outside, "release.md");
	await writeFile(sentinel, "outside sentinel", "utf8");
	let swapped = false;
	const store = new MemoryStore({
		homeDir: fixture.home,
		workspaceRoot: fixture.workspace,
		atomicOperations: {
			open,
			rename: async (source, target) => {
				await rename(source, target);
				if (!swapped && basename(target) === "release.md") {
					swapped = true;
					await rename(memoryDir, movedMemoryDir);
					await symlink(outside, memoryDir);
				}
			},
			unlink,
		},
	});

	await assert.rejects(
		() => store.remember({
			kind: "project",
			name: "Release",
			description: "release",
			content: "owned topic body",
		}),
		(error: unknown) => error instanceof MemoryStoreError
			&& error.kind === "memory_path_escape",
	);
	assert.equal(await readFile(sentinel, "utf8"), "outside sentinel");
	assert.match(await readFile(join(movedMemoryDir, "release.md"), "utf8"), /owned topic body/u);
});

test("writes unique topics and index entries through synced sibling temp files", async (t) => {
	const fixture = await createFixture(t);
	const events: string[] = [];
	const store = new MemoryStore({
		homeDir: fixture.home,
		workspaceRoot: fixture.workspace,
		atomicOperations: {
			open: async (path, flags, mode) => {
				const handle = await open(path, flags, mode);
				return atomicHandle(handle, events, basename(path));
			},
			rename: async (source, target) => {
				events.push(`rename:${basename(source)}:${basename(target)}`);
				await rename(source, target);
			},
			unlink,
		},
	});

	const first = await store.remember({
		kind: "user",
		name: "Preferred Output",
		description: "Use concise output",
		content: "I prefer concise output.",
	});
	const second = await store.remember({
		kind: "user",
		name: "Preferred Output",
		description: "Use concise output",
		content: "I prefer concise output.",
	});

	assert.equal(first.filename, "preferred_output.md");
	assert.equal(second.filename, "preferred_output-2.md");
	assert.equal(events.filter((event) => event.startsWith("sync:")).length >= 4, true);
	assert.equal(events.filter((event) => event.startsWith("rename:")).length, 4);
	assert.equal(
		(await readdir(await store.directory())).some((name) => name.endsWith(".tmp")),
		false,
	);
});

test("serializes concurrent same-name remembers without overwriting topics or index entries", async (t) => {
	const fixture = await createFixture(t);
	const saved = await Promise.all(Array.from({ length: 12 }, (_, index) => fixture.store.remember({
		kind: "feedback",
		name: "Concurrent Preference",
		description: `preference ${index}`,
		content: `body ${index}`,
	})));

	assert.equal(new Set(saved.map((memory) => memory.filename)).size, 12);
	const scanned = await fixture.store.scan();
	assert.equal(scanned.length, 12);
	assert.deepEqual(
		new Set(scanned.map((memory) => memory.content)),
		new Set(Array.from({ length: 12 }, (_, index) => `body ${index}`)),
	);
	const index = await readFile(join(await fixture.store.directory(), "MEMORY.md"), "utf8");
	for (const memory of saved) assert.match(index, new RegExp(`\\]\\(${memory.filename}\\)`, "u"));
});

test("serializes remembers across independent stores sharing one memory directory", async (t) => {
	const fixture = await createFixture(t);
	const stores = Array.from({ length: 12 }, () => new MemoryStore({
		homeDir: fixture.home,
		workspaceRoot: fixture.workspace,
	}));
	const saved = await Promise.all(stores.map((store, index) => store.remember({
		kind: "feedback",
		name: "Shared Preference",
		description: `shared preference ${index}`,
		content: `shared body ${index}`,
	})));

	assert.equal(new Set(saved.map((memory) => memory.filename)).size, 12);
	const memoryDir = await fixture.store.directory();
	const scanned = await fixture.store.scan();
	assert.equal(scanned.length, 12);
	assert.deepEqual(
		new Set(scanned.map((memory) => memory.content)),
		new Set(Array.from({ length: 12 }, (_, index) => `shared body ${index}`)),
	);
	const index = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
	assert.equal(index.split("\n").filter((line) => line.includes("](")).length, 12);
	assert.equal((await readdir(memoryDir)).includes(".memory.lock"), false);
});

test("recovers a stale lock owned by a dead process", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	const lockPath = join(memoryDir, ".memory.lock");
	const oldTimestamp = Date.now() - 60_000;
	await writeFile(lockPath, JSON.stringify({
		version: 1,
		owner_id: "dead-owner",
		pid: 2_147_483_647,
		created_at_ms: oldTimestamp,
	}), "utf8");
	await utimes(lockPath, new Date(oldTimestamp), new Date(oldTimestamp));
	const store = new MemoryStore({
		homeDir: fixture.home,
		workspaceRoot: fixture.workspace,
		lockTimeoutMs: 200,
		lockStaleMs: 10,
		lockRetryDelayMs: 1,
	});

	const saved = await store.remember({
		kind: "user",
		name: "Recovered Lock",
		description: "recovered",
		content: "recovered body",
	});

	assert.equal(saved.filename, "recovered_lock.md");
	assert.equal((await readdir(memoryDir)).includes(".memory.lock"), false);
});

test("times out on a live lock without deleting another owner's lock", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	const lockPath = join(memoryDir, ".memory.lock");
	const lockContent = JSON.stringify({
		version: 1,
		owner_id: "live-owner",
		pid: process.pid,
		created_at_ms: Date.now(),
	});
	await writeFile(lockPath, lockContent, "utf8");
	const store = new MemoryStore({
		homeDir: fixture.home,
		workspaceRoot: fixture.workspace,
		lockTimeoutMs: 20,
		lockStaleMs: 10_000,
		lockRetryDelayMs: 1,
	});

	await assert.rejects(
		() => store.remember({
			kind: "user",
			name: "Blocked",
			description: "blocked",
			content: "blocked body",
		}),
		(error: unknown) => error instanceof MemoryStoreError
			&& error.kind === "memory_write_failed"
			&& error.diagnostics.operation === "memory_lock_timeout",
	);
	assert.equal(await readFile(lockPath, "utf8"), lockContent);
	assert.equal((await readdir(memoryDir)).some((name) => name.startsWith("blocked")), false);
});

test("does not steal an old lock while its owner process is alive", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	const lockPath = join(memoryDir, ".memory.lock");
	const oldTimestamp = Date.now() - 60_000;
	const lockContent = JSON.stringify({
		version: 1,
		owner_id: "old-live-owner",
		pid: process.pid,
		created_at_ms: oldTimestamp,
	});
	await writeFile(lockPath, lockContent, "utf8");
	await utimes(lockPath, new Date(oldTimestamp), new Date(oldTimestamp));
	const store = new MemoryStore({
		homeDir: fixture.home,
		workspaceRoot: fixture.workspace,
		lockTimeoutMs: 20,
		lockStaleMs: 10,
		lockRetryDelayMs: 1,
	});

	await assert.rejects(
		() => store.remember({
			kind: "user",
			name: "Must Wait",
			description: "must wait",
			content: "must wait body",
		}),
		(error: unknown) => error instanceof MemoryStoreError
			&& error.diagnostics.operation === "memory_lock_timeout",
	);
	assert.equal(await readFile(lockPath, "utf8"), lockContent);
});

test("uses Python Unicode code-point order for equal-mtime scan ties", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	const filenames = ["b.md", "A.md", "_.md", "-.md", "😀.md", "！.md"];
	const timestamp = new Date("2026-01-01T00:00:00.000Z");
	for (const filename of filenames) {
		const path = join(memoryDir, filename);
		await writeFile(path, "---\ntype: user\n---\nvalue\n", "utf8");
		await utimes(path, timestamp, timestamp);
	}

	assert.deepEqual(
		(await fixture.store.scan()).map((memory) => memory.filename),
		["-.md", "A.md", "_.md", "b.md", "！.md", "😀.md"],
	);
});

test("preserves prior files and cleans temporary files when an atomic index rename fails", async (t) => {
	const fixture = await createFixture(t);
	const memoryDir = await fixture.store.directory();
	await writeFile(join(memoryDir, "MEMORY.md"), "- existing\n", "utf8");
	const store = new MemoryStore({
		homeDir: fixture.home,
		workspaceRoot: fixture.workspace,
		atomicOperations: {
			open,
			rename: async (source, target) => {
				if (basename(target) === "MEMORY.md") throw new Error("rename failed");
				await rename(source, target);
			},
			unlink,
		},
	});

	await assert.rejects(() => store.remember({
		kind: "project",
		name: "Release",
		description: "Release date",
		content: "Release Friday",
	}), /memory_write_failed/u);

	assert.equal(await readFile(join(memoryDir, "MEMORY.md"), "utf8"), "- existing\n");
	assert.equal((await readdir(memoryDir)).some((name) => name.endsWith(".tmp")), false);
	assert.equal((await readdir(memoryDir)).some((name) => name.startsWith("release.md")), false);
});

test("forgets an exact filename before bounded deterministic relevant matches", async (t) => {
	const fixture = await createFixture(t);
	const exact = await fixture.store.remember({
		kind: "project",
		name: "Release Exact",
		description: "release planning",
		content: "release exact",
	});
	for (let index = 0; index < 6; index += 1) {
		await fixture.store.remember({
			kind: "project",
			name: `Release Candidate ${index}`,
			description: "release planning",
			content: "release planning details",
		});
	}

	const removedExact = await fixture.store.forget(exact.filename);
	assert.deepEqual(removedExact.map((memory) => memory.filename), [exact.filename]);

	const removedRelevant = await fixture.store.forget("release planning");
	assert.equal(removedRelevant.length, 5);
	assert.equal((await fixture.store.scan()).length, 1);
	const index = await readFile(join(await fixture.store.directory(), "MEMORY.md"), "utf8");
	for (const removed of [...removedExact, ...removedRelevant]) {
		assert.equal(index.includes(`](${removed.filename})`), false);
	}
});

function atomicHandle(
	handle: Awaited<ReturnType<typeof open>>,
	events: string[],
	filename: string,
): MemoryAtomicFileHandle {
	return {
		writeFile: async (content) => handle.writeFile(content, "utf8"),
		sync: async () => {
			events.push(`sync:${filename}`);
			await handle.sync();
		},
		stat: async () => handle.stat(),
		close: async () => handle.close(),
	};
}

function memoryPathEscapeWithoutBody(error: unknown, body: string): boolean {
	return error instanceof MemoryStoreError
		&& error.kind === "memory_path_escape"
		&& !error.message.includes(body)
		&& !JSON.stringify(error.diagnostics).includes(body);
}

async function createFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly home: string;
	readonly workspace: string;
	readonly store: MemoryStore;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-memory-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const workspace = join(root, "workspace with spaces");
	await mkdir(home, { recursive: true });
	await mkdir(workspace, { recursive: true });
	const store = new MemoryStore({ homeDir: home, workspaceRoot: workspace });
	await store.directory();
	return { root, home, workspace, store };
}

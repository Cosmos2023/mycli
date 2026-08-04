import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	TranscriptSnapshotStore,
	type TranscriptSnapshotProject,
	type TranscriptSnapshotV2,
} from "../src/index.ts";

const NOW = "2026-08-04T00:00:00.000Z";

test("rebuilds a corrupt v2 snapshot from SQLite", async (t) => {
	const root = await temporaryDirectory(t);
	const snapshots = new TranscriptSnapshotStore({ homeDir: root });
	const path = snapshots.snapshotPath("s1");
	await snapshots.write(snapshot("s1", "before"));
	await writeFile(path, "{bad", "utf8");

	const result = await snapshots.loadOrRebuild("s1", project(snapshot("s1", "rebuilt")));

	assert.equal(result.source, "sqlite_rebuild");
	assert.equal(result.readOnly, false);
	assert.equal(result.snapshot.transcript[0]?.text, "rebuilt");
	assert.equal(JSON.parse(await readFile(path, "utf8")).schema_version, 2);
});

test("exposes a readable v2 snapshot as degraded read-only when SQLite fails", async (t) => {
	const root = await temporaryDirectory(t);
	const snapshots = new TranscriptSnapshotStore({ homeDir: root });
	await snapshots.write(snapshot("s1", "readable fallback"));
	const unavailable: TranscriptSnapshotProject = {
		loadCanonical: () => { throw new Error("sqlite unavailable"); },
		importLegacy: () => { throw new Error("must not import"); },
	};

	const result = await snapshots.loadOrRebuild("s1", unavailable);

	assert.equal(result.source, "snapshot_read_only");
	assert.equal(result.readOnly, true);
	assert.equal(result.errorCode, "session_storage_unavailable");
	assert.equal(result.snapshot.transcript[0]?.text, "readable fallback");
});

test("sanitizes readable snapshot items before degraded projection", async (t) => {
	const root = await temporaryDirectory(t);
	const snapshots = new TranscriptSnapshotStore({ homeDir: root });
	const path = snapshots.snapshotPath("s1");
	await snapshots.ensureSessionDirectory("s1");
	await writeFile(path, JSON.stringify({
		...snapshot("s1", "safe text"),
		transcript: [{
			id: "s1:user:1",
			type: "user_message",
			text: "safe text",
			provider_payload: { encrypted_content: "private" },
			metadata: {
				status: "visible",
				provider_blob: "private metadata",
			},
		}],
	}), "utf8");

	const result = await snapshots.loadOrRebuild("s1", {
		loadCanonical: () => { throw new Error("sqlite unavailable"); },
		importLegacy: () => { throw new Error("must not import"); },
	});

	assert.deepEqual(result.snapshot.transcript, [{
		id: "s1:user:1",
		type: "user_message",
		text: "safe text",
		metadata: { status: "visible" },
	}]);
	assert.equal(JSON.stringify(result.snapshot).includes("private"), false);
});

test("imports a v1 snapshot only when canonical SQLite data is absent", async (t) => {
	const root = await temporaryDirectory(t);
	const snapshots = new TranscriptSnapshotStore({ homeDir: root });
	const path = snapshots.snapshotPath("legacy");
	await snapshots.ensureSessionDirectory("legacy");
	await writeFile(path, JSON.stringify({
		schema_version: 1,
		session_id: "legacy",
		messages: [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		],
	}), "utf8");
	const imported: unknown[] = [];
	const projection: TranscriptSnapshotProject = {
		loadCanonical: () => undefined,
		importLegacy: (_sessionId, messages) => {
			imported.push(...messages);
			return snapshot("legacy", "hello");
		},
	};

	const result = await snapshots.loadOrRebuild("legacy", projection);

	assert.equal(result.source, "legacy_import");
	assert.equal(imported.length, 2);
	assert.equal(JSON.parse(await readFile(path, "utf8")).schema_version, 2);
});

test("uses canonical SQLite data instead of importing a v1 snapshot", async (t) => {
	const root = await temporaryDirectory(t);
	const snapshots = new TranscriptSnapshotStore({ homeDir: root });
	const path = snapshots.snapshotPath("legacy");
	await snapshots.ensureSessionDirectory("legacy");
	await writeFile(path, JSON.stringify({
		schema_version: 1,
		session_id: "legacy",
		messages: [{ role: "user", content: "stale legacy" }],
	}), "utf8");
	let imports = 0;
	const projection: TranscriptSnapshotProject = {
		loadCanonical: () => snapshot("legacy", "canonical"),
		importLegacy: () => {
			imports += 1;
			throw new Error("must not import");
		},
	};

	const result = await snapshots.loadOrRebuild("legacy", projection);

	assert.equal(result.source, "sqlite_rebuild");
	assert.equal(result.snapshot.transcript[0]?.text, "canonical");
	assert.equal(imports, 0);
});

test("failed v1 migration preserves the original bytes", async (t) => {
	const root = await temporaryDirectory(t);
	const snapshots = new TranscriptSnapshotStore({ homeDir: root });
	const path = snapshots.snapshotPath("legacy");
	await snapshots.ensureSessionDirectory("legacy");
	const original = Buffer.from(
		'{"schema_version":1,"session_id":"legacy","messages":[{"role":"user","content":"hello"}]}',
		"utf8",
	);
	await writeFile(path, original);

	await assert.rejects(
		() => snapshots.loadOrRebuild("legacy", {
			loadCanonical: () => undefined,
			importLegacy: () => { throw new Error("import failed"); },
		}),
		/import failed/u,
	);
	assert.deepEqual(await readFile(path), original);
});

test("failed temporary write preserves the previous v2 and cleans up", async (t) => {
	const root = await temporaryDirectory(t);
	let failWrite = false;
	const snapshots = new TranscriptSnapshotStore({
		homeDir: root,
		failpoint: (name) => {
			if (failWrite && name === "snapshot_before_write") throw new Error("write failed");
		},
	});
	await snapshots.write(snapshot("s1", "before"));
	const path = snapshots.snapshotPath("s1");
	const previous = await readFile(path, "utf8");
	failWrite = true;

	await assert.rejects(() => snapshots.write(snapshot("s1", "after")), /write failed/u);

	assert.equal(await readFile(path, "utf8"), previous);
	assert.deepEqual(
		(await readdir(snapshots.sessionDirectory("s1"))).filter((name) => name.endsWith(".tmp")),
		[],
	);
});

test("failed temporary rename preserves the previous v2 and cleans up", async (t) => {
	const root = await temporaryDirectory(t);
	let failRename = false;
	const snapshots = new TranscriptSnapshotStore({
		homeDir: root,
		operations: {
			rename: async (source, target) => {
				if (failRename) throw new Error("rename failed");
				const { rename } = await import("node:fs/promises");
				await rename(source, target);
			},
		},
	});
	await snapshots.write(snapshot("s1", "before"));
	const path = snapshots.snapshotPath("s1");
	const previous = await readFile(path, "utf8");
	failRename = true;

	await assert.rejects(() => snapshots.write(snapshot("s1", "after")), /rename failed/u);

	assert.equal(await readFile(path, "utf8"), previous);
	assert.deepEqual(
		(await readdir(snapshots.sessionDirectory("s1"))).filter((name) => name.endsWith(".tmp")),
		[],
	);
});

function project(canonical: TranscriptSnapshotV2): TranscriptSnapshotProject {
	return {
		loadCanonical: () => canonical,
		importLegacy: () => { throw new Error("must not import"); },
	};
}

function snapshot(sessionId: string, text: string): TranscriptSnapshotV2 {
	return {
		schema_version: 2,
		session_id: sessionId,
		cwd: "/workspace",
		state: "idle",
		message_count: 1,
		created_at: NOW,
		updated_at: NOW,
		transcript: [{ id: `${sessionId}:user:1`, type: "user_message", text }],
	};
}

async function temporaryDirectory(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mycli-transcript-snapshot-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

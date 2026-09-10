import assert from "node:assert/strict";
import test from "node:test";
import * as tools from "../../src/index.ts";

interface Snapshot {
	readonly path: string;
	readonly sha256: string;
	readonly mtimeNs: string;
	readonly size: number;
	readonly capturedAt: string;
}

interface SnapshotStore {
	record(snapshot: Snapshot): void;
	latest(path: string): Snapshot | undefined;
}

type SnapshotStoreConstructor = new () => SnapshotStore;

test("stores the latest immutable snapshot by normalized workspace path", () => {
	const store = createSnapshotStore();
	const first = snapshot("src/a.ts", "a", "1", 1, "t1");
	store.record(first);
	store.record(snapshot("src/a.ts", "b", "2", 2, "t2"));

	assert.equal(store.latest("src/a.ts")?.sha256, "b".repeat(64));
	assert.equal(store.latest("./src/a.ts")?.sha256, "b".repeat(64));
	assert.notEqual(store.latest("src/a.ts"), first);
	assert.equal(Object.isFrozen(store.latest("src/a.ts")), true);
});

function createSnapshotStore(): SnapshotStore {
	const Constructor = Reflect.get(tools, "FileSnapshotStore") as SnapshotStoreConstructor | undefined;
	assert.equal(typeof Constructor, "function", "FileSnapshotStore must be exported");
	return new Constructor!();
}

function snapshot(
	path: string,
	shaCharacter: string,
	mtimeNs: string,
	size: number,
	capturedAt: string,
): Snapshot {
	return {
		path,
		sha256: shaCharacter.repeat(64),
		mtimeNs,
		size,
		capturedAt,
	};
}

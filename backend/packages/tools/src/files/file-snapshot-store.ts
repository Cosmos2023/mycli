import { posix } from "node:path";

export interface FileSnapshot {
	readonly path: string;
	readonly sha256: string;
	readonly mtimeNs: string;
	readonly size: number;
	readonly capturedAt: string;
}

export class FileSnapshotStore {
	readonly #snapshots = new Map<string, FileSnapshot>();

	record(snapshot: FileSnapshot): void {
		this.#snapshots.set(normalizeSnapshotPath(snapshot.path), Object.freeze({ ...snapshot }));
	}

	latest(path: string): FileSnapshot | undefined {
		return this.#snapshots.get(normalizeSnapshotPath(path));
	}
}

function normalizeSnapshotPath(path: string): string {
	return posix.normalize(path.replaceAll("\\", "/"));
}

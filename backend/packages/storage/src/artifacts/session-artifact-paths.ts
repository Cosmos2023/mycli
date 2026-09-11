import { createHash } from "node:crypto";
import { join } from "node:path";

export class StorageIdentityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StorageIdentityError";
	}
}

export function validateStorageIdentity(value: string, field = "storage identity"): string {
	if (
		!value.trim()
		|| value === "."
		|| value.startsWith("<")
		|| value.endsWith(">")
		|| value.includes("/")
		|| value.includes("\\")
		|| value.includes("..")
		|| value.includes("\0")
	) {
		throw new StorageIdentityError(`invalid ${field}`);
	}
	return value;
}

export class SessionArtifactPaths {
	readonly #sessionsRoot: string;

	constructor(homeDir: string) {
		this.#sessionsRoot = join(homeDir, ".mycli", "sessions");
	}

	sessionDirectory(sessionId: string): string {
		return join(this.#sessionsRoot, validateStorageIdentity(sessionId, "storage session id"));
	}

	snapshotPath(sessionId: string): string {
		return join(this.sessionDirectory(sessionId), "session.json");
	}

	eventsPath(sessionId: string): string {
		return join(this.sessionDirectory(sessionId), "events.jsonl");
	}

	taskOutputPath(sessionId: string, taskId: string): string {
		return join(
			this.sessionDirectory(sessionId),
			"tasks",
			validateStorageIdentity(taskId, "storage task id"),
			"output.txt",
		);
	}

	subagentSnapshotPath(parentSessionId: string, childSessionId: string): string {
		return join(
			this.sessionDirectory(parentSessionId),
			"subagents",
			`${subagentRunId(childSessionId)}.json`,
		);
	}
}

export function subagentRunId(childSessionId: string): string {
	validateStorageIdentity(childSessionId, "child session id");
	const digest = createHash("sha256").update(childSessionId, "utf8").digest("hex").slice(0, 16);
	return `subagent-${digest}`;
}

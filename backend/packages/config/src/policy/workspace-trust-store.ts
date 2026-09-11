import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export type WorkspaceTrustState = "trusted" | "untrusted" | "unknown";

export interface WorkspaceTrustStoreOptions {
	readonly homeDir: string;
}

type StoredWorkspaceTrust = {
	readonly version: 1;
	readonly workspace: string;
	readonly state: Exclude<WorkspaceTrustState, "unknown">;
};

export class WorkspaceTrustStore {
	readonly #directory: string;

	constructor(options: WorkspaceTrustStoreOptions) {
		this.#directory = join(options.homeDir, ".mycli", "trust");
	}

	async load(workspaceRoot: string): Promise<WorkspaceTrustState> {
		let workspace: string;
		try {
			workspace = await canonicalWorkspace(workspaceRoot);
		} catch {
			return "unknown";
		}
		try {
			const payload = JSON.parse(await readFile(this.#path(workspace), "utf8")) as unknown;
			return storedState(payload, workspace);
		} catch {
			return "unknown";
		}
	}

	async save(workspaceRoot: string, state: WorkspaceTrustState): Promise<void> {
		if (state !== "trusted" && state !== "untrusted" && state !== "unknown") {
			throw new TypeError("workspace trust state is invalid");
		}
		const workspace = await canonicalWorkspace(workspaceRoot);
		const target = this.#path(workspace);
		if (state === "unknown") {
			await rm(target, { force: true });
			return;
		}

		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		const temporary = join(this.#directory, `.${randomUUID()}.tmp`);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporary, "wx", 0o600);
			const payload: StoredWorkspaceTrust = { version: 1, workspace, state };
			await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporary, target);
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	#path(workspace: string): string {
		const digest = createHash("sha256").update(workspace).digest("hex");
		return join(this.#directory, `${digest}.json`);
	}
}

async function canonicalWorkspace(workspaceRoot: string): Promise<string> {
	return realpath(resolve(workspaceRoot));
}

function storedState(payload: unknown, workspace: string): WorkspaceTrustState {
	if (!isRecord(payload)
		|| payload.version !== 1
		|| payload.workspace !== workspace
		|| (payload.state !== "trusted" && payload.state !== "untrusted")) {
		return "unknown";
	}
	return payload.state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

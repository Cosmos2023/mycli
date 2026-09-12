import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateFileUpdate } from "@mycli/config";
import { parseExtensionApprovalScope, type ExtensionApprovalScope } from "@mycli/core";
import { createErrorContext, failureScope } from "@mycli/contracts";

const FILE_NAME = "integration-tool-approvals.json";
const MAX_BYTES = 262_144;
const MAX_GRANTS = 1_024;

export class IntegrationApprovalStoreError extends Error {
	readonly code = "integration_approval_store_failed";
	readonly errorContext = createErrorContext({ reason: "storage.failure_unclassified", source: "storage",
		scope: failureScope("request", "integration-approvals"), outcome: { state: "not_started", effects: "none" },
		details: { legacy_code: "integration_approval_store_failed" } });
	constructor() { super("Integration approval storage is unavailable or invalid."); }
}

/** User-approved tool grants contain only identities and hashes, never endpoint credentials. */
export class IntegrationToolApprovalStore {
	readonly #directory: string;
	constructor(homeDir: string) { this.#directory = join(homeDir, ".mycli"); }

	async load(): Promise<readonly ExtensionApprovalScope[]> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(join(this.#directory, FILE_NAME), "r");
			const info = await handle.stat();
			if (!info.isFile() || info.size > MAX_BYTES) throw new IntegrationApprovalStoreError();
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			let size = 0;
			while (size < buffer.length) {
				const read = await handle.read(buffer, size, buffer.length - size, size);
				if (read.bytesRead === 0) break;
				size += read.bytesRead;
			}
			if (size > MAX_BYTES) throw new IntegrationApprovalStoreError();
			return parseGrants(buffer.subarray(0, size).toString("utf8"));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
			throw new IntegrationApprovalStoreError();
		} finally { await handle?.close().catch(() => undefined); }
	}

	async allow(scope: ExtensionApprovalScope): Promise<void> {
		const validated = parseExtensionApprovalScope(scope);
		if (!validated) throw new IntegrationApprovalStoreError();
		await this.#update((grants) => [...grants.filter((entry) => entry.id !== scope.id), validated]);
	}

	async revokeMcpServer(server: string): Promise<void> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(server)) throw new IntegrationApprovalStoreError();
		await this.#update((grants) => grants.filter((grant) => !grant.id.startsWith(`mcp:${server}:`)));
	}

	async #update(edit: (grants: readonly ExtensionApprovalScope[]) => readonly ExtensionApprovalScope[]): Promise<void> {
		try {
			await atomicPrivateFileUpdate({ directory: this.#directory, fileName: FILE_NAME, maxCurrentBytes: MAX_BYTES,
				buildContent: async (current) => {
					if (current === undefined && await stat(join(this.#directory, FILE_NAME)).then(() => true, (error: unknown) => {
						if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
						throw error;
					})) throw new IntegrationApprovalStoreError();
					const tools = edit(parseGrants(current));
					if (tools.length > MAX_GRANTS) throw new IntegrationApprovalStoreError();
					const content = `${JSON.stringify({ version: 1, tools })}\n`;
					if (Buffer.byteLength(content) > MAX_BYTES) throw new IntegrationApprovalStoreError();
					return content;
				} });
		} catch { throw new IntegrationApprovalStoreError(); }
	}
}

function parseGrants(content: string | undefined): readonly ExtensionApprovalScope[] {
	if (content === undefined) return [];
	const value: unknown = JSON.parse(content);
	if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1
		|| !("tools" in value) || !Array.isArray(value.tools) || value.tools.length > MAX_GRANTS) throw new IntegrationApprovalStoreError();
	const scopes = value.tools.map(parseExtensionApprovalScope);
	if (scopes.some((scope) => !scope) || new Set(scopes.map((scope) => scope!.id)).size !== scopes.length) throw new IntegrationApprovalStoreError();
	return Object.freeze(scopes as ExtensionApprovalScope[]);
}

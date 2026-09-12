import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateFileUpdate } from "@mycli/config";

export type IntegrationEnablementKind = "skill" | "hook";

export interface IntegrationEnablementEntry {
	readonly kind: IntegrationEnablementKind;
	readonly id: string;
	readonly enabled: boolean;
}

export interface IntegrationEnablementSnapshot {
	readonly revision: string;
	readonly entries: readonly IntegrationEnablementEntry[];
}

const FILE_NAME = "integration-enablement.json";
const MAX_BYTES = 262_144;
const MAX_ENTRIES = 2_048;
const ID_PATTERN = /^[a-f0-9]{64}$/u;

export class IntegrationEnablementError extends Error {
	constructor(readonly code: "integration_settings_invalid" | "integration_settings_changed" | "integration_settings_write_failed") {
		super(code);
		this.name = "IntegrationEnablementError";
	}
}

/** Persistent user overrides, keyed to a discovered capability's source identity. */
export class IntegrationEnablementStore {
	readonly #directory: string;

	constructor(options: { readonly homeDir: string }) {
		this.#directory = join(options.homeDir, ".mycli");
	}

	async load(): Promise<IntegrationEnablementSnapshot> {
		const handle = await open(join(this.#directory, FILE_NAME), "r").catch((error: unknown) => {
			if (isMissing(error)) return undefined;
			throw new IntegrationEnablementError("integration_settings_invalid");
		});
		if (!handle) return snapshot([]);
		try {
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
				if (!bytesRead) break;
				length += bytesRead;
			}
			if (length > MAX_BYTES) throw new IntegrationEnablementError("integration_settings_invalid");
			return snapshot(parse(buffer.subarray(0, length).toString("utf8")));
		} finally {
			await handle.close();
		}
	}

	async setEnabled(
		input: IntegrationEnablementEntry & { readonly revision: string },
		signal: AbortSignal,
	): Promise<IntegrationEnablementSnapshot> {
		validateEntry(input);
		if (!ID_PATTERN.test(input.revision)) throw new IntegrationEnablementError("integration_settings_changed");
		let updated: IntegrationEnablementSnapshot | undefined;
		try {
			await atomicPrivateFileUpdate({ directory: this.#directory, fileName: FILE_NAME, signal,
				maxCurrentBytes: MAX_BYTES, buildContent: async (current) => {
					if (current === undefined && await stat(join(this.#directory, FILE_NAME)).then(() => true,
						(error: unknown) => { if (isMissing(error)) return false; throw error; })) {
						throw new IntegrationEnablementError("integration_settings_invalid");
					}
					const previous = snapshot(current === undefined ? [] : parse(current));
					if (previous.revision !== input.revision) throw new IntegrationEnablementError("integration_settings_changed");
					const entries = previous.entries.filter((entry) => entry.kind !== input.kind || entry.id !== input.id);
					entries.push({ kind: input.kind, id: input.id, enabled: input.enabled });
					updated = snapshot(entries);
					if (updated.revision === previous.revision) return undefined;
					const content = `${JSON.stringify({ version: 1, entries: updated.entries }, null, 2)}\n`;
					if (Buffer.byteLength(content) > MAX_BYTES) throw new IntegrationEnablementError("integration_settings_invalid");
					return content;
				} });
		} catch (error) {
			if (signal.aborted || error instanceof IntegrationEnablementError) throw error;
			throw new IntegrationEnablementError("integration_settings_write_failed");
		}
		return updated!;
	}
}

export function integrationEnabled(
	settings: IntegrationEnablementSnapshot,
	kind: IntegrationEnablementKind,
	id: string,
	fallback = true,
): boolean {
	return settings.entries.find((entry) => entry.kind === kind && entry.id === id)?.enabled ?? fallback;
}

export function integrationSourceIdentity(parts: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function snapshot(entries: readonly IntegrationEnablementEntry[]): IntegrationEnablementSnapshot {
	if (entries.length > MAX_ENTRIES) throw new IntegrationEnablementError("integration_settings_invalid");
	const ordered = entries.map((entry) => {
		validateEntry(entry);
		return Object.freeze({ kind: entry.kind, id: entry.id, enabled: entry.enabled });
	}).sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
	if (new Set(ordered.map((entry) => `${entry.kind}:${entry.id}`)).size !== ordered.length) {
		throw new IntegrationEnablementError("integration_settings_invalid");
	}
	return Object.freeze({ revision: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
		entries: Object.freeze(ordered) });
}

function parse(text: string): readonly IntegrationEnablementEntry[] {
	try {
		const value = JSON.parse(text) as { version?: unknown; entries?: unknown } | null;
		if (value?.version !== 1 || !Array.isArray(value.entries)) throw new Error("invalid");
		return value.entries.map((entry: unknown) => {
			validateEntry(entry);
			return entry;
		});
	} catch {
		throw new IntegrationEnablementError("integration_settings_invalid");
	}
}

function validateEntry(value: unknown): asserts value is IntegrationEnablementEntry {
	const entry = value as Partial<IntegrationEnablementEntry> | null;
	if (!entry || (entry.kind !== "skill" && entry.kind !== "hook") || typeof entry.id !== "string"
		|| !ID_PATTERN.test(entry.id) || typeof entry.enabled !== "boolean") {
		throw new IntegrationEnablementError("integration_settings_invalid");
	}
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

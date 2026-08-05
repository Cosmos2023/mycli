import { createHash } from "node:crypto";

export type IntegrationSource = "mcp" | "plugin" | "skill" | "subagent";

export const INTEGRATION_ID_MAX_LENGTH = 128;
export const PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH = 64;

const INTEGRATION_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNSAFE_TOOL_NAME_CHARACTERS = /[^A-Za-z0-9]+/g;

export function createIntegrationId(
	source: IntegrationSource,
	...parts: readonly string[]
): string {
	const normalized = parts.map((part) => part.trim());
	if (normalized.length === 0 || normalized.some((part) => !INTEGRATION_PART.test(part))) {
		throw new Error("invalid_integration_id");
	}
	const id = [source, ...normalized].join(":");
	if (id.length > INTEGRATION_ID_MAX_LENGTH) {
		throw new Error("integration_id_too_long");
	}
	return id;
}

export function providerSafeToolName(...parts: readonly string[]): string {
	const rawName = parts.map((part) => part.trim()).filter(Boolean).join("_");
	const safeName = rawName.replace(UNSAFE_TOOL_NAME_CHARACTERS, "_").replace(/^_+|_+$/g, "")
		|| "tool";
	if (safeName.length <= PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH) return safeName;

	const suffix = createHash("sha1").update(safeName, "utf8").digest("hex").slice(0, 8);
	const prefixLength = PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH - suffix.length - 1;
	const prefix = safeName.slice(0, prefixLength).replace(/_+$/g, "");
	return `${prefix}_${suffix}`;
}

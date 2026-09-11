import type { RuntimeShellState } from "./runtime-state-model.ts";

export function stringArray(value: unknown, limit: number, itemLimit: number): string[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, limit).flatMap((entry) => {
		const text = boundedCatalogText(entry, itemLimit);
		return text ? [text] : [];
	});
}

export function boundedCatalogText(value: unknown, limit: number): string | null {
	if (typeof value !== "string") return null;
	const text = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
	return text ? text.slice(0, limit) : null;
}

export function slashCatalogText(value: unknown): string | null {
	const text = boundedCatalogText(value, 256);
	return text?.startsWith("/") ? text : null;
}

export function isInternalTaskNotification(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("<task-notification>")
		|| trimmed.startsWith("<task-notification ")
		|| trimmed.startsWith("<agent-mailbox>")
		|| trimmed.startsWith("<agent-mailbox ");
}

export function stringArrayValue(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) {
		return [value.trim()];
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

export function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function textValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

export function collaborationModeValue(value: unknown): RuntimeShellState["collaborationMode"] | null {
	return value === "default" || value === "plan" ? value : null;
}

export function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function generationValue(value: unknown): number | null {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value > 0
		? value
		: null;
}

export function turnDurationMsValue(value: unknown): number | undefined {
	const durationMs = numberValue(value);
	if (durationMs === null || durationMs < 0) return undefined;
	return Math.min(86_400_000, Math.round(durationMs));
}

export function recordValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

let nextItemId = 1;

export function nextId(prefix: string): string {
	return `${prefix}_${nextItemId++}`;
}

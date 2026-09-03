export function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return isRecord(value) && isJsonValue(value, new Set());
}

export function serializeJsonObject(value: unknown): string | undefined {
	if (!isJsonObject(value)) return undefined;
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Array.isArray(value)
		? value.every((item) => isJsonValue(item, ancestors))
		: Object.getPrototypeOf(value) === Object.prototype
			&& Object.values(value).every((item) => isJsonValue(item, ancestors));
	ancestors.delete(value);
	return valid;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

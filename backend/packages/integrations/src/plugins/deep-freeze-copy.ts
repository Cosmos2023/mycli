export function deepFreezeCopy<Value>(value: Value): Value {
	if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy)) as Value;
	if (!isRecord(value)) return value;
	return Object.freeze(Object.fromEntries(
		Object.entries(value).map(([key, child]) => [key, deepFreezeCopy(child)]),
	)) as Value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

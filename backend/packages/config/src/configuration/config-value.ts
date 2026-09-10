export function valueAtPath(
	payload: Readonly<Record<string, unknown>>,
	path: readonly string[],
): unknown {
	let value: unknown = payload;
	for (const segment of path) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		value = (value as Readonly<Record<string, unknown>>)[segment];
	}
	return value;
}

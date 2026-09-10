import type { ToolParameterManifest } from "../types.ts";

export function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value;
	}
	for (const nested of Object.values(value)) deepFreeze(nested);
	return Object.freeze(value);
}

export function deepFreezeCopy<Value>(value: Value): Value {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((item) => deepFreezeCopy(item))) as Value;
	}
	if (typeof value !== "object" || value === null) return value;
	return Object.freeze(Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, deepFreezeCopy(item)]),
	)) as Value;
}

export function parameterDescription(
	parameters: readonly ToolParameterManifest[],
	name: string,
): string {
	const description = parameters.find((parameter) => parameter.name === name)?.description;
	if (!description) throw new Error(`missing parameter description: ${name}`);
	return description;
}

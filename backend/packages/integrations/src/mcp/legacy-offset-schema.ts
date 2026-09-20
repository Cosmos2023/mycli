/**
 * Legacy offset variant of a cursor based tool schema. Kept free of the MCP
 * SDK so adapters can describe themselves before the runtime loads.
 */
export function legacyOffsetSchema(
	schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const properties = schema.properties as Readonly<Record<string, unknown>>;
	return {
		...schema,
		properties: {
			...Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "cursor")),
			offset: { type: "integer", minimum: 0 },
		},
		required: [...(schema.required as readonly string[] ?? []), "offset"],
	};
}

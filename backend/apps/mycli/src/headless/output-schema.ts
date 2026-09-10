import { Ajv, type AnySchema, type ValidateFunction } from "ajv";
import { readBoundedText } from "./io.ts";
import { HeadlessError } from "./types.ts";

export interface OutputSchema {
	readonly prompt: string;
	validate(text: string): unknown;
}

export async function loadOutputSchema(path: string, signal?: AbortSignal): Promise<OutputSchema> {
	try { return compileOutputSchema(JSON.parse(await readBoundedText(path, 64 * 1024, signal)) as unknown); }
	catch { throw new HeadlessError("output_schema_invalid", 2); }
}

export function compileOutputSchema(schema: unknown): OutputSchema {
	let validate: ValidateFunction;
	try {
		if (typeof schema !== "boolean" && (typeof schema !== "object" || schema === null || Array.isArray(schema))) {
			throw new Error("invalid_schema");
		}
		validate = new Ajv({ strict: true, allErrors: false }).compile(schema as AnySchema);
		if ("$async" in validate && validate.$async === true) throw new Error("async_schema_unsupported");
	} catch { throw new HeadlessError("output_schema_invalid", 2); }
	return Object.freeze({
		prompt: `Return the final answer as a JSON value matching this JSON Schema. Do not wrap it in Markdown.\n${JSON.stringify(schema)}`,
		validate: (text: string): unknown => {
			let value: unknown;
			try { value = JSON.parse(text) as unknown; }
			catch { throw new HeadlessError("output_schema_mismatch"); }
			if (!validate(value)) throw new HeadlessError("output_schema_mismatch");
			return value;
		},
	});
}

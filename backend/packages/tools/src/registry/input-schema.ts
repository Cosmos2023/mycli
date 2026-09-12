import { Ajv2020 } from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";

export function createToolSchemaValidator(): Ajv2020 {
	const validator = new Ajv2020({ allErrors: true, strict: true, addUsedSchema: false });
	formatsPlugin.default(validator);
	return validator;
}

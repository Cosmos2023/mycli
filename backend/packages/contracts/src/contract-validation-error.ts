import type { ErrorObject } from "ajv";

export class ContractValidationError extends Error {
	readonly errors: readonly ErrorObject[];

	constructor(message: string, errors: readonly ErrorObject[] = []) {
		super(message);
		this.name = "ContractValidationError";
		this.errors = errors;
	}
}

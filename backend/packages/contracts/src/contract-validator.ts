import type { ErrorObject } from "ajv";

/**
 * Validation callable shared by Ajv-compiled and build-time generated
 * validators. Standalone validators expose only `errors` on top of the call.
 */
export type ContractValidator = ((value: unknown) => boolean) & {
	readonly errors?: readonly ErrorObject[] | null;
};

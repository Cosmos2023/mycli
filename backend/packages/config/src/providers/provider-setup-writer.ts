import { join } from "node:path";
import { withApiKeyReplacement } from "./auth-store.ts";
import {
	writeUserProviderConfig,
	type UserProviderConfigInput,
} from "../configuration/user-config-writer.ts";

export interface UserProviderSetupInput extends Omit<UserProviderConfigInput, "failpoint"> {
	readonly apiKey: string;
	readonly authFailpoint?: (name: string) => void;
	readonly configFailpoint?: (name: string) => void;
	readonly authRollbackFailpoint?: (name: string) => void;
}

export interface UserProviderSetupResult {
	readonly configPath: string;
	readonly authPath: string;
}

export async function writeUserProviderSetup(
	input: UserProviderSetupInput,
): Promise<UserProviderSetupResult> {
	try {
		return await withApiKeyReplacement({
			homeDir: input.homeDir,
			authRef: input.authRef,
			apiKey: input.apiKey,
			...(input.authFailpoint ? { failpoint: input.authFailpoint } : {}),
			...(input.authRollbackFailpoint
				? { rollbackFailpoint: input.authRollbackFailpoint }
				: {}),
		}, async () => ({
			configPath: await writeUserProviderConfig({
				...input,
				...(input.configFailpoint ? { failpoint: input.configFailpoint } : {}),
			}),
			authPath: join(input.homeDir, ".mycli", "auth.json"),
		}));
	} catch {
		throw new Error("provider_setup_write_failed: unable to update provider credentials");
	}
}

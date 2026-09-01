import type { Readable } from "node:stream";
import {
	deleteApiKey,
	inspectApiKey,
	resolveConfig,
	resolveProviderProfile,
	writeApiKey,
	type WorkspaceTrustState,
} from "@mycli/config";
import type { AuthManagementCommand, ManagementResponse } from "./types.ts";

const MAX_STDIN_SECRET_BYTES = 64 * 1024;

export type AuthCredentialSource = "environment" | "stored" | "legacy_config" | "missing";

export interface AuthManagementResponse extends ManagementResponse {
	readonly action: "status" | "login" | "logout";
	readonly provider: string;
	readonly authRef: string;
	readonly configured: boolean;
	readonly source: AuthCredentialSource;
	readonly stored: boolean;
	readonly removed?: boolean;
}

export interface AuthInputStream extends NodeJS.ReadableStream {
	readonly isTTY?: boolean;
}

export type ApiKeyInputReader = (signal: AbortSignal) => Promise<string>;

export interface AuthManagementServiceOptions {
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly env: NodeJS.ProcessEnv;
	readonly workspaceTrust: WorkspaceTrustState;
	readonly readApiKeyInput?: ApiKeyInputReader;
}

export class AuthInputError extends Error {
	constructor(readonly code: "auth_stdin_required" | "auth_input_empty" | "auth_input_too_large") {
		super(code);
		this.name = "AuthInputError";
	}
}

export class AuthManagementService {
	readonly #options: AuthManagementServiceOptions;

	constructor(options: AuthManagementServiceOptions) {
		this.#options = options;
	}

	async execute(command: AuthManagementCommand, signal: AbortSignal): Promise<AuthManagementResponse> {
		const target = await this.#target(command.provider, command.authRef);
		if (command.kind === "login" && command.action === "status") {
			return this.#status(target, "status");
		}
		if (command.kind === "logout") return this.#logout(target);
		return this.#login(target, signal);
	}

	async #target(providerValue?: string, authRefValue?: string): Promise<AuthTarget> {
		const config = await resolveConfig({
			homeDir: this.#options.homeDir,
			workspaceRoot: this.#options.workspaceRoot,
			env: this.#options.env,
			workspaceTrust: this.#options.workspaceTrust,
		});
		const provider = providerValue?.trim() || config.provider;
		try {
			resolveProviderProfile(provider);
		} catch {
			throw new Error("auth_provider_invalid");
		}
		const authRef = authRefValue?.trim()
			|| (provider === config.provider ? config.authRef : provider);
		const status = await inspectApiKey({ homeDir: this.#options.homeDir, authRef });
		const current = provider === config.provider && authRef === config.authRef;
		const environment = current && Boolean(this.#options.env.MYCLI_API_KEY?.trim());
		const legacyConfig = current && Boolean(config.apiKey) && !environment && !status.configured;
		return Object.freeze({
			provider,
			authRef: status.authRef,
			stored: status.configured,
			storeMalformed: status.storeState === "malformed",
			environment,
			legacyConfig,
		});
	}

	#status(target: AuthTarget, action: "status" | "login" | "logout", removed?: boolean): AuthManagementResponse {
		const source = credentialSource(target);
		const configured = source !== "missing";
		if (target.storeMalformed) {
			return Object.freeze({
				ok: false,
				action,
				provider: target.provider,
				authRef: target.authRef,
				configured,
				source,
				stored: false,
				...(removed === undefined ? {} : { removed }),
				message: "Credential store is malformed and was left unchanged.",
				issues: Object.freeze(["auth_store_malformed"]),
			});
		}
		return Object.freeze({
			ok: true,
			action,
			provider: target.provider,
			authRef: target.authRef,
			configured,
			source,
			stored: target.stored,
			...(removed === undefined ? {} : { removed }),
			message: authMessage(action, configured, source, removed),
		});
	}

	async #login(target: AuthTarget, signal: AbortSignal): Promise<AuthManagementResponse> {
		if (target.storeMalformed) return this.#status(target, "login");
		let apiKey: string;
		try {
			apiKey = await (this.#options.readApiKeyInput ?? missingInputReader)(signal);
		} catch (error) {
			const issue = error instanceof AuthInputError ? error.code : "auth_input_failed";
			return failure(target, "login", authInputMessage(issue), issue);
		}
		try {
			await writeApiKey({ homeDir: this.#options.homeDir, authRef: target.authRef, apiKey });
		} catch {
			return failure(target, "login", "Unable to store the credential.", "auth_write_failed");
		}
		return this.#status({ ...target, stored: true }, "login");
	}

	async #logout(target: AuthTarget): Promise<AuthManagementResponse> {
		if (target.storeMalformed) return this.#status(target, "logout", false);
		let removed: boolean;
		try {
			removed = await deleteApiKey({ homeDir: this.#options.homeDir, authRef: target.authRef });
		} catch {
			return failure(target, "logout", "Unable to remove the stored credential.", "auth_delete_failed");
		}
		return this.#status({ ...target, stored: false }, "logout", removed);
	}
}

export async function readApiKeyFromStdin(
	input: AuthInputStream,
	signal = new AbortController().signal,
): Promise<string> {
	if (input.isTTY === true) throw new AuthInputError("auth_stdin_required");
	const iterator = (input as Readable)[Symbol.asyncIterator]();
	const chunks: Buffer[] = [];
	let bytes = 0;
	while (true) {
		if (signal.aborted) throw abortError();
		const next = await abortable(iterator.next(), signal);
		if (next.done) break;
		const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(String(next.value));
		bytes += chunk.byteLength;
		if (bytes > MAX_STDIN_SECRET_BYTES) throw new AuthInputError("auth_input_too_large");
		chunks.push(chunk);
	}
	const apiKey = Buffer.concat(chunks).toString("utf8").trim();
	if (!apiKey) throw new AuthInputError("auth_input_empty");
	return apiKey;
}

interface AuthTarget {
	readonly provider: string;
	readonly authRef: string;
	readonly stored: boolean;
	readonly storeMalformed: boolean;
	readonly environment: boolean;
	readonly legacyConfig: boolean;
}

function credentialSource(target: AuthTarget): AuthCredentialSource {
	if (target.environment) return "environment";
	if (target.stored) return "stored";
	if (target.legacyConfig) return "legacy_config";
	return "missing";
}

function authMessage(
	action: "status" | "login" | "logout",
	configured: boolean,
	source: AuthCredentialSource,
	removed?: boolean,
): string {
	if (action === "login") {
		return source === "environment"
			? "Credential stored; the environment credential remains effective."
			: "Credential stored.";
	}
	if (action === "logout") {
		if (source === "environment") return "Stored credential removed; the environment credential remains effective.";
		if (source === "legacy_config") return "Stored credential removed; a legacy config credential remains effective.";
		return removed ? "Stored credential removed." : "No stored credential was found.";
	}
	return configured ? `Credential configured from ${source}.` : "No credential is configured.";
}

function failure(
	target: AuthTarget,
	action: "login" | "logout",
	message: string,
	issue: string,
): AuthManagementResponse {
	return Object.freeze({
		ok: false,
		action,
		provider: target.provider,
		authRef: target.authRef,
		configured: credentialSource(target) !== "missing",
		source: credentialSource(target),
		stored: target.stored,
		message,
		issues: Object.freeze([issue]),
	});
}

function authInputMessage(issue: string): string {
	if (issue === "auth_stdin_required") {
		return "Pipe the API key to stdin when using login --with-api-key.";
	}
	if (issue === "auth_input_empty") return "No API key was provided on stdin.";
	if (issue === "auth_input_too_large") return "The API key provided on stdin is too large.";
	return "Unable to read the API key from stdin.";
}

async function missingInputReader(): Promise<never> {
	throw new AuthInputError("auth_stdin_required");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const onAbort = (): void => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}

import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import {
	builtinModelReasoningDefaults,
	listProviderProfiles,
	readApiKey,
	writeUserProviderSetup,
} from "@mycli/config";
import {
	prepareUserRipgrep,
	resolveRipgrep,
	type PrepareUserRipgrepOptions,
	type ResolveRipgrepOptions,
	type RipgrepPrepareResult,
} from "@mycli/tools";
import {
	runSetupTui,
	type SetupProvider,
	type SetupWizardResult,
	type SetupWizardState,
} from "mycli-shell-tui";
import type { ApiKeyInputReader } from "./auth.ts";
import type { ManagementResponse } from "./types.ts";

export interface SetupInputStream extends NodeJS.ReadableStream {
	readonly isTTY?: boolean;
	readonly isRaw?: boolean;
	setRawMode?(mode: boolean): this;
}

export interface SetupOutputStream extends NodeJS.WritableStream {
	readonly isTTY?: boolean;
	write(value: string): boolean;
}

export type SetupInteraction = (
	state: SetupWizardState,
	signal?: AbortSignal,
) => Promise<SetupWizardResult | undefined>;

export interface RunSetupCommandOptions {
	readonly homeDir: string;
	readonly isTty: boolean;
	readonly input?: SetupInputStream;
	readonly output?: SetupOutputStream;
	readonly signal?: AbortSignal;
	readonly nonInteractive?: {
		readonly provider: string;
		readonly model?: string;
		readonly apiBaseUrl?: string;
		readonly readApiKeyInput: ApiKeyInputReader;
	};
	readonly runTui?: SetupInteraction;
	readonly runPlain?: SetupInteraction;
	readonly prepareRipgrep?: (
		options: PrepareUserRipgrepOptions,
	) => Promise<RipgrepPrepareResult>;
	readonly resolveRipgrep?: (options: ResolveRipgrepOptions) => string | undefined;
}

export interface SetupCommandResponse extends ManagementResponse {
	readonly action: "setup";
	readonly cancelled?: boolean;
	readonly exitCode?: number;
	readonly provider?: string;
	readonly protocol?: string;
	readonly model?: string;
	readonly apiBaseUrl?: string;
	readonly configPath?: string;
	readonly authPath?: string;
	readonly ripgrepPath?: string;
	readonly ripgrepInstalled?: boolean;
}

export async function runSetupCommand(
	options: RunSetupCommandOptions,
): Promise<SetupCommandResponse> {
	if (options.signal?.aborted) return cancelled();
	if (options.nonInteractive) {
		return runNonInteractiveSetup(options, options.nonInteractive);
	}
	if (!options.isTty) {
		return failure(
			"non-interactive setup requires explicit provider options and an API key on stdin",
			"setup_non_interactive_required",
			2,
		);
	}
	const state = await buildSetupState(options.homeDir);
	const runTui = options.runTui ?? ((nextState, signal) => runSetupTui({
		state: nextState,
		...(signal ? { signal } : {}),
	}));
	const runPlain = options.runPlain ?? ((nextState, signal) => runPlainSetup(
		nextState,
		options.input ?? process.stdin,
		options.output ?? process.stdout,
		signal,
	));
	let result: SetupWizardResult | undefined;
	if (options.isTty) {
		try {
			result = await runTui(state, options.signal);
		} catch {
			result = await runPlain(state, options.signal);
		}
	}
	if (!result) return cancelled();
	const prepareRipgrep = async (
		prepareOptions: PrepareUserRipgrepOptions,
	): Promise<RipgrepPrepareResult> => {
		const existing = (options.resolveRipgrep ?? resolveRipgrep)({
			homeDir: options.homeDir,
			pathValue: "",
		});
		if (existing) return { path: existing, installed: false };
		return await (options.prepareRipgrep ?? prepareUserRipgrep)(prepareOptions);
	};
	return saveSetupResult(
		options.homeDir,
		result,
		prepareRipgrep,
		options.signal,
	);
}

async function runNonInteractiveSetup(
	options: RunSetupCommandOptions,
	input: NonNullable<RunSetupCommandOptions["nonInteractive"]>,
): Promise<SetupCommandResponse> {
	const profile = listProviderProfiles().find((item) => item.provider === input.provider);
	const model = input.model?.trim() || profile?.defaultModel;
	const apiBaseUrl = input.apiBaseUrl?.trim() || profile?.defaultBaseUrl;
	if (!profile || !model || !apiBaseUrl) {
		return failure(
			"non-interactive setup requires a supported provider and complete model settings",
			"setup_invalid_options",
			2,
		);
	}
	let apiKey: string;
	try {
		apiKey = await input.readApiKeyInput(options.signal ?? new AbortController().signal);
	} catch (error) {
		if (options.signal?.aborted || isAbortError(error)) return cancelled();
		return failure(
			"non-interactive setup requires a non-empty API key on stdin",
			"setup_api_key_input_failed",
			2,
		);
	}
	const prepareRipgrep = setupRipgrepPreparer(options);
	return saveSetupResult(options.homeDir, {
		provider: profile.provider,
		api_base_url: apiBaseUrl,
		model,
		api_key: apiKey,
	}, prepareRipgrep, options.signal);
}

function setupRipgrepPreparer(
	options: RunSetupCommandOptions,
): NonNullable<RunSetupCommandOptions["prepareRipgrep"]> {
	return async (prepareOptions) => {
		const existing = (options.resolveRipgrep ?? resolveRipgrep)({
			homeDir: options.homeDir,
			pathValue: "",
		});
		if (existing) return { path: existing, installed: false };
		return await (options.prepareRipgrep ?? prepareUserRipgrep)(prepareOptions);
	};
}

async function buildSetupState(homeDir: string): Promise<SetupWizardState> {
	const providers = await Promise.all(listProviderProfiles().map(async (profile): Promise<SetupProvider> => ({
		id: profile.provider,
		name: profile.displayName,
		configured: Boolean(await readApiKey({ homeDir, authRef: profile.provider })),
		default_model: profile.defaultModel ?? "",
		default_base_url: profile.defaultBaseUrl,
		protocol: profile.defaultProtocol,
	})));
	return Object.freeze({
		providers: Object.freeze(providers),
		config_path: join(homeDir, ".mycli", "config.toml"),
		auth_path: join(homeDir, ".mycli", "auth.json"),
	});
}

async function saveSetupResult(
	homeDir: string,
	result: SetupWizardResult,
	prepareRipgrep: NonNullable<RunSetupCommandOptions["prepareRipgrep"]>,
	signal?: AbortSignal,
): Promise<SetupCommandResponse> {
	const profile = listProviderProfiles().find((item) => item.provider === result.provider);
	if (!profile || !result.model.trim() || !result.api_base_url.trim() || !result.api_key.trim()) {
		return failure("setup returned incomplete provider settings", "setup_invalid_result");
	}
	let configPath: string;
	let authPath: string;
	try {
		const reasoning = builtinModelReasoningDefaults({
			provider: profile.provider,
			protocol: profile.defaultProtocol,
			model: result.model.trim(),
		});
		const saved = await writeUserProviderSetup({
			homeDir,
			provider: profile.provider,
			protocol: profile.defaultProtocol,
			model: result.model,
			apiBaseUrl: result.api_base_url,
			authRef: profile.provider,
			cacheRetention: "short",
			thinkingEnabled: reasoning.thinkingEnabled,
			reasoningEffort: reasoning.reasoningEffort,
			apiKey: result.api_key,
		});
		configPath = saved.configPath;
		authPath = saved.authPath;
	} catch {
		return failure("setup could not save configuration", "setup_write_failed");
	}
	const baseResponse = {
		ok: true,
		action: "setup" as const,
		provider: profile.provider,
		protocol: profile.defaultProtocol,
		model: result.model.trim(),
		apiBaseUrl: result.api_base_url.trim().replace(/\/+$/u, ""),
		configPath,
		authPath,
	};
	try {
		const ripgrep = await prepareRipgrep({
			destinationRoot: join(homeDir, ".mycli", "vendor", "ripgrep"),
			...(signal ? { signal } : {}),
		});
		return Object.freeze({
			...baseResponse,
			message: ripgrep.installed
				? `setup saved for ${profile.provider}; ripgrep prepared`
				: `setup saved for ${profile.provider}; ripgrep already prepared`,
			ripgrepPath: ripgrep.path,
			ripgrepInstalled: ripgrep.installed,
		});
	} catch (error) {
		const interrupted = isAbortError(error);
		return Object.freeze({
			...baseResponse,
			message: interrupted
				? `setup saved for ${profile.provider}; ripgrep preparation interrupted`
				: `setup saved for ${profile.provider}; ripgrep preparation failed`,
			issues: Object.freeze([
				interrupted ? "ripgrep_prepare_interrupted" : "ripgrep_prepare_failed",
			]),
		});
	}
}

async function runPlainSetup(
	state: SetupWizardState,
	input: SetupInputStream,
	output: SetupOutputStream,
	signal?: AbortSignal,
): Promise<SetupWizardResult | undefined> {
	const rl = createInterface({ input: input as Readable, output: output as Writable, terminal: false });
	const iterator = rl[Symbol.asyncIterator]();
	const ask = (prompt: string): Promise<string> => readLine(iterator, output, prompt, signal);
	try {
		output.write("mycli setup\n");
		state.providers.forEach((provider, index) => {
			const configured = provider.configured ? " configured" : "";
			output.write(`${index + 1}. ${provider.name}${configured}\n`);
		});
		const selected = await promptProvider(ask, state.providers);
		const apiBaseUrl = await promptNonEmpty(
			ask,
			`API base URL [${selected.default_base_url ?? ""}]: `,
			selected.default_base_url ?? "",
		);
		const model = await promptNonEmpty(
			ask,
			`Model [${selected.default_model ?? ""}]: `,
			selected.default_model ?? "",
		);
		let apiKey: string;
		if (input.isTTY && input.setRawMode) {
			rl.close();
			apiKey = await promptRawSecret(input, output, signal);
		} else {
			apiKey = await promptNonEmpty(ask, "API key: ", "");
		}
		return { provider: selected.id, api_base_url: apiBaseUrl, model, api_key: apiKey };
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) return undefined;
		throw new Error("plain_setup_failed");
	} finally {
		rl.close();
	}
}

async function promptProvider(
	ask: (prompt: string) => Promise<string>,
	providers: readonly SetupProvider[],
): Promise<SetupProvider> {
	while (true) {
		const raw = (await ask("Provider [1]: ")).trim();
		if (!raw) return providers[0]!;
		const number = Number(raw);
		if (Number.isInteger(number) && number >= 1 && number <= providers.length) {
			return providers[number - 1]!;
		}
		const byId = providers.find((provider) => provider.id === raw.toLowerCase());
		if (byId) return byId;
	}
}

async function promptNonEmpty(
	ask: (prompt: string) => Promise<string>,
	prompt: string,
	fallback: string,
): Promise<string> {
	while (true) {
		const value = (await ask(prompt)).trim() || fallback;
		if (value) return value;
	}
}

async function readLine(
	iterator: AsyncIterator<string>,
	output: SetupOutputStream,
	prompt: string,
	signal?: AbortSignal,
): Promise<string> {
	if (signal?.aborted) throw abortError();
	output.write(prompt);
	const next = signal ? await abortable(iterator.next(), signal) : await iterator.next();
	if (next.done) throw new Error("setup_input_closed");
	return next.value;
}

function promptRawSecret(
	input: SetupInputStream,
	output: SetupOutputStream,
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let value = "";
		const wasRaw = input.isRaw === true;
		const cleanup = (): void => {
			input.off("data", onData);
			signal?.removeEventListener("abort", onAbort);
			input.setRawMode?.(wasRaw);
		};
		const onAbort = (): void => {
			cleanup();
			reject(abortError());
		};
		const onData = (chunk: Buffer | string): void => {
			for (const character of String(chunk)) {
				if (character === "\u0003") return onAbort();
				if (character === "\r" || character === "\n") {
					if (!value.trim()) continue;
					cleanup();
					output.write("\n");
					resolve(value.trim());
					return;
				}
				if (character === "\u007f" || character === "\b") {
					value = value.slice(0, -1);
					continue;
				}
				if (character >= " ") value += character;
			}
		};
		output.write("API key: ");
		input.setRawMode?.(true);
		input.resume();
		input.on("data", onData);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
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

function cancelled(): SetupCommandResponse {
	return Object.freeze({
		ok: false,
		action: "setup",
		message: "setup cancelled",
		cancelled: true,
		exitCode: 130,
	});
}

function failure(message: string, issue: string, exitCode?: number): SetupCommandResponse {
	return Object.freeze({
		ok: false,
		action: "setup",
		message,
		issues: Object.freeze([issue]),
		...(exitCode === undefined ? {} : { exitCode }),
	});
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

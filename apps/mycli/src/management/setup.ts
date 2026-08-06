import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import {
	listProviderProfiles,
	readApiKey,
	writeApiKey,
	writeUserProviderConfig,
} from "@mycli/config";
import {
	runSetupTui,
	type SetupProvider,
	type SetupWizardResult,
	type SetupWizardState,
} from "mycli-shell-tui";
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
	readonly runTui?: SetupInteraction;
	readonly runPlain?: SetupInteraction;
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
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = Object.freeze({
	openai: "OpenAI",
	codex: "Codex Responses",
	deepseek: "DeepSeek",
	qwen: "Qwen",
	anthropic: "Anthropic",
	compatible: "Compatible",
});

export async function runSetupCommand(
	options: RunSetupCommandOptions,
): Promise<SetupCommandResponse> {
	if (options.signal?.aborted) return cancelled();
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
	} else {
		result = await runPlain(state, options.signal);
	}
	if (!result) return cancelled();
	return saveSetupResult(options.homeDir, result);
}

async function buildSetupState(homeDir: string): Promise<SetupWizardState> {
	const providers = await Promise.all(listProviderProfiles().map(async (profile): Promise<SetupProvider> => ({
		id: profile.provider,
		name: PROVIDER_NAMES[profile.provider] ?? profile.provider,
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
): Promise<SetupCommandResponse> {
	const profile = listProviderProfiles().find((item) => item.provider === result.provider);
	if (!profile || !result.model.trim() || !result.api_base_url.trim() || !result.api_key.trim()) {
		return failure("setup returned incomplete provider settings", "setup_invalid_result");
	}
	try {
		const configPath = await writeUserProviderConfig({
			homeDir,
			provider: profile.provider,
			protocol: profile.defaultProtocol,
			model: result.model,
			apiBaseUrl: result.api_base_url,
			authRef: profile.provider,
			promptCacheKeyEnabled: profile.promptCacheKeyEnabled,
			cacheControlEnabled: profile.cacheControlEnabled,
		});
		await writeApiKey({ homeDir, authRef: profile.provider, apiKey: result.api_key });
		return Object.freeze({
			ok: true,
			action: "setup",
			message: `setup saved for ${profile.provider}`,
			provider: profile.provider,
			protocol: profile.defaultProtocol,
			model: result.model.trim(),
			apiBaseUrl: result.api_base_url.trim().replace(/\/+$/u, ""),
			configPath,
			authPath: join(homeDir, ".mycli", "auth.json"),
		});
	} catch {
		return failure("setup could not save configuration", "setup_write_failed");
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

function failure(message: string, issue: string): SetupCommandResponse {
	return Object.freeze({ ok: false, action: "setup", message, issues: Object.freeze([issue]) });
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

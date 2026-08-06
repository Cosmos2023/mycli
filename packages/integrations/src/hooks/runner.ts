import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { HookInvocation, HookResult } from "@mycli/core";
import {
	createProcessController,
	prepareSandboxedProcess,
	type SandboxedProcessLaunch,
	type SandboxProfile,
} from "@mycli/tools";
import { configuredHookMatches } from "./config.ts";
import type { HookAllowlistStore } from "./allowlist.ts";
import type {
	ConfiguredHookExecutorContract,
	ConfiguredHookSpec,
	ConfiguredHookTraceSummary,
} from "./types.ts";

export interface ConfiguredHookRunnerOptions {
	readonly workspaceRoot: string;
	readonly allowlistStore: Pick<HookAllowlistStore, "statusFor">;
	readonly sandboxProfile: (cwd: string) => SandboxProfile;
	readonly env?: Readonly<NodeJS.ProcessEnv>;
	readonly onTrace?: (trace: ConfiguredHookTraceSummary) => void;
	readonly monotonic?: () => number;
	readonly prepareProcess?: (
		argv: readonly string[],
		profile: SandboxProfile,
	) => SandboxedProcessLaunch;
}

interface ProcessOutcome {
	readonly kind: "exit" | "timeout" | "overflow" | "spawn_error" | "interrupted";
	readonly exitCode?: number;
	readonly stdout: CaptureSnapshot;
	readonly stderr: CaptureSnapshot;
}

interface CaptureSnapshot {
	readonly text: string;
	readonly chars: number;
	readonly truncated: boolean;
}

const MAX_INPUT_CHARS = 65_536;
const MAX_OUTPUT_CHARS = 2_000;
const MAX_CONTEXTS = 8;
const MAX_MODIFIED_ARGUMENTS = 20;
const MINIMAL_PATH = process.platform === "win32"
	? "C:\\Windows\\System32;C:\\Windows"
	: "/usr/bin:/bin:/usr/sbin:/sbin";
const SAFE_ENV_KEYS = ["HOME", "PATH", "SHELL", "TMPDIR", "USER"] as const;
const SENSITIVE_TEXT = /\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*\S+)/iu;
const BLOCKING_EXIT_POINTS = new Set([
	"pre_tool_use",
	"post_tool_use",
	"user_prompt_submit",
	"stop",
]);
const PLAIN_CONTEXT_POINTS = new Set(["session_start", "user_prompt_submit"]);
const CODEX_CONTEXT_POINTS = new Set(["post_tool_use", "session_start", "user_prompt_submit"]);

export class ConfiguredHookRunner implements ConfiguredHookExecutorContract {
	readonly #options: ConfiguredHookRunnerOptions;
	readonly #env: Readonly<NodeJS.ProcessEnv>;
	readonly #monotonic: () => number;
	readonly #prepareProcess: NonNullable<ConfiguredHookRunnerOptions["prepareProcess"]>;

	constructor(options: ConfiguredHookRunnerOptions) {
		if (!options.workspaceRoot.trim()) throw new TypeError("workspaceRoot must be non-empty");
		this.#options = options;
		this.#env = options.env ?? process.env;
		this.#monotonic = options.monotonic ?? (() => performance.now());
		this.#prepareProcess = options.prepareProcess ?? prepareSandboxedProcess;
	}

	async run(
		spec: ConfiguredHookSpec,
		invocation: HookInvocation,
		signal: AbortSignal,
	): Promise<HookResult> {
		assertNotAborted(signal);
		const startedAt = this.#monotonic();
		if (!spec.enabled || spec.hookPoint !== invocation.point || !configuredHookMatches(spec, {
			...(invocation.toolName ? { toolName: invocation.toolName } : {}),
			...(typeof invocation.metadata.source === "string"
				? { source: invocation.metadata.source }
				: {}),
		})) {
			const result = allowResult();
			this.#trace(spec, invocation, startedAt, result, emptyCapture(), emptyCapture(), "skipped");
			return result;
		}

		const approval = await this.#options.allowlistStore.statusFor(spec);
		assertNotAborted(signal);
		if (!approval.allowed) {
			const result = errorResult("configured hook not allowlisted");
			this.#trace(
				spec,
				invocation,
				startedAt,
				result,
				emptyCapture(),
				emptyCapture(),
				`not allowlisted: ${approval.reason}`,
			);
			return result;
		}

		let input: string;
		try {
			input = JSON.stringify(hookPayload(invocation));
		} catch {
			const result = errorResult("configured hook input invalid");
			this.#trace(spec, invocation, startedAt, result, emptyCapture(), emptyCapture(), "input_invalid");
			return result;
		}
		if (input.length > MAX_INPUT_CHARS) {
			const result = errorResult("configured hook input too large");
			this.#trace(spec, invocation, startedAt, result, emptyCapture(), emptyCapture(), "input_too_large");
			return result;
		}

		const cwd = spec.workingDirectory === "config" ? dirname(spec.configPath) : this.#options.workspaceRoot;
		let launch: SandboxedProcessLaunch;
		try {
			launch = this.#prepareProcess(spec.command, this.#options.sandboxProfile(cwd));
		} catch {
			const result = errorResult("configured hook failed");
			this.#trace(spec, invocation, startedAt, result, emptyCapture(), emptyCapture(), "sandbox_unavailable");
			return result;
		}

		const outcome = await runChildProcess({
			launch,
			cwd,
			env: hookEnvironment(spec, this.#env),
			input,
			timeoutMs: spec.timeoutMs,
			signal,
		});
		if (outcome.kind === "interrupted") {
			const result = errorResult("configured hook interrupted");
			this.#trace(
				spec,
				invocation,
				startedAt,
				result,
				outcome.stdout,
				outcome.stderr,
				"interrupted",
				undefined,
				"interrupted",
			);
			throw abortError();
		}

		const result = resultFromOutcome(spec, outcome);
		this.#trace(
			spec,
			invocation,
			startedAt,
			result.result,
			outcome.stdout,
			outcome.stderr,
			result.traceMessage,
			outcome.exitCode,
		);
		return result.result;
	}

	#trace(
		spec: ConfiguredHookSpec,
		invocation: HookInvocation,
		startedAt: number,
		result: HookResult,
		stdout: CaptureSnapshot,
		stderr: CaptureSnapshot,
		message: string,
		exitCode?: number,
		status?: ConfiguredHookTraceSummary["status"],
	): void {
		const trace = Object.freeze({
			executionId: executionId(spec, invocation),
			hookId: spec.hookId,
			hookName: spec.name,
			hookPoint: spec.hookPoint,
			status: status ?? (result.action === "error" ? "error" : "ok"),
			action: result.action,
			durationMs: Math.max(0, Math.round(this.#monotonic() - startedAt)),
			...(exitCode === undefined ? {} : { exitCode }),
			stdoutChars: stdout.chars,
			stderrChars: stderr.chars,
			stdoutTruncated: stdout.truncated,
			stderrTruncated: stderr.truncated,
			...(message ? { message: safeTraceMessage(message) } : {}),
		}) satisfies ConfiguredHookTraceSummary;
		try {
			this.#options.onTrace?.(trace);
		} catch {
			// Diagnostics must not affect hook behavior.
		}
	}
}

async function runChildProcess(options: {
	readonly launch: SandboxedProcessLaunch;
	readonly cwd: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly input: string;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
}): Promise<ProcessOutcome> {
	const child = spawn(options.launch.executable, [...options.launch.args], {
		cwd: options.cwd,
		env: { ...options.env },
		shell: false,
		windowsHide: true,
		detached: process.platform !== "win32",
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stdout = new BoundedCapture(MAX_OUTPUT_CHARS);
	const stderr = new BoundedCapture(MAX_OUTPUT_CHARS);
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdin.on("error", () => undefined);

	return new Promise((resolveOutcome) => {
		let finalizing = false;
		const controller = child.pid === undefined
			? undefined
			: createProcessController({
				pid: child.pid,
				exitCode: child.exitCode,
				signalCode: child.signalCode,
				kill: (signal) => child.kill(signal),
			});

		const finish = async (
			kind: ProcessOutcome["kind"],
			exitCode?: number,
			cleanup?: "interrupt" | "terminate",
		): Promise<void> => {
			if (finalizing) return;
			finalizing = true;
			clearTimeout(timer);
			options.signal.removeEventListener("abort", onAbort);
			if (cleanup && controller) {
				try {
					await controller[cleanup]();
				} catch {
					// The outcome remains fail-closed even if cleanup evidence is inconclusive.
				}
			}
			resolveOutcome(Object.freeze({
				kind,
				...(exitCode === undefined ? {} : { exitCode }),
				stdout: stdout.snapshot(),
				stderr: stderr.snapshot(),
			}));
		};
		const onAbort = (): void => { void finish("interrupted", undefined, "interrupt"); };
		const onOutput = (capture: BoundedCapture, chunk: string): void => {
			if (capture.append(chunk)) void finish("overflow", undefined, "terminate");
		};
		const timer = setTimeout(
			() => { void finish("timeout", undefined, "terminate"); },
			options.timeoutMs,
		);

		child.stdout.on("data", (chunk: string) => onOutput(stdout, chunk));
		child.stderr.on("data", (chunk: string) => onOutput(stderr, chunk));
		child.once("error", () => { void finish("spawn_error", undefined, "terminate"); });
		child.once("close", (code) => { void finish("exit", code ?? 1); });
		options.signal.addEventListener("abort", onAbort, { once: true });
		if (options.signal.aborted) {
			onAbort();
			return;
		}
		child.stdin.end(options.input, "utf8");
	});
}

class BoundedCapture {
	#text = "";
	#chars = 0;
	#truncated = false;

	constructor(readonly limit: number) {}

	append(chunk: string): boolean {
		const remaining = Math.max(0, this.limit - this.#text.length);
		if (remaining > 0) this.#text += chunk.slice(0, remaining);
		this.#chars = Math.min(this.limit + 1, this.#chars + chunk.length);
		if (chunk.length > remaining || this.#chars > this.limit) this.#truncated = true;
		return this.#truncated;
	}

	snapshot(): CaptureSnapshot {
		return Object.freeze({
			text: this.#text,
			chars: this.#chars,
			truncated: this.#truncated,
		});
	}
}

function resultFromOutcome(
	spec: ConfiguredHookSpec,
	outcome: ProcessOutcome,
): { readonly result: HookResult; readonly traceMessage: string } {
	if (outcome.kind === "timeout") {
		return { result: errorResult("configured hook timed out"), traceMessage: "timeout" };
	}
	if (outcome.kind === "overflow") {
		return { result: errorResult("configured hook output too large"), traceMessage: "output_too_large" };
	}
	if (outcome.kind === "spawn_error") {
		return { result: errorResult("configured hook failed"), traceMessage: "spawn_failed" };
	}
	const exitCode = outcome.exitCode ?? 1;
	if (exitCode === 2 && BLOCKING_EXIT_POINTS.has(spec.hookPoint)) {
		const message = safeMessage(
			outcome.stderr.text.trim() || outcome.stdout.text.trim() || "blocked by configured hook",
		);
		return { result: denyResult(message), traceMessage: message };
	}
	if (exitCode !== 0) {
		return { result: errorResult("configured hook failed"), traceMessage: "nonzero_exit" };
	}
	return resultFromOutput(spec, outcome.stdout.text.trim());
}

function resultFromOutput(
	spec: ConfiguredHookSpec,
	stdout: string,
): { readonly result: HookResult; readonly traceMessage: string } {
	let payload: unknown;
	try {
		payload = stdout ? JSON.parse(stdout) as unknown : {};
	} catch {
		if (PLAIN_CONTEXT_POINTS.has(spec.hookPoint) && !looksLikeJson(stdout)) {
			const context = safeContext(stdout);
			return {
				result: context ? allowResult([context]) : allowResult(),
				traceMessage: "",
			};
		}
		return { result: errorResult("configured hook output invalid"), traceMessage: "invalid_json" };
	}
	if (!isRecord(payload)) {
		return { result: errorResult("configured hook output invalid"), traceMessage: "invalid_result" };
	}
	const hookSpecific = isRecord(payload.hookSpecificOutput)
		? payload.hookSpecificOutput
		: undefined;
	const codexDenied = payload.decision === "block"
		|| payload.continue === false
		|| hookSpecific?.permissionDecision === "deny";
	const action = codexDenied ? "deny" : (payload.action ?? "allow");
	if (action !== "allow" && action !== "deny" && action !== "modify" && action !== "error") {
		return { result: errorResult("configured hook output invalid"), traceMessage: "invalid_action" };
	}
	const message = safeMessage(firstString(
		payload.message,
		payload.reason,
		payload.stopReason,
		hookSpecific?.permissionDecisionReason,
	) ?? "");
	if (action === "deny") {
		const deniedMessage = message || "blocked by configured hook";
		return { result: denyResult(deniedMessage), traceMessage: deniedMessage };
	}
	if (action === "error") {
		const errorMessage = message || "configured hook failed";
		return { result: errorResult(errorMessage), traceMessage: errorMessage };
	}
	if (action === "modify") {
		const argumentsValue = modifiedArguments(payload.modified_args ?? payload.arguments);
		if (!argumentsValue) {
			return { result: errorResult("configured hook output invalid"), traceMessage: "invalid_arguments" };
		}
		return {
			result: Object.freeze({ action: "modify", arguments: argumentsValue }),
			traceMessage: message,
		};
	}
	const contexts = additionalContexts(payload.additional_contexts, (
		CODEX_CONTEXT_POINTS.has(spec.hookPoint) ? hookSpecific?.additionalContext : undefined
	));
	return { result: allowResult(contexts), traceMessage: message };
}

function hookPayload(invocation: HookInvocation): Readonly<Record<string, unknown>> {
	const payload: Record<string, unknown> = {
		version: 1,
		hook_event_name: codexEventName(invocation.point),
		hook_point: invocation.point,
		tool_name: invocation.toolName ?? null,
		session_id: invocation.sessionId,
		turn_id: invocation.turnId,
		metadata_keys: Object.keys(invocation.metadata).sort(),
	};
	if (invocation.toolName) payload.tool_input = { ...invocation.arguments };
	if (typeof invocation.metadata.prompt === "string") payload.prompt = invocation.metadata.prompt;
	if (typeof invocation.metadata.source === "string") payload.source = invocation.metadata.source;
	return Object.freeze(payload);
}

function hookEnvironment(
	spec: ConfiguredHookSpec,
	environment: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
	const env: NodeJS.ProcessEnv = {
		PATH: environmentValue(environment, "PATH") || MINIMAL_PATH,
		MYCLI_HOOK_ID: spec.hookId,
		MYCLI_HOOK_POINT: spec.hookPoint,
		MYCLI_HOOK_SOURCE: spec.scope,
	};
	if (spec.envPolicy === "inherit_safe") {
		for (const key of SAFE_ENV_KEYS) {
			const value = environmentValue(environment, key);
			if (value) env[key] = value;
		}
	}
	return Object.freeze(env);
}

function environmentValue(
	environment: Readonly<NodeJS.ProcessEnv>,
	key: string,
): string | undefined {
	const normalized = key.toLowerCase();
	for (const [name, value] of Object.entries(environment)) {
		if (name.toLowerCase() === normalized) return value;
	}
	return undefined;
}

function modifiedArguments(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value).slice(0, MAX_MODIFIED_ARGUMENTS);
	return Object.freeze(Object.fromEntries(entries));
}

function additionalContexts(...values: readonly unknown[]): readonly string[] {
	const contexts: string[] = [];
	let remaining = MAX_OUTPUT_CHARS;
	for (const value of values) {
		const candidates = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
		for (const candidate of candidates) {
			if (typeof candidate !== "string" || contexts.length >= MAX_CONTEXTS || remaining <= 0) continue;
			const context = safeContext(candidate).slice(0, remaining);
			if (!context) continue;
			contexts.push(context);
			remaining -= context.length;
		}
	}
	return Object.freeze(contexts);
}

function allowResult(contexts: readonly string[] = []): HookResult {
	return contexts.length > 0
		? Object.freeze({ action: "allow", additionalContexts: Object.freeze([...contexts]) })
		: Object.freeze({ action: "allow" });
}

function denyResult(message: string): HookResult {
	return Object.freeze({ action: "deny", message });
}

function errorResult(message: string): HookResult {
	return Object.freeze({ action: "error", message });
}

function emptyCapture(): CaptureSnapshot {
	return Object.freeze({ text: "", chars: 0, truncated: false });
}

function safeMessage(value: string): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	return SENSITIVE_TEXT.test(normalized) ? "redacted" : normalized.slice(0, 200);
}

function safeTraceMessage(value: string): string {
	return safeMessage(value)
		.replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, "[PATH]")
		.replace(/(^|[\s"'(])\/[^\s"'(),;]*/gu, "$1[PATH]");
}

function safeContext(value: string): string {
	const normalized = value.trim();
	return SENSITIVE_TEXT.test(normalized) ? "redacted" : normalized.slice(0, MAX_OUTPUT_CHARS);
}

function firstString(...values: readonly unknown[]): string | undefined {
	return values.find((value): value is string => typeof value === "string");
}

function looksLikeJson(value: string): boolean {
	const stripped = value.trimStart();
	return stripped.startsWith("{") || stripped.startsWith("[");
}

function codexEventName(point: HookInvocation["point"]): string {
	return ({
		pre_tool_use: "PreToolUse",
		post_tool_use: "PostToolUse",
		session_start: "SessionStart",
		user_prompt_submit: "UserPromptSubmit",
		stop: "Stop",
	} as Partial<Record<HookInvocation["point"], string>>)[point] ?? point;
}

function executionId(spec: ConfiguredHookSpec, invocation: HookInvocation): string {
	const canonical = [
		spec.scope,
		spec.hookId,
		spec.hookPoint,
		invocation.sessionId,
		invocation.turnId,
		invocation.toolName ?? "",
	].join("\0");
	return `hookexec_${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16)}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError();
}

function abortError(): Error {
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

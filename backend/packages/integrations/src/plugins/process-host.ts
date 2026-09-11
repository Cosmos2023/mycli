import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parsePluginV2ProtocolMessage,
	type PluginV2ProtocolMessage,
} from "@mycli/contracts";
import {
	createProcessController,
	prepareSandboxedProcess,
	type ProcessController,
	type SandboxedProcessLaunch,
	type SandboxProfile,
} from "@mycli/tools";
import type {
	LoadedPluginManifest,
	PluginHostErrorKind,
	PluginHostStatus,
	PluginFailureEvidence,
	PluginInvocationResult,
	PluginProtocolRegistration,
	PluginResultType,
} from "./types.ts";

type RegisteredMessage = Extract<PluginV2ProtocolMessage, { readonly type: "registered" }>;
type ResultMessage = Extract<PluginV2ProtocolMessage, { readonly type: "result" }>;
type ShutdownCompleteMessage = Extract<PluginV2ProtocolMessage, { readonly type: "shutdown_complete" }>;
type ExpectedMessage = RegisteredMessage | ResultMessage | ShutdownCompleteMessage;

interface PendingRequest {
	readonly phase: "connect" | "request" | "shutdown";
	readonly timeoutMs: number;
	dispatched: boolean;
	readonly expectedType: ExpectedMessage["type"];
	readonly timeoutKind: "startup_timeout" | "call_timeout";
	readonly resolve: (message: ExpectedMessage) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
	readonly signal?: AbortSignal;
	readonly onAbort?: () => void;
}

export interface PluginProcessHostOptions {
	readonly manifest: LoadedPluginManifest;
	readonly sandboxProfile: SandboxProfile;
	readonly env?: Readonly<NodeJS.ProcessEnv>;
	readonly startupTimeoutMs?: number;
	readonly callTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly maxLineBytes?: number;
	readonly maxStderrBytes?: number;
	readonly maxOutstandingRequests?: number;
	readonly prepareProcess?: (
		argv: readonly string[],
		profile: SandboxProfile,
	) => SandboxedProcessLaunch;
	readonly workerPath?: string;
	readonly workerExecArgv?: readonly string[];
}

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_LINE_BYTES = 262_144;
const DEFAULT_MAX_STDERR_BYTES = 32_768;
const DEFAULT_MAX_OUTSTANDING = 32;
const MAX_PROTOCOL_LIMIT = 1_048_576;
const MINIMAL_ENV_KEYS = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"] as const;

export class PluginHostError extends Error {
	readonly evidence: PluginFailureEvidence;

	constructor(readonly kind: PluginHostErrorKind, evidence: PluginFailureEvidence = {}) {
		super(`plugin_host_error: ${kind}`);
		this.name = "PluginHostError";
		const previous = evidence.previous ? Object.freeze({
			kind: evidence.previous.kind,
			evidence: Object.freeze({ ...evidence.previous.evidence, previous: undefined }),
		}) : undefined;
		this.evidence = Object.freeze({ ...evidence, ...(previous ? { previous } : {}) });
	}
}

export class PluginProcessHost {
	readonly #options: Required<Pick<
		PluginProcessHostOptions,
		"startupTimeoutMs" | "callTimeoutMs" | "shutdownTimeoutMs" | "maxLineBytes"
		| "maxStderrBytes" | "maxOutstandingRequests"
	>> & PluginProcessHostOptions;
	readonly #prepareProcess: NonNullable<PluginProcessHostOptions["prepareProcess"]>;
	readonly #pending = new Map<string, PendingRequest>();
	#status: PluginHostStatus = "idle";
	#child?: ChildProcessWithoutNullStreams;
	#controller?: ProcessController;
	#stdout = Buffer.alloc(0);
	#stderrBytes = 0;
	#requestSequence = 0;
	#registrations: readonly PluginProtocolRegistration[] = Object.freeze([]);
	#startPromise?: Promise<readonly PluginProtocolRegistration[]>;
	#closePromise?: Promise<void>;
	#cleanupPromise?: Promise<void>;
	#failure?: PluginHostError;
	readonly #listeners = new Set<() => void>();

	constructor(options: PluginProcessHostOptions) {
		this.#options = {
			...options,
			startupTimeoutMs: positiveLimit(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 60_000),
			callTimeoutMs: positiveLimit(options.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS, 300_000),
			shutdownTimeoutMs: positiveLimit(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS, 60_000),
			maxLineBytes: positiveLimit(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, MAX_PROTOCOL_LIMIT),
			maxStderrBytes: positiveLimit(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, MAX_PROTOCOL_LIMIT),
			maxOutstandingRequests: positiveLimit(options.maxOutstandingRequests, DEFAULT_MAX_OUTSTANDING, 1_024),
		};
		this.#prepareProcess = options.prepareProcess ?? prepareSandboxedProcess;
	}

	get status(): PluginHostStatus {
		return this.#status;
	}

	get registrations(): readonly PluginProtocolRegistration[] {
		return this.#registrations;
	}

	get failure(): PluginHostError | undefined { return this.#failure; }

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}

	start(signal: AbortSignal): Promise<readonly PluginProtocolRegistration[]> {
		if (this.#status === "ready") return Promise.resolve(this.#registrations);
		if (this.#status === "closed" || this.#status === "closing" || this.#status === "failed") {
			return Promise.reject(new PluginHostError("host_closed", { phase: "connect", dispatched: false, previous: this.#failure }));
		}
		this.#startPromise ??= this.#initialize(signal);
		return this.#startPromise;
	}

	async invoke(
		target: string,
		input: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<PluginInvocationResult> {
		await this.start(signal);
		if (!this.#registrations.some((registration) => registration.token === target)) {
			throw new PluginHostError("unknown_target", { phase: "request", dispatched: false });
		}
		const response = await this.#request({
			version: 2,
			type: "invoke",
			request_id: this.#requestId(),
			target,
			input,
		}, "result", this.#options.callTimeoutMs, "call_timeout", signal);
		try {
			if (response.type !== "result") throw new PluginHostError("protocol_invalid");
			const result = invocationResult(response);
			const registration = this.#registrations.find((item) => item.token === target)!;
			if (result.resultType !== `${registration.kind}_result`) throw new PluginHostError("protocol_invalid");
			return result;
		} catch {
			const error = new PluginHostError("protocol_invalid", { phase: "request", dispatched: true });
			this.#fail(error, "terminate");
			throw error;
		}
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #initialize(signal: AbortSignal): Promise<readonly PluginProtocolRegistration[]> {
		assertNotAborted(signal);
		this.#setStatus("starting");
		let environment: Readonly<NodeJS.ProcessEnv>;
		try {
			environment = workerEnvironment(this.#options.manifest, this.#options.env ?? process.env);
		} catch (error) {
			const failure = new PluginHostError(error instanceof PluginHostError ? error.kind : "plugin_error", { phase: "connect", dispatched: false });
			this.#fail(failure, "terminate");
			throw failure;
		}
		let launch: SandboxedProcessLaunch;
		try {
			const workerPath = this.#options.workerPath ?? defaultWorkerPath();
			const execArgv = this.#options.workerExecArgv ?? defaultWorkerExecArgv();
			launch = this.#prepareProcess(
				[process.execPath, ...execArgv, workerPath, this.#options.manifest.entryPath],
				this.#options.sandboxProfile,
			);
		} catch {
			const error = new PluginHostError("sandbox_unavailable", { phase: "connect", dispatched: false });
			this.#fail(error, "terminate");
			throw error;
		}
		this.#spawn(launch, environment);
		const response = await this.#request({
			version: 2,
			type: "initialize",
			request_id: this.#requestId(),
			plugin_id: this.#options.manifest.id,
			declared: this.#options.manifest.provides,
			capabilities: this.#options.manifest.capabilities,
			requires_env: this.#options.manifest.requires_env,
		}, "registered", this.#options.startupTimeoutMs, "startup_timeout", signal);
		if (response.type !== "registered") throw new PluginHostError("protocol_invalid");
		try {
			this.#registrations = validateRegistrations(response.registrations, this.#options.manifest);
		} catch {
			const error = new PluginHostError("registration_mismatch", { phase: "connect", dispatched: false });
			this.#fail(error, "terminate");
			throw error;
		}
		this.#setStatus("ready");
		return this.#registrations;
	}

	#spawn(launch: SandboxedProcessLaunch, environment: Readonly<NodeJS.ProcessEnv>): void {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(launch.executable, [...launch.args], {
				cwd: this.#options.manifest.pluginRoot,
				env: { ...environment },
				shell: false,
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch {
			const error = new PluginHostError("spawn_failed", { phase: "connect", dispatched: false });
			this.#fail(error, "terminate");
			throw error;
		}
		this.#child = child;
		child.stdin.on("error", () => undefined);
		child.stdout.on("data", (chunk: Buffer) => this.#acceptStdout(chunk));
		child.stderr.on("data", (chunk: Buffer) => this.#acceptStderr(chunk));
		child.once("error", (error) => this.#fail(new PluginHostError("spawn_failed", {
			phase: "connect", dispatched: false,
			transportCode: "code" in error && typeof error.code === "string" ? error.code : undefined,
		}), "terminate"));
		child.once("close", (exitCode, signal) => {
			if (this.#status === "closed") return;
			if (this.#status === "closing" && this.#pending.size === 0) {
				this.#setStatus("closed");
				return;
			}
			this.#fail(new PluginHostError("worker_exited", {
				phase: this.#status === "starting" ? "connect" : "request",
				...(exitCode === null ? {} : { exitCode }), ...(signal === null ? {} : { signal }),
			}), "terminate");
		});
		if (child.pid !== undefined) {
			this.#controller = createProcessController({
				pid: child.pid,
				exitCode: child.exitCode,
				signalCode: child.signalCode,
				kill: (signal) => child.kill(signal),
			});
		}
	}

	#acceptStdout(chunk: Buffer): void {
		if (this.#status === "failed" || this.#status === "closed") return;
		this.#stdout = Buffer.concat([this.#stdout, chunk]);
		while (true) {
			const newline = this.#stdout.indexOf(0x0a);
			if (newline < 0) break;
			if (newline > this.#options.maxLineBytes) {
				this.#fail(new PluginHostError("stdout_limit_exceeded"), "terminate");
				return;
			}
			let line = this.#stdout.subarray(0, newline);
			this.#stdout = this.#stdout.subarray(newline + 1);
			if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
			this.#acceptLine(line);
			if (this.#isTerminal()) return;
		}
		if (this.#stdout.length > this.#options.maxLineBytes) {
			this.#fail(new PluginHostError("stdout_limit_exceeded"), "terminate");
		}
	}

	#acceptStderr(chunk: Buffer): void {
		this.#stderrBytes += chunk.byteLength;
		if (this.#stderrBytes > this.#options.maxStderrBytes) {
			this.#fail(new PluginHostError("stderr_limit_exceeded"), "terminate");
		}
	}

	#acceptLine(line: Buffer): void {
		let message: PluginV2ProtocolMessage;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
			message = parsePluginV2ProtocolMessage(JSON.parse(text) as unknown);
		} catch {
			this.#fail(new PluginHostError("protocol_invalid"), "terminate");
			return;
		}
		const pending = this.#pending.get(message.request_id);
		if (!pending) {
			this.#fail(new PluginHostError("unknown_response_id"), "terminate");
			return;
		}
		if (message.type === "error") {
			this.#settle(message.request_id);
			const error = new PluginHostError(hostErrorKind(message.error.code), { phase: pending.phase, dispatched: pending.dispatched });
			pending.reject(error);
			if (pending.expectedType === "registered") this.#fail(error, "terminate");
			return;
		}
		if (message.type !== pending.expectedType) {
			this.#fail(new PluginHostError("protocol_invalid"), "terminate");
			return;
		}
		if (message.type !== "registered" && message.type !== "result" && message.type !== "shutdown_complete") {
			this.#fail(new PluginHostError("protocol_invalid"), "terminate");
			return;
		}
		this.#settle(message.request_id);
		pending.resolve(message);
	}

	#request(
		message: Extract<PluginV2ProtocolMessage, { readonly type: "initialize" | "invoke" | "shutdown" }>,
		expectedType: PendingRequest["expectedType"],
		timeoutMs: number,
		timeoutKind: PendingRequest["timeoutKind"],
		signal?: AbortSignal,
	): Promise<ExpectedMessage> {
		const phase = message.type === "initialize" ? "connect" : message.type === "shutdown" ? "shutdown" : "request";
		if (!this.#child || this.#status === "failed" || this.#status === "closed") {
			return Promise.reject(new PluginHostError("host_closed", { phase, dispatched: false, previous: this.#failure }));
		}
		if (this.#pending.size >= this.#options.maxOutstandingRequests) {
			return Promise.reject(new PluginHostError("too_many_requests", { phase, dispatched: false }));
		}
		let line: string;
		try {
			line = `${JSON.stringify(parsePluginV2ProtocolMessage(message))}\n`;
		} catch {
			return Promise.reject(new PluginHostError("input_too_large", { phase, dispatched: false }));
		}
		if (Buffer.byteLength(line) > this.#options.maxLineBytes) {
			return Promise.reject(new PluginHostError("input_too_large", { phase, dispatched: false }));
		}
		return new Promise((resolve, reject) => {
			const onAbort = signal
				? (): void => {
					this.#settle(message.request_id);
					reject(abortError());
					this.#fail(new PluginHostError("host_closed", { phase }), "interrupt");
				}
				: undefined;
			const timer = setTimeout(() => {
				const dispatched = this.#pending.get(message.request_id)?.dispatched ?? false;
				this.#settle(message.request_id);
				const error = new PluginHostError(timeoutKind, { phase, timeoutMs, dispatched });
				reject(error);
				this.#fail(error, "terminate");
			}, timeoutMs);
			this.#pending.set(message.request_id, {
				phase, timeoutMs, dispatched: false,
				expectedType,
				timeoutKind,
				resolve,
				reject,
				timer,
				...(signal ? { signal } : {}),
				...(onAbort ? { onAbort } : {}),
			});
			signal?.addEventListener("abort", onAbort!, { once: true });
			if (signal?.aborted) {
				onAbort!();
				return;
			}
			this.#pending.get(message.request_id)!.dispatched = true;
			this.#child!.stdin.write(line, "utf8", (error) => {
				if (error) this.#fail(new PluginHostError("worker_exited"), "terminate");
			});
		});
	}

	#settle(requestId: string): void {
		const pending = this.#pending.get(requestId);
		if (!pending) return;
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort) {
			pending.signal.removeEventListener("abort", pending.onAbort);
		}
		this.#pending.delete(requestId);
	}

	#fail(error: PluginHostError, cleanup: "interrupt" | "terminate"): void {
		if (this.#status === "failed" || this.#status === "closed") return;
		const phase = this.#status === "starting" ? "connect" : this.#status === "closing" ? "shutdown" : "request";
		this.#failure = new PluginHostError(error.kind, { phase, ...error.evidence });
		this.#status = "failed";
		for (const [requestId, pending] of this.#pending) {
			this.#settle(requestId);
			pending.reject(new PluginHostError(error.kind, { ...error.evidence, phase: pending.phase, dispatched: pending.dispatched }));
		}
		// Own cleanup before notifying observers, which may close or replace this host.
		this.#cleanupPromise ??= this.#cleanup(cleanup);
		this.#notify();
	}

	#setStatus(status: PluginHostStatus): void {
		if (this.#status === status) return;
		this.#status = status;
		this.#notify();
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try { listener(); } catch { /* Observers cannot affect plugin execution. */ }
		}
	}

	async #cleanup(kind: "interrupt" | "terminate"): Promise<void> {
		try {
			await this.#controller?.[kind]();
		} catch {
			// The host remains terminal even when cleanup evidence is inconclusive.
		}
	}

	async #close(): Promise<void> {
		if (this.#status === "closed") return;
		if (this.#status === "idle") {
			this.#setStatus("closed");
			return;
		}
		if (this.#status === "failed") {
			await this.#cleanupPromise;
			return;
		}
		if (this.#status === "starting") {
			this.#fail(new PluginHostError("host_closed"), "terminate");
			await this.#cleanupPromise;
			return;
		}
		const request = this.#request({
			version: 2,
			type: "shutdown",
			request_id: this.#requestId(),
		}, "shutdown_complete", this.#options.shutdownTimeoutMs, "call_timeout");
		this.#setStatus("closing");
		try {
			await request;
		} catch {
			// Cleanup below is authoritative.
		}
		await this.#cleanup("terminate");
		this.#setStatus("closed");
	}

	#requestId(): string {
		this.#requestSequence += 1;
		return `p${this.#requestSequence}`;
	}

	#isTerminal(): boolean {
		return this.#status === "failed" || this.#status === "closed";
	}
}

function validateRegistrations(
	registrations: readonly PluginProtocolRegistration[],
	manifest: LoadedPluginManifest,
): readonly PluginProtocolRegistration[] {
	const tokens = new Set<string>();
	const names = new Set<string>();
	for (const registration of registrations) {
		if (registration.token !== `${registration.kind}:${registration.name}`
			|| tokens.has(registration.token)
			|| names.has(`${registration.kind}:${registration.name}`)) {
			throw new Error("registration mismatch");
		}
		if (registration.kind === "tool" && !manifest.provides.tools.includes(registration.name)) {
			throw new Error("registration mismatch");
		}
		if (registration.kind === "command" && !manifest.provides.commands.includes(registration.name)) {
			throw new Error("registration mismatch");
		}
		if (registration.kind === "hook" && !manifest.provides.hooks.includes(registration.hook_point)) {
			throw new Error("registration mismatch");
		}
		tokens.add(registration.token);
		names.add(`${registration.kind}:${registration.name}`);
	}
	const actualTools = registrations
		.filter((registration) => registration.kind === "tool")
		.map((registration) => registration.name);
	const actualCommands = registrations
		.filter((registration) => registration.kind === "command")
		.map((registration) => registration.name);
	const actualHookPoints = registrations
		.filter((registration) => registration.kind === "hook")
		.map((registration) => registration.hook_point);
	if (!sameValues(actualTools, manifest.provides.tools)
		|| !sameValues(actualCommands, manifest.provides.commands)
		|| !sameSet(actualHookPoints, manifest.provides.hooks)) {
		throw new Error("registration mismatch");
	}
	return Object.freeze(registrations.map((registration) => Object.freeze({ ...registration })));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value) => right.includes(value));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function invocationResult(message: ResultMessage): PluginInvocationResult {
	if (!isRecord(message.value)
		|| !isResultType(message.value.result_type)
		|| !isRecord(message.value.value)) {
		throw new PluginHostError("protocol_invalid");
	}
	return Object.freeze({
		ok: true,
		resultType: message.value.result_type,
		value: Object.freeze({ ...message.value.value }),
	});
}

function workerEnvironment(
	manifest: LoadedPluginManifest,
	source: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
	const env: NodeJS.ProcessEnv = {};
	for (const key of MINIMAL_ENV_KEYS) {
		const value = environmentValue(source, key);
		if (value) env[key] = value;
	}
	for (const key of manifest.requires_env) {
		const value = environmentValue(source, key);
		if (!value) throw new PluginHostError("missing_required_env");
		env[key] = value;
	}
	return Object.freeze(env);
}

function environmentValue(source: Readonly<NodeJS.ProcessEnv>, key: string): string | undefined {
	const normalized = key.toLowerCase();
	for (const [name, value] of Object.entries(source)) {
		if (name.toLowerCase() === normalized) return value;
	}
	return undefined;
}

function defaultWorkerPath(): string {
	const extension = extname(fileURLToPath(import.meta.url));
	return fileURLToPath(new URL(extension === ".ts" ? "./worker-bootstrap.ts" : "./worker-bootstrap.js", import.meta.url));
}

function defaultWorkerExecArgv(): readonly string[] {
	return extname(fileURLToPath(import.meta.url)) === ".ts"
		? Object.freeze(["--import", import.meta.resolve("tsx")])
		: Object.freeze([]);
}

function hostErrorKind(value: string): PluginHostErrorKind {
	const supported = new Set<PluginHostErrorKind>([
		"handler_failed",
		"protocol_invalid",
		"registration_mismatch",
		"unknown_target",
	]);
	return supported.has(value as PluginHostErrorKind) ? value as PluginHostErrorKind : "plugin_error";
}

function positiveLimit(value: number | undefined, fallback: number, maximum: number): number {
	const selected = value ?? fallback;
	if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
		throw new RangeError("invalid_plugin_host_limit");
	}
	return selected;
}

function isResultType(value: unknown): value is PluginResultType {
	return value === "tool_result" || value === "hook_result" || value === "command_result";
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

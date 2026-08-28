import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";
import {
	DEFAULT_SHELL_MODEL_OUTPUT_MAX_TOKENS,
	formatShellResult,
} from "./shell-result.ts";
import {
	createShellEnvironment,
	type ShellEnvironmentResult,
} from "./shell-environment.ts";
import {
	executionPolicy,
	hasUnrestrictedFilesystem,
} from "./execution-policy.ts";
import {
	prepareSandboxedProcess,
	ProcessSandboxError,
	type ProcessSandboxProbes,
	type SandboxedProcessLaunch,
} from "./process-sandbox.ts";
import type {
	ShellSessionSnapshot,
	ShellStartRequest,
} from "./shell-session-manager.ts";
import {
	SHELL_DESCRIPTION_MAX_CHARS,
	SHELL_TOOL_DEFINITION,
} from "./shell-manifest.ts";
import { parseShellSandboxPermissions } from "./shell-sandbox-permissions.ts";
import {
	resolveShellProfile,
	type ShellProfile,
} from "./shell-profile.ts";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "./types.ts";

const DEFAULT_YIELD_TIME_MS = 10_000;
const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_ROWS = 24;
const DEFAULT_COLUMNS = 80;

export interface ShellStartManager {
	start(request: ShellStartRequest): Promise<ShellSessionSnapshot>;
}

export interface ShellToolOptions {
	readonly workspaceRoot: string;
	readonly manager: ShellStartManager;
	readonly profile?: ShellProfile;
	readonly platform?: NodeJS.Platform;
	readonly env?: Readonly<NodeJS.ProcessEnv>;
	readonly shellPath?: string;
	readonly timeoutSeconds?: number;
	readonly maxOutputTokens?: number;
	readonly rows?: number;
	readonly columns?: number;
	readonly createChunkId?: () => string;
	readonly processSandboxProbes?: ProcessSandboxProbes;
}

interface ShellInvocation {
	readonly command: string;
	readonly description?: string;
	readonly cwd?: unknown;
	readonly tty: boolean;
	readonly yieldTimeMs: number;
	readonly maxOutputTokens: number;
	readonly timeoutSeconds: number;
	readonly background?: boolean;
}

export class ShellTool implements ToolAdapter {
	readonly definition = SHELL_TOOL_DEFINITION;
	readonly supportsParallelToolCalls = true;
	readonly #workspaceRoot: string;
	readonly #manager: ShellStartManager;
	readonly #profile: ShellProfile;
	readonly #platform: NodeJS.Platform;
	readonly #env: Readonly<NodeJS.ProcessEnv>;
	readonly #timeoutSeconds: number;
	readonly #maxOutputTokens: number;
	readonly #rows: number;
	readonly #columns: number;
	readonly #createChunkId: () => string;
	readonly #processSandboxProbes: ProcessSandboxProbes;

	constructor(options: ShellToolOptions) {
		if (!options.workspaceRoot.trim()) throw new TypeError("workspaceRoot must be non-empty");
		this.#workspaceRoot = options.workspaceRoot;
		this.#manager = options.manager;
		this.#platform = options.platform ?? process.platform;
		this.#env = Object.freeze({ ...(options.env ?? process.env) });
		this.#profile = options.profile ?? resolveShellProfile({
			platform: this.#platform,
			env: this.#env,
			...(options.shellPath ? { shellPath: options.shellPath } : {}),
		});
		this.#timeoutSeconds = positiveFinite(
			options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
			"timeoutSeconds",
		);
		this.#maxOutputTokens = positiveInteger(
			options.maxOutputTokens ?? DEFAULT_SHELL_MODEL_OUTPUT_MAX_TOKENS,
			"maxOutputTokens",
		);
		this.#rows = positiveInteger(options.rows ?? DEFAULT_ROWS, "rows");
		this.#columns = positiveInteger(options.columns ?? DEFAULT_COLUMNS, "columns");
		this.#createChunkId = options.createChunkId ?? defaultChunkId;
		this.#processSandboxProbes = Object.freeze({ ...options.processSandboxProbes });
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		const command = stringValue(argumentsValue.command);
		if (!command) return shellFailure("invalid_arguments", "Shell command is required.");
		if (!validOptionalDescription(argumentsValue.description)) {
			return shellFailure(
				"invalid_arguments",
				`Shell description must be a non-empty string of at most ${SHELL_DESCRIPTION_MAX_CHARS} characters.`,
			);
		}
		const sandboxPermissions = parseShellSandboxPermissions(argumentsValue.sandbox_permissions);
		if (!sandboxPermissions) {
			return shellFailure(
				"invalid_sandbox_permissions",
				"Shell sandbox permissions are invalid.",
			);
		}
		if (sandboxPermissions === "require_escalated"
			&& !hasUnrestrictedFilesystem(options.executionPolicy)
			&& options.sandboxOverrideApproved !== true) {
			return shellFailure(
				"sandbox_override_not_approved",
				"Shell sandbox override was not approved by the runtime.",
			);
		}
		const tty = argumentsValue.tty ?? false;
		if (typeof tty !== "boolean") {
			return shellFailure("invalid_tty", "Shell tty must be a boolean.");
		}
		const yieldValue = argumentsValue.yield_time_ms ?? DEFAULT_YIELD_TIME_MS;
		if (!isPositiveInteger(yieldValue)) {
			return shellFailure("invalid_yield_time", "Shell yield time must be a positive integer.");
		}
		const outputBudget = boundedOutputBudget(
			argumentsValue.max_output_tokens,
			this.#maxOutputTokens,
		);
		if (outputBudget === undefined) {
			return shellFailure(
				"invalid_output_budget",
				"Shell output budget must be a positive integer.",
			);
		}
		return this.#invoke({
			command,
			...(typeof argumentsValue.description === "string"
				? { description: argumentsValue.description.trim() }
				: {}),
			cwd: argumentsValue.cwd,
			tty,
			yieldTimeMs: clamp(yieldValue, MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS),
			maxOutputTokens: outputBudget,
			timeoutSeconds: this.#timeoutSeconds,
		}, options, sandboxPermissions === "require_escalated");
	}

	async executeLegacy(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		const command = legacyCommand(argumentsValue);
		if (!command) return shellFailure("invalid_arguments", "Bash command is required.");
		const background = argumentsValue.run_in_background ?? false;
		if (typeof background !== "boolean") {
			return shellFailure("invalid_background", "Bash background flag must be a boolean.");
		}
		const timeout = argumentsValue.timeout ?? this.#timeoutSeconds;
		if (!isPositiveNumber(timeout)) {
			return shellFailure("invalid_timeout", "Bash timeout must be a positive number.");
		}
		return this.#invoke({
			command,
			cwd: argumentsValue.cwd,
			tty: false,
			yieldTimeMs: background ? 0 : DEFAULT_YIELD_TIME_MS,
			maxOutputTokens: this.#maxOutputTokens,
			timeoutSeconds: timeout,
			background,
		}, options);
	}

	async #invoke(
		invocation: ShellInvocation,
		options: ToolExecutionOptions,
		requireEscalated = false,
	): Promise<ToolAdapterResult> {
		if (!options.executionPolicy) {
			return shellFailure("sandbox_unavailable", "Shell execution policy is unavailable.");
		}
		const effectivePolicy = requireEscalated
			? options.sandboxOverridePolicy ?? executionPolicy("full-access", this.#workspaceRoot)
			: options.executionPolicy;
		const cwd = await resolveShellCwd(
			this.#workspaceRoot,
			invocation.cwd,
			hasUnrestrictedFilesystem(effectivePolicy),
		);
		if (typeof cwd !== "string") return cwd;
		let launch: SandboxedProcessLaunch;
		let environment: ShellEnvironmentResult;
		try {
			environment = createShellEnvironment({
				cwd,
				sourceEnv: this.#env,
				platform: this.#platform,
			});
			launch = prepareSandboxedProcess([
				this.#profile.executable,
				...this.#profile.execArgv(invocation.command),
			], {
				...effectivePolicy,
				workspaceRoot: this.#workspaceRoot,
				cwd,
			}, {
				...this.#processSandboxProbes,
				platform: this.#platform,
			});
		} catch (error: unknown) {
			if (error instanceof ProcessSandboxError) {
				return shellFailure(error.kind, "Required process sandbox is unavailable.");
			}
			return shellFailure("sandbox_unavailable", "Shell execution policy could not be applied.");
		}
		const request: ShellStartRequest = {
			ownerSessionId: options.ownerSessionId,
			callId: options.callId,
			command: invocation.command,
			...(invocation.description ? { description: invocation.description } : {}),
			executable: launch.executable,
			args: launch.args,
			cwd,
			env: environment.env,
			platform: this.#platform,
			tty: invocation.tty,
			rows: this.#rows,
			columns: this.#columns,
			...(invocation.background === undefined ? {} : { background: invocation.background }),
			yieldTimeMs: invocation.yieldTimeMs,
			timeoutSeconds: invocation.timeoutSeconds,
			publishLifecycle: options.publishLifecycle,
			signal: options.signal,
			shellKind: this.#profile.kind,
		};
		const snapshot = await this.#manager.start(request);
		return formatShellSnapshotResult(
			snapshot,
			invocation.maxOutputTokens,
			this.#createChunkId,
		);
	}
}

export function formatShellSnapshotResult(
	snapshot: ShellSessionSnapshot,
	maxOutputTokens: number,
	createChunkId: () => string = defaultChunkId,
): ToolAdapterResult {
	if (!snapshot.success || !snapshot.shellId) {
		return shellFailure(
			snapshot.errorKind ?? "shell_failed",
			snapshot.error ?? "Shell operation failed.",
		);
	}
	const formatted = formatShellResult({
		chunkId: createChunkId(),
		wallTimeSeconds: snapshot.wallTimeSeconds,
		shellId: snapshot.shellId,
		terminalState: snapshot.terminalState,
		exitCode: snapshot.exitCode,
		output: snapshot.output,
		maxOutputTokens,
	});
	const running = snapshot.terminalState === undefined;
	const success = running
		|| (snapshot.terminalState === "completed" && snapshot.exitCode === 0);
	const errorKind = success ? undefined : terminalErrorKind(snapshot);
	return {
		success,
		modelOutput: formatted.modelOutput,
		summary: running
			? `Shell ${snapshot.shellId} is running`
			: success
				? "Shell completed"
				: "Shell failed",
		...(errorKind ? { errorKind } : {}),
		metadata: Object.freeze({
			shell_id: snapshot.shellId,
			process_state: snapshot.processState,
			terminal_state: snapshot.terminalState ?? null,
			exit_code: snapshot.exitCode ?? null,
			yielded: snapshot.yielded,
			tty: snapshot.tty,
			transport: snapshot.transport ?? null,
			output_chars: snapshot.outputChars,
			omitted_output_chars: snapshot.omittedOutputChars + formatted.omittedChars,
			original_output_tokens: formatted.originalTokenCount,
		}),
	};
}

export function shellFailure(errorKind: string, message: string): ToolAdapterResult {
	const kind = errorKind.slice(0, 128) || "shell_failed";
	const boundedMessage = message.slice(0, 512) || "Shell operation failed.";
	return {
		success: false,
		modelOutput: `Shell failed\nError kind: ${kind}\nError: ${boundedMessage}`,
		summary: "Shell failed",
		errorKind: kind,
		metadata: {},
	};
}

export function boundedOutputBudget(
	value: unknown,
	maximum = DEFAULT_SHELL_MODEL_OUTPUT_MAX_TOKENS,
): number | undefined {
	const candidate = value ?? DEFAULT_SHELL_MODEL_OUTPUT_MAX_TOKENS;
	return isPositiveInteger(candidate) ? Math.min(candidate, maximum) : undefined;
}

export function defaultChunkId(): string {
	return randomBytes(4).toString("hex");
}

async function resolveShellCwd(
	workspaceRoot: string,
	rawCwd: unknown,
	allowOutsideWorkspace: boolean,
): Promise<string | ToolAdapterResult> {
	if (rawCwd !== undefined && rawCwd !== "" && typeof rawCwd !== "string") {
		return shellFailure("invalid_cwd", "Shell cwd must be a workspace directory.");
	}
	try {
		const unresolvedRoot = resolve(workspaceRoot);
		const candidate = typeof rawCwd === "string" && rawCwd
			? isAbsolute(rawCwd) ? resolve(rawCwd) : resolve(unresolvedRoot, rawCwd)
			: unresolvedRoot;
		if (!allowOutsideWorkspace && isOutside(unresolvedRoot, candidate)) {
			return shellFailure("workspace_escape", "Shell cwd must stay within the workspace.");
		}
		const [root, cwd] = await Promise.all([realpath(unresolvedRoot), realpath(candidate)]);
		if (!allowOutsideWorkspace && isOutside(root, cwd)) {
			return shellFailure("workspace_escape", "Shell cwd must stay within the workspace.");
		}
		if (!(await stat(cwd)).isDirectory()) {
			return shellFailure("not_directory", "Shell cwd must be a directory.");
		}
		return cwd;
	} catch (error: unknown) {
		return shellFailure(pathErrorKind(error), "Shell cwd is unavailable.");
	}
}

function legacyCommand(argumentsValue: Readonly<Record<string, unknown>>): string | undefined {
	const command = stringValue(argumentsValue.command);
	if (command) return command;
	if (!Array.isArray(argumentsValue.args)) return undefined;
	const args = argumentsValue.args;
	if (args.length === 0 || args.some((value) => typeof value !== "string")) return undefined;
	return args.map((value) => quotePosix(value as string)).join(" ");
}

function quotePosix(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function terminalErrorKind(snapshot: ShellSessionSnapshot): string {
	if (snapshot.terminalState === "interrupted") return "interrupted";
	if (snapshot.terminalState === "timed_out") return "timeout";
	if (snapshot.terminalState === "killed") return "killed";
	return "nonzero_exit";
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function validOptionalDescription(value: unknown): boolean {
	return value === undefined
		|| (typeof value === "string"
			&& Boolean(value.trim())
			&& Array.from(value).length <= SHELL_DESCRIPTION_MAX_CHARS);
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function positiveInteger(value: number, name: string): number {
	if (!isPositiveInteger(value)) throw new RangeError(`${name} must be a positive safe integer`);
	return value;
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveFinite(value: number, name: string): number {
	if (!isPositiveNumber(value)) throw new RangeError(`${name} must be a positive finite number`);
	return value;
}

function isOutside(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

function pathErrorKind(error: unknown): string {
	if (hasCode(error, "ENOENT")) return "not_found";
	if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) return "permission_denied";
	return "invalid_cwd";
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

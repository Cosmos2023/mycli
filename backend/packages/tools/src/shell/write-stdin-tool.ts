import { projectTerminalInteraction, terminalInteractionFromArguments } from "@mycli/contracts";
import type {
	ShellInteractionRequest,
	ShellSessionSnapshot,
} from "./shell-session-manager.ts";
import { WRITE_STDIN_TOOL_DEFINITION } from "./shell-manifest.ts";
import { SHELL_MODEL_OUTPUT_MAX_TOKENS } from "./shell-result.ts";
import {
	boundedOutputBudget,
	defaultChunkId,
	formatShellSnapshotResult,
	shellFailure,
} from "./shell-tool.ts";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "../types.ts";

const MIN_INPUT_WAIT_MS = 250;
const MAX_INPUT_WAIT_MS = 30_000;
const MIN_POLL_WAIT_MS = 5_000;
const MAX_POLL_WAIT_MS = 300_000;
export interface ShellInteractionManager {
	interact(request: ShellInteractionRequest): Promise<ShellSessionSnapshot>;
}

export interface WriteStdinToolOptions {
	readonly manager: ShellInteractionManager;
	readonly maxOutputTokens?: number;
	readonly createChunkId?: () => string;
}

export class WriteStdinTool implements ToolAdapter {
	readonly definition = WRITE_STDIN_TOOL_DEFINITION;
	readonly #manager: ShellInteractionManager;
	readonly #maxOutputTokens: number;
	readonly #createChunkId: () => string;

	constructor(options: WriteStdinToolOptions) {
		this.#manager = options.manager;
		this.#maxOutputTokens = options.maxOutputTokens ?? SHELL_MODEL_OUTPUT_MAX_TOKENS;
		if (!Number.isSafeInteger(this.#maxOutputTokens) || this.#maxOutputTokens <= 0) {
			throw new RangeError("maxOutputTokens must be a positive safe integer");
		}
		this.#createChunkId = options.createChunkId ?? defaultChunkId;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		const shellId = shellIdFrom(argumentsValue);
		if (!shellId) return shellFailure("missing_shell_id", "WriteStdin requires session_id.");
		const chars = argumentsValue.chars ?? "";
		if (typeof chars !== "string") {
			return shellFailure("invalid_chars", "WriteStdin chars must be a string.");
		}
		const requestedWait = argumentsValue.yield_time_ms
			?? (chars ? MIN_INPUT_WAIT_MS : MIN_POLL_WAIT_MS);
		if (!isPositiveInteger(requestedWait)) {
			return shellFailure(
				"invalid_yield_time",
				"WriteStdin yield time must be a positive integer.",
			);
		}
		const outputBudget = boundedOutputBudget(
			argumentsValue.max_output_tokens,
			this.#maxOutputTokens,
		);
		if (outputBudget === undefined) {
			return shellFailure(
				"invalid_output_budget",
				"WriteStdin output budget must be a positive integer.",
			);
		}
		const snapshot = await this.#manager.interact({
			ownerSessionId: options.ownerSessionId,
			shellId,
			chars,
			yieldTimeMs: chars
				? clamp(requestedWait, MIN_INPUT_WAIT_MS, MAX_INPUT_WAIT_MS)
				: clamp(requestedWait, MIN_POLL_WAIT_MS, MAX_POLL_WAIT_MS),
			signal: options.signal,
		});
		const result = formatShellSnapshotResult(snapshot, outputBudget, this.#createChunkId);
		const interaction = projectTerminalInteraction({
			...terminalInteractionFromArguments(this.definition.name, { session_id: shellId, chars }),
			command_preview: snapshot.commandPreview,
			interaction_succeeded: snapshot.success,
			...(snapshot.success ? { process_running: snapshot.terminalState === undefined } : {}),
		});
		return interaction ? { ...result, metadata: { ...result.metadata, terminal_interaction: interaction } } : result;
	}
}

export function shellIdFrom(
	argumentsValue: Readonly<Record<string, unknown>>,
): string | undefined {
	for (const key of ["session_id", "shell_id", "bash_id"] as const) {
		const value = argumentsValue[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

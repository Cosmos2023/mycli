import {
	BASH_OUTPUT_TOOL_DEFINITION,
	BASH_TOOL_DEFINITION,
	KILL_SHELL_TOOL_DEFINITION,
	SHELL_OUTPUT_TOOL_DEFINITION,
} from "./shell-manifest.ts";
import type {
	ShellSessionSnapshot,
} from "./shell-session-manager.ts";
import {
	defaultChunkId,
	formatShellSnapshotResult,
	shellFailure,
	type ShellTool,
} from "./shell-tool.ts";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "./types.ts";
import {
	shellIdFrom,
	type ShellInteractionManager,
} from "./write-stdin-tool.ts";

const LEGACY_OUTPUT_TOKENS = 10_000;

export interface BashToolOptions {
	readonly shell: ShellTool;
}

export class BashTool implements ToolAdapter {
	readonly definition = BASH_TOOL_DEFINITION;
	readonly #shell: ShellTool;

	constructor(options: BashToolOptions) {
		this.#shell = options.shell;
	}

	execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		return this.#shell.executeLegacy(argumentsValue, options);
	}
}

interface LegacyOutputManager extends ShellInteractionManager {
	terminate(ownerSessionId: string, shellId: string): Promise<ShellSessionSnapshot>;
}

interface LegacyOutputToolOptions {
	readonly manager: ShellInteractionManager;
	readonly createChunkId?: () => string;
}

abstract class LegacyOutputTool implements ToolAdapter {
	abstract readonly definition: ToolAdapter["definition"];
	readonly #manager: ShellInteractionManager;
	readonly #createChunkId: () => string;

	constructor(options: LegacyOutputToolOptions) {
		this.#manager = options.manager;
		this.#createChunkId = options.createChunkId ?? defaultChunkId;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		const shellId = shellIdFrom(argumentsValue);
		if (!shellId) return shellFailure("missing_shell_id", "Shell output requires shell_id.");
		const snapshot = await this.#manager.interact({
			ownerSessionId: options.ownerSessionId,
			shellId,
			chars: "",
			yieldTimeMs: 0,
			signal: options.signal,
		});
		return formatShellSnapshotResult(snapshot, LEGACY_OUTPUT_TOKENS, this.#createChunkId);
	}
}

export class ShellOutputTool extends LegacyOutputTool {
	readonly definition = SHELL_OUTPUT_TOOL_DEFINITION;
}

export class BashOutputTool extends LegacyOutputTool {
	readonly definition = BASH_OUTPUT_TOOL_DEFINITION;
}

export interface KillShellToolOptions {
	readonly manager: LegacyOutputManager;
	readonly createChunkId?: () => string;
}

export class KillShellTool implements ToolAdapter {
	readonly definition = KILL_SHELL_TOOL_DEFINITION;
	readonly #manager: LegacyOutputManager;
	readonly #createChunkId: () => string;

	constructor(options: KillShellToolOptions) {
		this.#manager = options.manager;
		this.#createChunkId = options.createChunkId ?? defaultChunkId;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		const shellId = shellIdFrom(argumentsValue);
		if (!shellId) return shellFailure("missing_shell_id", "KillShell requires shell_id.");
		const snapshot = await this.#manager.terminate(options.ownerSessionId, shellId);
		const formatted = formatShellSnapshotResult(
			snapshot,
			LEGACY_OUTPUT_TOKENS,
			this.#createChunkId,
		);
		if (!snapshot.success) return formatted;
		return {
			success: true,
			modelOutput: formatted.modelOutput,
			summary: `Killed shell ${shellId}`,
			metadata: formatted.metadata,
		};
	}
}

import { randomUUID } from "node:crypto";
import type { ShellLifecycleEvent } from "@mycli/core";
import type { SessionGenerationContext } from "@mycli/runtime";
import {
	sanitizeShellSnapshotPayload,
	SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS,
	type LoadShellOutputPageInput,
	type ShellOutputPage,
} from "@mycli/storage";
import type { ShellSessionSnapshot } from "@mycli/tools";
import { GatewayFailure } from "./node-gateway-errors.ts";
import { requiredBoundedString as requiredString } from "./node-gateway-validation.ts";
import { GATEWAY_SHELL_OUTPUT_MAX_CHARS } from "./node-gateway-shell-output.ts";

type JsonObject = Record<string, unknown>;

interface NodeGatewayShellManager {
	list(ownerSessionId: string): readonly ShellSessionSnapshot[];
	terminate(ownerSessionId: string, shellId: string): Promise<ShellSessionSnapshot>;
	terminateOwner(ownerSessionId: string): Promise<readonly ShellSessionSnapshot[]>;
}

interface NodeGatewayShellLifecycle {
	subscribe(listener: (event: ShellLifecycleEvent) => void): () => void;
}

interface NodeGatewayShellControllerOptions {
	readonly manager?: NodeGatewayShellManager;
	readonly lifecycle?: NodeGatewayShellLifecycle;
	readonly loadOutput?: (input: LoadShellOutputPageInput) => ShellOutputPage;
	readonly context: () => SessionGenerationContext;
	readonly isClosed: () => boolean;
	readonly publish: (method: ShellLifecycleEvent["kind"], params: JsonObject) => void;
}

export class NodeGatewayShellController {
	readonly #options: NodeGatewayShellControllerOptions;
	#unsubscribe: (() => void) | null = null;

	constructor(options: NodeGatewayShellControllerOptions) {
		this.#options = options;
		this.#unsubscribe = options.lifecycle?.subscribe((event) => {
			if (options.isClosed()) return;
			const context = options.context();
			if (event.ownerSessionId !== context.sessionId) return;
			options.publish(event.kind, shellLifecyclePayload(event, context.generation));
		}) ?? null;
	}

	close(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}

	activeSnapshots(): readonly ShellSessionSnapshot[] {
		const ownerSessionId = this.#options.context().sessionId;
		return this.#options.manager?.list(ownerSessionId).filter((snapshot) =>
			snapshot.ownerSessionId === ownerSessionId
				&& snapshot.background
				&& snapshot.status === "running"
				&& snapshot.processState === "running_background") ?? [];
	}

	activePayloads(): readonly JsonObject[] {
		const context = this.#options.context();
		return this.activeSnapshots().map((snapshot) => shellSnapshotPayload(snapshot, context));
	}

	list(): JsonObject {
		const context = this.#options.context();
		return {
			session_id: context.sessionId,
			generation: context.generation,
			shells: this.activeSnapshots().map((snapshot) => shellSnapshotPayload(snapshot, context)),
		};
	}

	output(params: JsonObject): JsonObject {
		const load = this.#options.loadOutput;
		if (!load) {
			throw new GatewayFailure("unavailable_feature", "Full Shell transcript output is unavailable.");
		}
		const sessionId = optionalString(params.session_id) ?? this.#options.context().sessionId;
		const callId = optionalString(params.call_id);
		const page = load({
			sessionId,
			shellId: requiredString(params.shell_id, "shell_id"),
			...(callId ? { callId } : {}),
			...(params.after_sequence === undefined ? {} : {
				afterSequence: optionalNonNegativeInteger(params.after_sequence, "after_sequence"),
			}),
			...(params.limit_chars === undefined ? {} : {
				limitChars: positiveIntegerParameter(params.limit_chars, "limit_chars"),
			}),
		});
		return shellOutputPagePayload(page);
	}

	async stop(params: JsonObject): Promise<JsonObject> {
		const context = this.#options.context();
		const snapshot = await this.#requiredManager().terminate(
			context.sessionId,
			requiredString(params.shell_id, "shell_id"),
		);
		return shellSnapshotPayload(snapshot, context);
	}

	async stopAll(): Promise<JsonObject> {
		const context = this.#options.context();
		const snapshots = await this.#requiredManager().terminateOwner(context.sessionId);
		return {
			session_id: context.sessionId,
			generation: context.generation,
			stopped: snapshots.length,
			shells: snapshots.map((snapshot) => shellSnapshotPayload(snapshot, context)),
		};
	}

	psCommandResult(): JsonObject {
		return shellPsCommandResult(this.activePayloads());
	}

	async stopAllCommandResult(): Promise<JsonObject> {
		return shellStopCommandResult(await this.stopAll());
	}

	#requiredManager(): NodeGatewayShellManager {
		const manager = this.#options.manager;
		if (!manager) throw new GatewayFailure("method_not_found", "Shell operations are unavailable.");
		return manager;
	}
}

function shellPsCommandResult(processes: readonly JsonObject[]): JsonObject {
	const lines = processes.length === 0
		? ["no background shells"]
		: processes.map((process) => [
			String(process.shell_id ?? "shell"),
			String(process.process_state ?? "running"),
			String(process.command_preview ?? "[redacted command]"),
		].join(" "));
	return {
		result_id: `command:${randomUUID().replaceAll("-", "")}`,
		presentation: "transcript",
		command_kind: "background_shells",
		processes,
		lines,
		display: shellCommandDisplay({
			kind: "list",
			command: "/ps",
			title: "Background terminals",
			severity: "info",
			rows: processes.map((process) => ({
				key: String(process.shell_id ?? "shell"),
				label: `shell ${String(process.shell_id ?? "unknown")}`,
				values: [String(process.command_preview ?? "[redacted command]")],
				status: String(process.process_state ?? "running"),
			})),
			totalRows: processes.length,
		}),
	};
}

function shellStopCommandResult(stopped: JsonObject): JsonObject {
	return {
		result_id: `command:${randomUUID().replaceAll("-", "")}`,
		presentation: "none",
		command_kind: "shell_stop",
		lines: ["Stopping all background terminals."],
		stopped: stopped.stopped ?? 0,
		display: shellCommandDisplay({
			kind: "notice",
			command: "/ps stop-all",
			title: "Background terminals",
			severity: "success",
			summary: "Stopping all background terminals.",
		}),
	};
}

function shellCommandDisplay(input: {
	readonly kind: "list" | "notice";
	readonly command: string;
	readonly title: string;
	readonly severity: "info" | "success";
	readonly summary?: string;
	readonly rows?: readonly JsonObject[];
	readonly totalRows?: number;
}): JsonObject {
	return {
		version: 1,
		kind: input.kind,
		command: input.command,
		title: input.title,
		severity: input.severity,
		...(input.summary ? { summary: input.summary } : {}),
		fields: [],
		rows: input.rows ?? [],
		sections: [],
		suggestions: [],
		...(input.totalRows === undefined ? {} : { total_rows: input.totalRows }),
		omitted_rows: 0,
		omitted_chars: 0,
	};
}

function shellSnapshotPayload(
	snapshot: ShellSessionSnapshot,
	context: SessionGenerationContext,
): JsonObject {
	const metadata = sanitizeShellSnapshotPayload({
		...(snapshot.commandPreview ? { command_preview: snapshot.commandPreview } : {}),
		process_state: snapshot.processState,
		...(snapshot.terminalState ? { terminal_state: snapshot.terminalState } : {}),
		...(snapshot.transport ? { transport: snapshot.transport } : {}),
		...(snapshot.cleanupResult ? { cleanup_result: snapshot.cleanupResult } : {}),
		...(snapshot.startedAt ? { started_at: snapshot.startedAt } : {}),
		...(snapshot.completedAt ? { completed_at: snapshot.completedAt } : {}),
		...(snapshot.shellKind ? { shell_kind: snapshot.shellKind } : {}),
		...(snapshot.shellEdition ? { shell_edition: snapshot.shellEdition } : {}),
	}, snapshot.shellId);
	const discardedOutputChars = Math.max(
		0,
		snapshot.output.length - SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS,
	);
	const output = discardedOutputChars > 0
		? snapshot.output.slice(-SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS)
		: snapshot.output;
	return {
		shell_id: snapshot.shellId,
		session_id: context.sessionId,
		generation: context.generation,
		...(snapshot.callId ? { call_id: snapshot.callId } : {}),
		...(metadata.command_preview ? { command_preview: metadata.command_preview } : {}),
		...(snapshot.description ? { description: snapshot.description } : {}),
		background: snapshot.background,
		status: snapshot.status,
		process_state: metadata.process_state ?? snapshot.processState,
		...(metadata.terminal_state ? { terminal_state: metadata.terminal_state } : {}),
		...(snapshot.exitCode === undefined ? {} : { exit_code: snapshot.exitCode }),
		output,
		next_cursor: snapshot.nextCursor,
		output_chars: snapshot.outputChars,
		omitted_output_chars: snapshot.omittedOutputChars + discardedOutputChars,
		...(metadata.transport ? { transport: metadata.transport } : {}),
		tty: snapshot.tty,
		yielded: snapshot.yielded,
		...(metadata.cleanup_result ? { cleanup_result: metadata.cleanup_result } : {}),
		...(metadata.started_at ? { started_at: metadata.started_at } : {}),
		...(metadata.completed_at ? { completed_at: metadata.completed_at } : {}),
		...(metadata.shell_kind ? { shell_kind: metadata.shell_kind } : {}),
		...(metadata.shell_edition ? { shell_edition: metadata.shell_edition } : {}),
		...(snapshot.errorKind ? { error_kind: snapshot.errorKind } : {}),
		...(snapshot.error ? { error: snapshot.error.slice(0, 512) } : {}),
	};
}

function shellLifecyclePayload(
	event: ShellLifecycleEvent,
	generation: number,
): JsonObject {
	const metadata = sanitizeShellSnapshotPayload({
		command_preview: event.commandPreview,
		process_state: event.processState,
		...(event.terminalState ? { terminal_state: event.terminalState } : {}),
		...(event.transport ? { transport: event.transport } : {}),
		...(event.cleanupResult ? { cleanup_result: event.cleanupResult } : {}),
		...(event.startedAt ? { started_at: event.startedAt } : {}),
		...(event.completedAt ? { completed_at: event.completedAt } : {}),
		...(event.shellKind ? { shell_kind: event.shellKind } : {}),
		...(event.shellEdition ? { shell_edition: event.shellEdition } : {}),
	}, event.shellId);
	const outputDelta = event.outputDelta === undefined
		? undefined
		: event.outputDelta.slice(-GATEWAY_SHELL_OUTPUT_MAX_CHARS);
	const discardedOutputChars = event.outputDelta === undefined
		? 0
		: Math.max(0, event.outputDelta.length - (outputDelta?.length ?? 0));
	return {
		shell_id: event.shellId,
		session_id: event.ownerSessionId,
		generation,
		call_id: event.callId,
		sequence: event.sequence,
		command_preview: metadata.command_preview ?? "[redacted command]",
		...(event.description ? { description: event.description } : {}),
		background: event.background,
		process_state: metadata.process_state ?? event.processState,
		...(metadata.transport ? { transport: metadata.transport } : {}),
		tty: event.tty,
		yielded: event.yielded,
		...(metadata.terminal_state ? { terminal_state: metadata.terminal_state } : {}),
		...(event.exitCode === undefined ? {} : { exit_code: event.exitCode }),
		...(outputDelta === undefined ? {} : { output_delta: outputDelta }),
		...(event.nextCursor === undefined ? {} : { next_cursor: event.nextCursor }),
		...(event.outputChars === undefined ? {} : { output_chars: event.outputChars }),
		...((event.omittedOutputChars ?? 0) + discardedOutputChars > 0
			? { omitted_output_chars: (event.omittedOutputChars ?? 0) + discardedOutputChars }
			: {}),
		...(metadata.cleanup_result ? { cleanup_result: metadata.cleanup_result } : {}),
		...(metadata.started_at ? { started_at: metadata.started_at } : {}),
		...(metadata.completed_at ? { completed_at: metadata.completed_at } : {}),
		...(event.activeBackgroundCount === undefined
			? {}
			: { active_background_count: event.activeBackgroundCount }),
		...(metadata.shell_kind ? { shell_kind: metadata.shell_kind } : {}),
		...(metadata.shell_edition ? { shell_edition: metadata.shell_edition } : {}),
	};
}

function shellOutputPagePayload(page: ShellOutputPage): JsonObject {
	return {
		session_id: page.sessionId,
		shell_id: page.shellId,
		...(page.callId ? { call_id: page.callId } : {}),
		chunks: page.chunks.map((chunk) => ({
			sequence: chunk.sequence,
			cursor_start: chunk.cursorStart,
			cursor_end: chunk.cursorEnd,
			omitted_before: chunk.omittedBefore,
			output: chunk.output,
		})),
		next_after_sequence: page.nextAfterSequence,
		available: page.available,
		complete: page.complete,
		omitted_chars: page.omittedChars,
		captured_chars: page.capturedChars,
		output_chars: page.outputChars,
	};
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function optionalNonNegativeInteger(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new GatewayFailure("invalid_params", `${name} must be a non-negative integer.`);
	}
	return value;
}

function positiveIntegerParameter(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new GatewayFailure("invalid_params", `${name} must be a positive integer.`);
	}
	return value;
}

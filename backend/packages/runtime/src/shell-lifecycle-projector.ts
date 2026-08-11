import type { ShellLifecycleEvent } from "@mycli/core";
import {
	sanitizeShellSnapshotPayload,
	SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS,
	type ShellTranscriptStore,
} from "@mycli/storage";

export interface ShellLifecycleProjectorOptions {
	readonly store: ShellTranscriptStore;
	readonly projectTaskOutput?: (input: ShellTaskOutputProjection) => void | Promise<void>;
	readonly onError?: (error: unknown) => void;
}

export interface ShellTaskOutputProjection {
	readonly sessionId: string;
	readonly taskId: string;
	readonly output: string;
}

interface ShellProjectionState {
	readonly sequence: number;
	readonly output: string;
	readonly omittedOutputChars: number;
	readonly nextCursor: number;
}

export class ShellLifecycleProjector {
	readonly #store: ShellTranscriptStore;
	readonly #onError: (error: unknown) => void;
	readonly #projectTaskOutput?: ShellLifecycleProjectorOptions["projectTaskOutput"];
	readonly #listeners = new Set<(event: ShellLifecycleEvent) => void>();
	readonly #state = new Map<string, ShellProjectionState>();
	#pending: Promise<void> = Promise.resolve();

	constructor(options: ShellLifecycleProjectorOptions) {
		this.#store = options.store;
		this.#projectTaskOutput = options.projectTaskOutput;
		this.#onError = options.onError ?? (() => undefined);
	}

	subscribe(listener: (event: ShellLifecycleEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}

	accept(event: ShellLifecycleEvent): Promise<void> {
		const operation = this.#pending.then(() => this.#accept(event));
		this.#pending = operation.catch((error: unknown) => { this.#onError(error); });
		return operation;
	}

	enqueue(event: ShellLifecycleEvent): void {
		void this.accept(event).catch(() => undefined);
	}

	drain(): Promise<void> {
		return this.#pending;
	}

	async #accept(event: ShellLifecycleEvent): Promise<void> {
		const key = `${event.ownerSessionId}\u0000${event.shellId}`;
		const previous = this.#state.get(key);
		if (previous && event.sequence <= previous.sequence) return;
		const appended = `${previous?.output ?? ""}${event.outputDelta ?? ""}`;
		const locallyOmitted = Math.max(0, appended.length - SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS);
		const output = locallyOmitted > 0
			? appended.slice(-SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS)
			: appended;
		const omittedOutputChars = Math.max(
			previous?.omittedOutputChars ?? 0,
			event.omittedOutputChars ?? 0,
		) + locallyOmitted;
		const callId = event.callId ?? event.shellId;
		const projectedEvent = sanitizedLifecycleEvent(event);
		const payload = shellSnapshotPayload(projectedEvent, output, omittedOutputChars);
		const nextCursor = event.nextCursor ?? (previous?.nextCursor ?? 0) + (event.outputDelta?.length ?? 0);
		const cursorStart = Math.max(0, nextCursor - (event.outputDelta?.length ?? 0));
		this.#store.upsertShellSnapshot({
			sessionId: event.ownerSessionId,
			callId,
			shellId: event.shellId,
			payload,
			...(event.outputDelta ? {
				outputChunk: {
					sequence: event.sequence,
					cursorStart,
					cursorEnd: nextCursor,
					omittedBefore: Math.max(0, cursorStart - (previous?.nextCursor ?? 0)),
					output: event.outputDelta,
				},
			} : {}),
		});
		this.#state.set(key, { sequence: event.sequence, output, omittedOutputChars, nextCursor });
		for (const listener of this.#listeners) listener(projectedEvent);
		if (event.background && event.kind === "shell.completed" && this.#projectTaskOutput) {
			try {
				await this.#projectTaskOutput({
					sessionId: event.ownerSessionId,
					taskId: event.shellId,
					output,
				});
			} catch (error) {
				this.#onError(error);
			}
		}
	}
}

function sanitizedLifecycleEvent(event: ShellLifecycleEvent): ShellLifecycleEvent {
	const payload = sanitizeShellSnapshotPayload({
		command_preview: event.commandPreview,
	}, event.shellId);
	const commandPreview = typeof payload.command_preview === "string"
		? payload.command_preview
		: "[redacted command]";
	return commandPreview === event.commandPreview
		? event
		: Object.freeze({ ...event, commandPreview });
}

function shellSnapshotPayload(
	event: ShellLifecycleEvent,
	output: string,
	omittedOutputChars: number,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		kind: event.kind,
		command_preview: event.commandPreview,
		background: event.background,
		process_state: event.processState,
		tty: event.tty,
		yielded: event.yielded,
		...(event.transport ? { transport: event.transport } : {}),
		...(event.terminalState ? { terminal_state: event.terminalState } : {}),
		...(event.exitCode === undefined ? {} : { exit_code: event.exitCode }),
		...(output ? { output } : {}),
		...(event.nextCursor === undefined ? {} : { next_cursor: event.nextCursor }),
		...(event.outputChars === undefined ? {} : { output_chars: event.outputChars }),
		...(omittedOutputChars > 0 ? { omitted_output_chars: omittedOutputChars } : {}),
		...(event.cleanupResult ? { cleanup_result: event.cleanupResult } : {}),
		...(event.startedAt ? { started_at: event.startedAt } : {}),
		...(event.completedAt ? { completed_at: event.completedAt } : {}),
		...(event.shellKind ? { shell_kind: event.shellKind } : {}),
		...(event.shellEdition ? { shell_edition: event.shellEdition } : {}),
	});
}

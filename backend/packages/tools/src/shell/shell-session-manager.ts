import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	SHELL_LIFECYCLE_OUTPUT_CHUNK_MAX_CHARS,
	type ShellLifecycleEvent,
	type ShellLifecycleKind,
} from "@mycli/core";
import { startPipeTransport } from "./pipe-transport.ts";
import { windowsConsoleFallbackEncoding } from "./console-encoding.ts";
import { ShellOutputBuffer } from "./shell-output-buffer.ts";
import {
	ShellTransportError,
	type ProcessCleanupResult,
	type ShellExit,
	type ShellOutputChunk,
	type ShellStream,
	type ShellTransport,
	type ShellTransportFactory,
	type ShellTransportStartRequest,
} from "./shell-transport.ts";
import { TerminalOutputNormalizer } from "./terminal-output-normalizer.ts";

const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_OUTPUT_MAX_CHARS = 1_048_576;
const DEFAULT_OUTPUT_EVENT_INTERVAL_MS = 50;
const DEFAULT_OUTPUT_EVENT_MAX_CHARS = 4_096;
const MAX_SHELL_ID_ATTEMPTS = 16;

interface ShellProcessResource {
	/** Idempotently revoke and close process-owned infrastructure. */
	close(): Promise<void>;
}

export interface ShellStartRequest extends ShellTransportStartRequest {
	readonly ownerSessionId: string;
	readonly ownerTurnId?: string;
	readonly callId: string;
	readonly command: string;
	readonly description?: string;
	readonly background?: boolean;
	readonly yieldTimeMs: number;
	readonly timeoutSeconds: number;
	readonly publishLifecycle: (event: ShellLifecycleEvent) => void;
	readonly signal?: AbortSignal;
	readonly shellKind?: string;
	readonly shellEdition?: string;
	readonly processResource?: ShellProcessResource;
}

export interface ShellInteractionRequest {
	readonly ownerSessionId: string;
	readonly shellId: string;
	readonly chars: string;
	readonly yieldTimeMs: number;
	readonly signal?: AbortSignal;
}

export interface ShellSessionSnapshot {
	readonly success: boolean;
	readonly shellId: string;
	readonly ownerSessionId: string;
	readonly callId?: string;
	readonly background: boolean;
	readonly status: "running" | "exited" | "error";
	readonly processState: string;
	readonly terminalState?: string;
	readonly exitCode?: number;
	readonly output: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly nextCursor: number;
	readonly outputChars: number;
	readonly newOutputChars: number;
	readonly omittedOutputChars: number;
	readonly stdoutChars: number;
	readonly stderrChars: number;
	readonly stdoutOmittedChars: number;
	readonly stderrOmittedChars: number;
	readonly cursorWasEvicted: boolean;
	readonly cleanupResult?: string;
	readonly transport?: ShellTransport["kind"];
	readonly tty: boolean;
	readonly yielded: boolean;
	readonly decodeReplacementCount: number;
	readonly commandPreview?: string;
	readonly description?: string;
	readonly startedAt?: string;
	readonly completedAt?: string;
	readonly wallTimeSeconds: number;
	readonly shellKind?: string;
	readonly shellEdition?: string;
	readonly errorKind?: string;
	readonly error?: string;
}

export interface ShellSessionManagerOptions {
	readonly maxSessions?: number;
	readonly outputMaxChars?: number;
	readonly outputEventIntervalMs?: number;
	readonly outputEventMaxChars?: number;
	readonly transportFactory?: ShellTransportFactory;
	readonly createShellId?: () => string;
}

interface SessionRecord {
	readonly processResource?: ShellProcessResource;
	readonly shellId: string;
	readonly ownerSessionId: string;
	readonly ownerTurnId?: string;
	readonly callId: string;
	readonly commandPreview: string;
	readonly description?: string;
	readonly transport: ShellTransport;
	readonly publishLifecycle: (event: ShellLifecycleEvent) => void;
	readonly output: ShellOutputBuffer;
	readonly stdout: ShellOutputBuffer;
	readonly stderr: ShellOutputBuffer;
	readonly normalizers: Record<ShellStream, TerminalOutputNormalizer>;
	readonly startedAt: string;
	readonly startedTimeMs: number;
	readonly timeoutSeconds: number;
	readonly shellKind?: string;
	readonly shellEdition?: string;
	readonly stateWaiters: Set<() => void>;
	readonly completion: Promise<void>;
	readonly resolveCompletion: () => void;
	background: boolean;
	yielded: boolean;
	modelCursor: number;
	lifecycleCursor: number;
	lifecycleOmittedChars: number;
	eventSequence: number;
	decodeReplacementCount: number;
	terminalState?: string;
	exitCode?: number;
	cleanupResult?: string;
	completedAt?: string;
	lastUsedTimeMs: number;
	outputEventTimer?: NodeJS.Timeout;
	timeoutTimer?: NodeJS.Timeout;
	interactionTail: Promise<void>;
	stopPromise?: Promise<ShellSessionSnapshot>;
	pendingExit?: ShellExit;
	unsubscribeOutput?: () => void;
	unsubscribeExit?: () => void;
	removeAbortListener?: () => void;
}

export class ShellSessionManager {
	readonly #maxSessions: number;
	readonly #outputMaxChars: number;
	readonly #outputEventIntervalMs: number;
	readonly #outputEventMaxChars: number;
	readonly #transportFactory: ShellTransportFactory;
	readonly #createShellId: () => string;
	readonly #sessions = new Map<string, SessionRecord>();
	readonly #reservedShellIds = new Set<string>();
	readonly #pendingStartWaiters = new Set<() => void>();
	#pendingStarts = 0;
	#closed = false;
	#closePromise?: Promise<readonly ShellSessionSnapshot[]>;

	constructor(options: ShellSessionManagerOptions = {}) {
		this.#maxSessions = positiveInteger(
			options.maxSessions ?? DEFAULT_MAX_SESSIONS,
			"maxSessions",
		);
		this.#outputMaxChars = nonNegativeInteger(
			options.outputMaxChars ?? DEFAULT_OUTPUT_MAX_CHARS,
			"outputMaxChars",
		);
		this.#outputEventIntervalMs = nonNegativeInteger(
			options.outputEventIntervalMs ?? DEFAULT_OUTPUT_EVENT_INTERVAL_MS,
			"outputEventIntervalMs",
		);
		this.#outputEventMaxChars = boundedPositiveInteger(
			options.outputEventMaxChars ?? DEFAULT_OUTPUT_EVENT_MAX_CHARS,
			"outputEventMaxChars",
			SHELL_LIFECYCLE_OUTPUT_CHUNK_MAX_CHARS,
		);
		this.#transportFactory = options.transportFactory ?? startPipeTransport;
		this.#createShellId = options.createShellId ?? (() => randomBytes(4).toString("hex"));
	}

	async start(request: ShellStartRequest): Promise<ShellSessionSnapshot> {
		let transferred = false;
		try {
			return await this.#start(request, () => { transferred = true; });
		} finally {
			if (!transferred) await request.processResource?.close();
		}
	}

	async #start(request: ShellStartRequest, transferResource: () => void): Promise<ShellSessionSnapshot> {
		validateStartRequest(request);
		if (this.#closed) {
			return errorSnapshot(request.ownerSessionId, "shell_cleanup_failed", "Shell manager is closed.");
		}
		const capacityError = await this.#reserveCapacity(request.ownerSessionId);
		if (capacityError !== undefined) return capacityError;
		if (this.#closed) {
			this.#releasePendingStart();
			return errorSnapshot(request.ownerSessionId, "shell_cleanup_failed", "Shell manager is closed.");
		}
		const shellId = this.#reserveShellId();
		if (shellId === undefined) {
			this.#releasePendingStart();
			return errorSnapshot(
				request.ownerSessionId,
				"shell_capacity_exceeded",
				"Unable to reserve a unique shell session ID.",
			);
		}

		let transport: ShellTransport;
		try {
			transport = await this.#transportFactory(transportRequest(request));
		} catch (error: unknown) {
			await request.processResource?.close();
			this.#releaseReservation(shellId);
			const errorKind = error instanceof ShellTransportError
				? error.kind
				: "shell_spawn_failed";
			return errorSnapshot(
				request.ownerSessionId,
				errorKind,
				error instanceof ShellTransportError
					? error.message
					: "Unable to start shell process.",
			);
		}
		if (this.#closed) {
			await request.processResource?.close();
			await transport.terminate().catch(() => undefined);
			await transport.close().catch(() => undefined);
			this.#releaseReservation(shellId);
			return errorSnapshot(request.ownerSessionId, "shell_cleanup_failed", "Shell manager is closed.");
		}
		this.#releaseReservation(shellId);

		const session = createSession(shellId, request, transport, this.#outputMaxChars);
		this.#sessions.set(shellId, session);
		transferResource();
		this.#publish(session, "shell.started");
		if (session.background) this.#publishListUpdate(session);
		session.unsubscribeOutput = transport.onOutput((chunk) => this.#acceptOutput(session, chunk));
		session.unsubscribeExit = transport.onExit((exit) => this.#acceptExit(session, exit));
		this.#startAbsoluteTimeout(session);
		this.#listenForAbort(session, request.signal);

		if (request.background === false) {
			await session.completion;
		} else if (request.background !== true) {
			const deadline = new AbortController();
			try {
				await Promise.race([session.completion, delay(request.yieldTimeMs, undefined, { signal: deadline.signal })]);
			} finally {
				deadline.abort();
			}
			if (session.terminalState === undefined) {
				session.background = true;
				session.yielded = true;
				this.#publishListUpdate(session);
			}
		}

		const snapshot = this.#snapshot(session, session.modelCursor);
		session.modelCursor = snapshot.nextCursor;
		return snapshot;
	}

	async interact(request: ShellInteractionRequest): Promise<ShellSessionSnapshot> {
		validateInteractionRequest(request);
		const owned = this.#ownedSession(request.ownerSessionId, request.shellId);
		if (owned instanceof ErrorSnapshotMarker) return owned.snapshot;
		return this.#serialize(owned, async () => {
			const cursor = owned.modelCursor;
			if (request.chars && owned.terminalState !== undefined) {
				return errorSnapshot(
					request.ownerSessionId,
					"shell_already_completed",
					"Shell session is already complete.",
					request.shellId,
				);
			}
			if (request.chars === "\u0003") {
				await this.#stop(owned, "interrupted", true);
			} else if (request.chars) {
				try {
					await owned.transport.write(request.chars);
				} catch (error: unknown) {
					return errorSnapshot(
						request.ownerSessionId,
						error instanceof ShellTransportError ? error.kind : "shell_write_failed",
						error instanceof ShellTransportError
							? error.message
							: "Unable to write to shell session.",
						request.shellId,
					);
				}
			}

			if (owned.terminalState === undefined && totalChars(owned.output) <= cursor) {
				await this.#waitForStateChange(owned, request.yieldTimeMs, request.signal);
			}
			const snapshot = this.#snapshot(owned, cursor);
			owned.modelCursor = snapshot.nextCursor;
			return snapshot;
		});
	}

	async resize(
		ownerSessionId: string,
		shellId: string,
		rows: number,
		columns: number,
	): Promise<ShellSessionSnapshot> {
		positiveInteger(rows, "rows");
		positiveInteger(columns, "columns");
		const owned = this.#ownedSession(ownerSessionId, shellId);
		if (owned instanceof ErrorSnapshotMarker) return owned.snapshot;
		return this.#serialize(owned, async () => {
			if (owned.terminalState !== undefined) {
				return errorSnapshot(
					ownerSessionId,
					"shell_already_completed",
					"Shell session is already complete.",
					shellId,
				);
			}
			try {
				await owned.transport.resize(rows, columns);
			} catch (error: unknown) {
				return errorSnapshot(
					ownerSessionId,
					error instanceof ShellTransportError ? error.kind : "shell_resize_failed",
					error instanceof ShellTransportError
						? error.message
						: "Unable to resize shell session.",
					shellId,
				);
			}
			return this.#snapshot(owned, owned.modelCursor);
		});
	}

	async terminate(ownerSessionId: string, shellId: string): Promise<ShellSessionSnapshot> {
		const owned = this.#ownedSession(ownerSessionId, shellId);
		if (owned instanceof ErrorSnapshotMarker) return owned.snapshot;
		return this.#queueStop(owned, "killed", false);
	}

	async terminateOwner(ownerSessionId: string): Promise<readonly ShellSessionSnapshot[]> {
		const sessions = [...this.#sessions.values()]
			.filter((session) => session.ownerSessionId === ownerSessionId
				&& session.terminalState === undefined);
		return Promise.all(sessions.map((session) => this.#queueStop(session, "killed", false)));
	}

	list(ownerSessionId: string): readonly ShellSessionSnapshot[] {
		return [...this.#sessions.values()]
			.filter((session) => session.ownerSessionId === ownerSessionId)
			.sort((left, right) => left.startedTimeMs - right.startedTimeMs)
			.map((session) => this.#snapshot(session, 0));
	}

	close(): Promise<readonly ShellSessionSnapshot[]> {
		this.#closePromise ??= this.#closeAll();
		return this.#closePromise;
	}

	async #closeAll(): Promise<readonly ShellSessionSnapshot[]> {
		this.#closed = true;
		await this.#waitForPendingStarts();
		const sessions = [...this.#sessions.values()];
		await Promise.all(sessions.map(async (session) => {
			if (session.terminalState === undefined) {
				await this.#queueStop(session, "killed", false);
			}
			await session.processResource?.close();
			await session.transport.close().catch(() => undefined);
		}));
		return sessions.map((session) => this.#snapshot(session, 0));
	}

	async #reserveCapacity(ownerSessionId: string): Promise<ShellSessionSnapshot | undefined> {
		if (this.#sessions.size + this.#pendingStarts < this.#maxSessions) {
			this.#pendingStarts += 1;
			return undefined;
		}
		const completed = [...this.#sessions.values()]
			.filter((session) => session.terminalState !== undefined)
			.sort((left, right) => left.lastUsedTimeMs - right.lastUsedTimeMs);
		const candidate = completed[0];
		if (candidate === undefined) {
			return errorSnapshot(
				ownerSessionId,
				"shell_capacity_exceeded",
				`Shell session capacity ${this.#maxSessions} is full.`,
			);
		}
		this.#sessions.delete(candidate.shellId);
		this.#publish(candidate, "shell.removed");
		this.#pendingStarts += 1;
		await candidate.processResource?.close();
		await candidate.transport.close().catch(() => undefined);
		return undefined;
	}

	#reserveShellId(): string | undefined {
		for (let attempt = 0; attempt < MAX_SHELL_ID_ATTEMPTS; attempt += 1) {
			const candidate = this.#createShellId();
			if (!/^[0-9a-f]{8}$/u.test(candidate)) continue;
			if (this.#sessions.has(candidate) || this.#reservedShellIds.has(candidate)) continue;
			this.#reservedShellIds.add(candidate);
			return candidate;
		}
		return undefined;
	}

	#releaseReservation(shellId: string): void {
		this.#reservedShellIds.delete(shellId);
		this.#releasePendingStart();
	}

	#releasePendingStart(): void {
		this.#pendingStarts -= 1;
		if (this.#pendingStarts !== 0) return;
		const waiters = [...this.#pendingStartWaiters];
		this.#pendingStartWaiters.clear();
		for (const waiter of waiters) waiter();
	}

	async #waitForPendingStarts(): Promise<void> {
		if (this.#pendingStarts === 0) return;
		await new Promise<void>((resolve) => this.#pendingStartWaiters.add(resolve));
	}

	#ownedSession(ownerSessionId: string, shellId: string): SessionRecord | ErrorSnapshotMarker {
		const session = this.#sessions.get(shellId);
		if (session === undefined) {
			return new ErrorSnapshotMarker(errorSnapshot(
				ownerSessionId,
				"shell_not_found",
				"No such shell session.",
				shellId,
			));
		}
		if (session.ownerSessionId !== ownerSessionId) {
			return new ErrorSnapshotMarker(errorSnapshot(
				ownerSessionId,
				"shell_session_forbidden",
				"Shell belongs to another session.",
				shellId,
			));
		}
		return session;
	}

	#acceptOutput(session: SessionRecord, chunk: ShellOutputChunk): void {
		if (session.terminalState !== undefined) return;
		const normalized = session.normalizers[chunk.stream].push(chunk.data);
		session.decodeReplacementCount += normalized.replacementCount;
		this.#appendNormalized(session, chunk.stream, normalized.text);
	}

	#acceptExit(session: SessionRecord, exit: ShellExit): void {
		if (session.terminalState !== undefined) return;
		session.pendingExit = exit;
		if (session.stopPromise === undefined) void this.#finishNatural(session, exit);
	}

	async #finishNatural(session: SessionRecord, exit: ShellExit): Promise<void> {
		await this.#finalize(
			session,
			exit.exitCode === 0 ? "completed" : "failed",
			exit,
			"already_exited",
		);
	}

	#appendNormalized(session: SessionRecord, stream: ShellStream, text: string): void {
		if (!text) return;
		if (stream === "stderr") session.stderr.append(text);
		else session.stdout.append(text);
		session.output.append(text);
		session.lastUsedTimeMs = Date.now();
		this.#notifyStateChange(session);
		this.#scheduleOutputEvent(session);
	}

	#flushNormalizers(session: SessionRecord): void {
		for (const stream of ["stdout", "stderr", "terminal"] as const) {
			const normalized = session.normalizers[stream].finish();
			session.decodeReplacementCount += normalized.replacementCount;
			this.#appendNormalized(session, stream, normalized.text);
		}
	}

	#scheduleOutputEvent(session: SessionRecord): void {
		if (session.outputEventTimer !== undefined || session.terminalState !== undefined) return;
		session.outputEventTimer = setTimeout(() => {
			session.outputEventTimer = undefined;
			this.#flushLifecycleOutput(session);
		}, this.#outputEventIntervalMs);
		session.outputEventTimer.unref();
	}

	#flushLifecycleOutput(session: SessionRecord): void {
		const chunk = session.output.read(session.lifecycleCursor);
		session.lifecycleCursor = chunk.nextCursor;
		session.lifecycleOmittedChars += chunk.omittedChars;
		if (!chunk.text) return;
		const retainedStartCursor = chunk.nextCursor - chunk.text.length;
		for (let offset = 0; offset < chunk.text.length; offset += this.#outputEventMaxChars) {
			const outputDelta = chunk.text.slice(offset, offset + this.#outputEventMaxChars);
			this.#publish(session, "shell.output", {
				outputDelta,
				nextCursor: retainedStartCursor + offset + outputDelta.length,
			});
		}
	}

	#startAbsoluteTimeout(session: SessionRecord): void {
		session.timeoutTimer = setTimeout(() => {
			void this.#queueStop(session, "timed_out", false);
		}, session.timeoutSeconds * 1_000);
		session.timeoutTimer.unref();
	}

	#listenForAbort(session: SessionRecord, signal: AbortSignal | undefined): void {
		if (signal === undefined) return;
		const onAbort = (): void => {
			if (!session.background && session.terminalState === undefined) {
				void this.#queueStop(session, "interrupted", false);
			}
		};
		if (signal.aborted) onAbort();
		else {
			signal.addEventListener("abort", onAbort, { once: true });
			session.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
	}

	#stop(
		session: SessionRecord,
		terminalState: "interrupted" | "killed" | "timed_out",
		preferInterrupt: boolean,
	): Promise<ShellSessionSnapshot> {
		if (session.terminalState !== undefined) {
			return Promise.resolve(this.#snapshot(session, session.modelCursor));
		}
		if (session.stopPromise !== undefined) return session.stopPromise;
		let resolveStop: (snapshot: ShellSessionSnapshot) => void = () => undefined;
		let rejectStop: (error: unknown) => void = () => undefined;
		const stopPromise = new Promise<ShellSessionSnapshot>((resolve, reject) => {
			resolveStop = resolve;
			rejectStop = reject;
		});
		session.stopPromise = stopPromise;
		void (async () => {
			await session.processResource?.close();
			let cleanup: ProcessCleanupResult;
			try {
				cleanup = preferInterrupt
					? await session.transport.interrupt()
					: await session.transport.terminate();
			} catch {
				cleanup = { state: "inconclusive" };
			}
			session.cleanupResult = cleanup.state;
			if (cleanup.state === "inconclusive") {
				if (session.pendingExit !== undefined) {
					await this.#finalize(
						session,
						terminalState,
						session.pendingExit,
						"already_exited",
					);
					return this.#snapshot(session, session.modelCursor);
				}
				session.stopPromise = undefined;
				this.#notifyStateChange(session);
				return errorSnapshot(
					session.ownerSessionId,
					"shell_cleanup_failed",
					"Shell process cleanup was inconclusive.",
					session.shellId,
				);
			}
			const exit = session.pendingExit ?? {
				exitCode: cleanup.exitCode ?? null,
				signal: cleanup.signal ?? null,
			};
			await this.#finalize(session, terminalState, exit, cleanup.state);
			return this.#snapshot(session, session.modelCursor);
		})().then(resolveStop, rejectStop);
		return stopPromise;
	}

	#queueStop(
		session: SessionRecord,
		terminalState: "interrupted" | "killed" | "timed_out",
		preferInterrupt: boolean,
	): Promise<ShellSessionSnapshot> {
		this.#notifyStateChange(session);
		return this.#serialize(session, () => this.#stop(session, terminalState, preferInterrupt));
	}

	async #finalize(
		session: SessionRecord,
		terminalState: string,
		exit: ShellExit,
		cleanupResult: string,
	): Promise<void> {
		if (session.terminalState !== undefined) return;
		session.terminalState = terminalState;
		session.exitCode = exit.exitCode ?? undefined;
		session.cleanupResult = cleanupResult;
		session.completedAt = new Date().toISOString();
		if (session.timeoutTimer !== undefined) clearTimeout(session.timeoutTimer);
		if (session.outputEventTimer !== undefined) {
			clearTimeout(session.outputEventTimer);
			session.outputEventTimer = undefined;
		}
		this.#flushNormalizers(session);
		this.#flushLifecycleOutput(session);
		this.#publish(session, "shell.completed");
		if (session.background) this.#publishListUpdate(session);
		session.removeAbortListener?.();
		session.unsubscribeOutput?.();
		session.unsubscribeExit?.();
		await session.processResource?.close();
		this.#notifyStateChange(session);
		session.resolveCompletion();
		await session.transport.close().catch(() => undefined);
	}

	#publishListUpdate(session: SessionRecord): void {
		this.#publish(session, "shell.list.updated", {
			activeBackgroundCount: [...this.#sessions.values()].filter((candidate) =>
				candidate.ownerSessionId === session.ownerSessionId
				&& candidate.background
				&& candidate.terminalState === undefined).length,
		});
	}

	#publish(
		session: SessionRecord,
		kind: ShellLifecycleKind,
		extra: Partial<ShellLifecycleEvent> = {},
	): void {
		session.eventSequence += 1;
		const outputChars = totalChars(session.output);
		const event: ShellLifecycleEvent = Object.freeze({
			type: "shell_lifecycle",
			kind,
			shellId: session.shellId,
			ownerSessionId: session.ownerSessionId,
			...(session.ownerTurnId === undefined ? {} : { ownerTurnId: session.ownerTurnId }),
			callId: session.callId,
			sequence: session.eventSequence,
			commandPreview: session.commandPreview,
			...(session.description === undefined ? {} : { description: session.description }),
			background: session.background,
			processState: processState(session),
			transport: session.transport.kind,
			tty: session.transport.tty,
			yielded: session.yielded,
			...(session.terminalState === undefined ? {} : { terminalState: session.terminalState }),
			...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
			nextCursor: outputChars,
			outputChars,
			omittedOutputChars: Math.max(
				session.output.read(0).omittedChars,
				session.lifecycleOmittedChars,
			),
			...(session.cleanupResult === undefined ? {} : { cleanupResult: session.cleanupResult }),
			startedAt: session.startedAt,
			...(session.completedAt === undefined ? {} : { completedAt: session.completedAt }),
			...(session.shellKind === undefined ? {} : { shellKind: session.shellKind }),
			...(session.shellEdition === undefined ? {} : { shellEdition: session.shellEdition }),
			...extra,
		});
		try {
			session.publishLifecycle(event);
		} catch {
			// Lifecycle observers cannot own process progress.
		}
	}

	async #serialize<T>(session: SessionRecord, operation: () => Promise<T>): Promise<T> {
		const previous = session.interactionTail;
		let release: () => void = () => undefined;
		session.interactionTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
		}
	}

	async #waitForStateChange(
		session: SessionRecord,
		yieldTimeMs: number,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (yieldTimeMs === 0 || signal?.aborted) return;
		await new Promise<void>((resolve) => {
			const done = (): void => {
				session.stateWaiters.delete(done);
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			session.stateWaiters.add(done);
			const timer = setTimeout(done, yieldTimeMs);
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	#notifyStateChange(session: SessionRecord): void {
		const waiters = [...session.stateWaiters];
		session.stateWaiters.clear();
		for (const waiter of waiters) waiter();
	}

	#snapshot(session: SessionRecord, cursor: number): ShellSessionSnapshot {
		session.lastUsedTimeMs = Date.now();
		const output = session.output.read(cursor);
		const stdout = session.stdout.read(0);
		const stderr = session.stderr.read(0);
		return Object.freeze({
			success: true,
			shellId: session.shellId,
			ownerSessionId: session.ownerSessionId,
			callId: session.callId,
			background: session.background,
			status: session.terminalState === undefined ? "running" : "exited",
			processState: processState(session),
			...(session.terminalState === undefined ? {} : { terminalState: session.terminalState }),
			...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
			output: output.text,
			stdout: stdout.text,
			stderr: stderr.text,
			nextCursor: output.nextCursor,
			outputChars: output.outputChars,
			newOutputChars: output.text.length,
			omittedOutputChars: output.omittedChars,
			stdoutChars: stdout.outputChars,
			stderrChars: stderr.outputChars,
			stdoutOmittedChars: stdout.omittedChars,
			stderrOmittedChars: stderr.omittedChars,
			cursorWasEvicted: output.cursorWasEvicted,
			...(session.cleanupResult === undefined ? {} : { cleanupResult: session.cleanupResult }),
			transport: session.transport.kind,
			tty: session.transport.tty,
			yielded: session.yielded,
			decodeReplacementCount: session.decodeReplacementCount,
			commandPreview: session.commandPreview,
			...(session.description === undefined ? {} : { description: session.description }),
			startedAt: session.startedAt,
			...(session.completedAt === undefined ? {} : { completedAt: session.completedAt }),
			wallTimeSeconds: Math.max(0, Date.now() - session.startedTimeMs) / 1_000,
			...(session.shellKind === undefined ? {} : { shellKind: session.shellKind }),
			...(session.shellEdition === undefined ? {} : { shellEdition: session.shellEdition }),
		});
	}
}

class ErrorSnapshotMarker {
	constructor(readonly snapshot: ShellSessionSnapshot) {}
}

function createSession(
	shellId: string,
	request: ShellStartRequest,
	transport: ShellTransport,
	outputMaxChars: number,
): SessionRecord {
	let resolveCompletion: () => void = () => undefined;
	const completion = new Promise<void>((resolve) => {
		resolveCompletion = resolve;
	});
	const startedTimeMs = Date.now();
	const consoleFallbackEncoding = windowsConsoleFallbackEncoding();
	return {
		shellId,
		...(request.processResource ? { processResource: request.processResource } : {}),
		ownerSessionId: request.ownerSessionId,
		...(request.ownerTurnId === undefined ? {} : { ownerTurnId: request.ownerTurnId }),
		callId: request.callId,
		commandPreview: commandPreview(request.command),
		...(request.description === undefined ? {} : { description: request.description }),
		transport,
		publishLifecycle: request.publishLifecycle,
		output: new ShellOutputBuffer({ maxChars: outputMaxChars }),
		stdout: new ShellOutputBuffer({ maxChars: outputMaxChars }),
		stderr: new ShellOutputBuffer({ maxChars: outputMaxChars }),
		normalizers: {
			stdout: new TerminalOutputNormalizer({ fallbackEncoding: consoleFallbackEncoding }),
			stderr: new TerminalOutputNormalizer({ fallbackEncoding: consoleFallbackEncoding }),
			terminal: new TerminalOutputNormalizer({ fallbackEncoding: consoleFallbackEncoding }),
		},
		startedAt: new Date(startedTimeMs).toISOString(),
		startedTimeMs,
		timeoutSeconds: request.timeoutSeconds,
		shellKind: request.shellKind,
		shellEdition: request.shellEdition,
		stateWaiters: new Set(),
		completion,
		resolveCompletion,
		background: request.background === true,
		yielded: false,
		modelCursor: 0,
		lifecycleCursor: 0,
		lifecycleOmittedChars: 0,
		eventSequence: 0,
		decodeReplacementCount: 0,
		lastUsedTimeMs: startedTimeMs,
		interactionTail: Promise.resolve(),
	};
}

function transportRequest(request: ShellStartRequest): ShellTransportStartRequest {
	return {
		executable: request.executable,
		args: request.args,
		cwd: request.cwd,
		env: request.env,
		platform: request.platform,
		tty: request.tty,
		rows: request.rows,
		columns: request.columns,
	};
}

function processState(session: SessionRecord): string {
	return session.terminalState
		?? (session.background ? "running_background" : "running_foreground");
}

function totalChars(output: ShellOutputBuffer): number {
	return output.read(Number.MAX_SAFE_INTEGER).outputChars;
}

function commandPreview(command: string): string {
	const normalized = command.split(/\s+/u).filter(Boolean).join(" ");
	return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function validateStartRequest(request: ShellStartRequest): void {
	if (!request.ownerSessionId.trim()) throw new RangeError("ownerSessionId must be non-empty");
	if (request.ownerTurnId !== undefined && !request.ownerTurnId.trim()) {
		throw new RangeError("ownerTurnId must be non-empty");
	}
	if (!request.callId.trim()) throw new RangeError("callId must be non-empty");
	if (!request.command.trim()) throw new RangeError("command must be non-empty");
	nonNegativeInteger(request.yieldTimeMs, "yieldTimeMs");
	if (!Number.isFinite(request.timeoutSeconds) || request.timeoutSeconds < 0) {
		throw new RangeError("timeoutSeconds must be a non-negative finite number");
	}
}

function validateInteractionRequest(request: ShellInteractionRequest): void {
	if (!request.ownerSessionId.trim()) throw new RangeError("ownerSessionId must be non-empty");
	if (!request.shellId.trim()) throw new RangeError("shellId must be non-empty");
	nonNegativeInteger(request.yieldTimeMs, "yieldTimeMs");
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
	return value;
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
	const validated = positiveInteger(value, name);
	if (validated > maximum) {
		throw new RangeError(`${name} must be at most ${maximum}`);
	}
	return validated;
}

function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative safe integer`);
	}
	return value;
}

function errorSnapshot(
	ownerSessionId: string,
	errorKind: string,
	error: string,
	shellId = "",
): ShellSessionSnapshot {
	return Object.freeze({
		success: false,
		shellId,
		ownerSessionId,
		background: false,
		status: "error",
		processState: "failed",
		terminalState: "failed",
		output: "",
		stdout: "",
		stderr: "",
		nextCursor: 0,
		outputChars: 0,
		newOutputChars: 0,
		omittedOutputChars: 0,
		stdoutChars: 0,
		stderrChars: 0,
		stdoutOmittedChars: 0,
		stderrOmittedChars: 0,
		cursorWasEvicted: false,
		tty: false,
		yielded: false,
		decodeReplacementCount: 0,
		wallTimeSeconds: 0,
		errorKind,
		error,
	});
}

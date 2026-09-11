import { randomUUID } from "node:crypto";
import { UserTurnCancellation } from "../abort.ts";
import { createErrorContext, errorOccurrence, runtimeErrorPublicMessage, type RuntimeFailure } from "@mycli/contracts";
import { stableModelInputJson } from "@mycli/core";
import { ProviderFailure } from "@mycli/providers";
import { AgentWorkerMessageSizeError } from "./agent-worker-pool.ts";
import type { AgentWorkerLease } from "./agent-worker-pool.ts";
import {
	AgentWorkerProviderRpcError,
	AgentWorkerProviderRpcSizeError,
	parseAgentWorkerProviderCommand,
	parseAgentWorkerProviderDiagnosticEnvelope,
	parseAgentWorkerProviderResponse,
} from "./agent-worker-provider-rpc.ts";
import type {
	AgentWorkerProviderDiagnosticEnvelope,
	AgentWorkerProviderResponse,
} from "./agent-worker-provider-rpc.ts";
import { AGENT_WORKER_PROTOCOL_VERSION } from "./agent-worker-protocol.ts";
import type {
	ProviderStepExecutionInput,
	ProviderStepExecutor,
} from "../providers/provider-step-executor.ts";
import { resolveProviderStepRetryPolicy } from "../providers/provider-step-executor.ts";
import type { ProviderAgentLoopResult } from "../providers/provider-agent-loop.ts";
import { publishProviderStreamDiagnostics } from "../runtime-observability.ts";

export interface WorkerProviderStepExecutorOptions {
	readonly lease: AgentWorkerLease;
	readonly createRequestId?: () => string;
}

export class WorkerProviderStepExecutor implements ProviderStepExecutor {
	readonly attemptSource = "worker" as const;
	readonly #lease: AgentWorkerLease;
	readonly #createRequestId: () => string;
	#running = false;
	#commandSequence = 0;
	#responseSequence = 0;
	#timelineInitialized = false;
	#activeTimelineWindowId = "uninitialized";
	#activeTimelineVersion = 1;
	readonly #seenTimelineWindowIds = new Set<string>();

	constructor(options: WorkerProviderStepExecutorOptions) {
		this.#lease = options.lease;
		this.#createRequestId = options.createRequestId ?? randomUUID;
	}

	async execute(input: ProviderStepExecutionInput): Promise<ProviderAgentLoopResult> {
		if (this.#running) throw invalid("provider step is already running");
		if (!input.providerRoute) throw invalid("provider route snapshot is unavailable");
		if (input.recordAttempt && !input.requestId) throw invalid("durable provider request identity is unavailable");
		if (input.attemptState && !input.recordAttempt) throw invalid("provider attempt recorder is unavailable");
		input.signal.throwIfAborted();
		const retryPolicy = resolveProviderStepRetryPolicy(input);
		const startedAt = input.monotonicClock?.() ?? performance.now();
		this.#acceptTimeline(input.timelineWindowId, input.timelineVersion);
		this.#running = true;
		const requestId = input.requestId ?? this.#createRequestId();
		let settled = false;
		let dispatched = false;
		let cancellationSent = false;
		let responseChain = Promise.resolve();
		let terminating: Promise<void> | undefined;
		let lastAttemptSequence = input.attemptState?.sequence ?? 0;
		let lastAttemptState = input.attemptState?.state;
		let lastAttemptFailure = input.attemptState?.failure;
		const attemptFrames = new Map<number, string>();
		const committedUpdates = new Map<number, string>();
		if (input.attemptState) committedUpdates.set(input.attemptState.sequence, stableModelInputJson(input.attemptState));
		let resolveResult!: (result: ProviderAgentLoopResult) => void;
		let rejectResult!: (error: Error) => void;
		const result = new Promise<ProviderAgentLoopResult>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			rejectResult(error);
		};
		const terminate = (reason: string): void => {
			terminating ??= this.#lease.terminate(reason).catch(() => undefined);
		};
		const handleResponse = async (response: AgentWorkerProviderResponse): Promise<void> => {
			if (settled) return;
			if (response.type === "provider_step_attempt") {
				const update = response.update;
				if (!input.recordAttempt
					|| update.policy.requestMaxRetries !== retryPolicy.requestMaxRetries
					|| update.policy.streamMaxRetries !== retryPolicy.streamMaxRetries) {
					throw invalid("provider attempt does not match committed execution policy");
				}
				const fingerprint = stableModelInputJson(update);
				const committed = committedUpdates.get(update.sequence);
				if (committed !== undefined) {
					if (committed !== fingerprint) throw invalid("provider attempt duplicate conflicts with committed state");
				} else {
					if (update.sequence !== lastAttemptSequence + 1) throw invalid("provider attempt sequence is not contiguous");
					try {
						await input.recordAttempt(update);
					} catch {
						if (settled) return;
						settled = true;
						resolveResult({
							failure: { code: "persistence_error", message: runtimeErrorPublicMessage("persistence_error"), retryable: false },
							eventsObserved: 0,
						});
						terminate("provider attempt persistence failed");
						return;
					}
					lastAttemptSequence = update.sequence;
					lastAttemptState = update.state;
					lastAttemptFailure = update.failure ?? lastAttemptFailure;
					committedUpdates.set(update.sequence, fingerprint);
				}
				if (settled) return;
				this.#lease.postMessage(parseAgentWorkerProviderCommand({
					type: "provider_step_attempt_ack",
					...this.#identity(requestId),
					attemptSequence: update.sequence,
				}));
				this.#commandSequence += 1;
				return;
			}
			if (response.type === "provider_step_event") {
				input.emit(response.event);
				return;
			}
			if (response.type === "provider_step_diagnostic") {
				publishProviderStreamDiagnostics(input.recordDiagnostic, response.diagnostic);
				return;
			}
			if (input.recordAttempt && !("failure" in response.result)
				&& lastAttemptState !== "completed" && lastAttemptState !== "recovered") {
				throw invalid("provider success has no committed terminal attempt");
			}
			settled = true;
			resolveResult(response.result);
		};
		const removeMessage = this.#lease.onMessage((value) => {
			if (settled) return;
			let response: AgentWorkerProviderResponse;
			try {
				const diagnostic = parseAgentWorkerProviderDiagnosticEnvelope(value);
				if (diagnostic) {
					// An advisory payload may be dropped only inside the active request's fence.
					this.#assertResponseIdentity(diagnostic, requestId, this.#responseSequence + 1);
					try {
						response = parseAgentWorkerProviderResponse(value);
					} catch {
						this.#responseSequence = diagnostic.sequence;
						return;
					}
				} else response = parseAgentWorkerProviderResponse(value);
				const duplicate = response.type === "provider_step_attempt"
					&& response.sequence <= this.#responseSequence;
				this.#assertResponseIdentity(response, requestId, duplicate ? response.sequence : this.#responseSequence + 1);
				if (duplicate) {
					if (attemptFrames.get(response.sequence) !== stableModelInputJson(response)) {
						throw invalid("provider attempt frame conflicts with prior delivery");
					}
				} else {
					this.#responseSequence = response.sequence;
					if (response.type === "provider_step_attempt") attemptFrames.set(response.sequence, stableModelInputJson(response));
				}
			} catch (error) {
				fail(error instanceof Error ? error : invalid("provider response is invalid"));
				terminate("provider protocol failure");
				return;
			}
			responseChain = responseChain.then(() => handleResponse(response)).catch((error: unknown) => {
				fail(error instanceof Error ? error : invalid("provider response handler failed"));
				terminate("provider response handler failed");
			});
		});
		const cancel = (): void => {
			if (settled || cancellationSent) return;
			cancellationSent = true;
			try {
				this.#lease.postMessage(parseAgentWorkerProviderCommand({
					type: "provider_step_cancel",
					...this.#identity(requestId),
					...(input.signal.reason instanceof UserTurnCancellation ? { userInitiated: true } : {}),
				}));
				this.#commandSequence += 1;
			} catch (error) {
				fail(error instanceof Error ? error : invalid("provider cancellation failed"));
			}
		};
		try {
			this.#lease.postMessage(parseAgentWorkerProviderCommand({
				type: "provider_step_execute",
				...this.#identity(requestId),
				config: Object.freeze({
					provider: input.config.provider,
					protocol: input.config.protocol,
					model: input.config.model,
					apiBaseUrl: input.config.apiBaseUrl,
					supportsImages: input.config.supportsImages,
					maxPromptTokens: input.config.maxPromptTokens,
					...(input.config.modelContextWindowTokens === undefined ? {} : {
						modelContextWindowTokens: input.config.modelContextWindowTokens,
					}),
					...(input.config.maxOutputTokens === undefined ? {} : {
						maxOutputTokens: input.config.maxOutputTokens,
					}),
					...(input.config.apiKey ? { apiKey: input.config.apiKey } : {}),
					homeDir: input.config.homeDir,
					authRef: input.config.authRef,
					...(input.config.nativeTransport ? { nativeTransport: input.config.nativeTransport } : {}),
					...(input.config.providerEnv === undefined ? {} : { providerEnv: input.config.providerEnv }),
					...(input.config.allowAmbientAuth === undefined ? {} : { allowAmbientAuth: input.config.allowAmbientAuth }),
				}),
				route: input.providerRoute,
				request: input.request,
				requestMaxRetries: retryPolicy.requestMaxRetries,
				maxRetries: retryPolicy.streamMaxRetries,
				toolCallsAllowed: input.toolCallsAllowed,
				streamDiagnosticsVersion: 1,
				...(input.errorContextVersion ? { errorContextVersion: input.errorContextVersion } : {}),
				...(input.recordAttempt ? { recordAttempts: true } : {}),
				...(input.attemptState ? { attemptState: input.attemptState } : {}),
			}));
			this.#commandSequence += 1;
			dispatched = true;
			input.signal.addEventListener("abort", cancel, { once: true });
			if (input.signal.aborted) cancel();
			return await Promise.race([
				result,
				this.#lease.failure.then((failure) => Promise.reject(new ProviderFailure({
					code: "provider_error", message: failure.message, source: "worker_rpc",
					errorReason: { reason: "runtime.worker_exited", details: { legacy_code: failure.code } },
					outcome: { state: "unknown", effects: "possible" },
					...(lastAttemptFailure?.errorContext ? { causes: [errorOccurrence(lastAttemptFailure.errorContext), ...(lastAttemptFailure.errorContext.causes ?? [])] } : {}),
				}))),
			]);
		} catch (error) {
			if (dispatched || !(error instanceof AgentWorkerProviderRpcSizeError || error instanceof AgentWorkerMessageSizeError)) {
				if (error instanceof AgentWorkerProviderRpcError) {
					throw new ProviderFailure({
						code: "provider_error", message: error.message, retryable: false,
						scope: { kind: "request", id: requestId },
						source: "worker_rpc", errorReason: { reason: "gateway.protocol_incompatible" },
						outcome: { state: dispatched ? "unknown" : "not_started", effects: dispatched ? "possible" : "none" },
						...(lastAttemptFailure?.errorContext ? { causes: [errorOccurrence(lastAttemptFailure.errorContext)] } : {}),
						publicDetail: "Local Worker communication failed. Restart mycli to reload matching runtime modules, then retry.",
						diagnostics: { error_source: "worker_rpc" },
					});
				}
				throw error;
			}
			input.signal.throwIfAborted();
			const failure: RuntimeFailure = {
				code: "context_window_exceeded",
				message: runtimeErrorPublicMessage("context_window_exceeded"),
				additionalDetails: `Conversation request exceeds the local execution limit (${error.maxBytes} bytes). Compact the conversation or reduce attached input.`,
				retryable: false,
				...(input.errorContextVersion === 1 ? { errorContext: createErrorContext({
					reason: "gateway.message_too_large", source: "worker_rpc", scope: { kind: "request", id: requestId },
					details: { limit_bytes: error.maxBytes }, outcome: { state: "not_started", effects: "none" },
				}) } : {}),
				diagnostics: {
					error_source: "worker_rpc",
					maximum_bytes: error.maxBytes,
					...(error instanceof AgentWorkerProviderRpcSizeError ? { payload_bytes: error.actualBytes } : {}),
				},
			};
			publishProviderStreamDiagnostics(input.recordDiagnostic, {
				attempt: 1,
				elapsedMs: Math.max(0, (input.monotonicClock?.() ?? performance.now()) - startedAt),
				textDeltaIntervalCount: 0,
				providerEventCount: 0,
				reasoningEventCount: 0,
				textEventCount: 0,
				providerStateEventCount: 0,
				toolCallEventCount: 0,
				usageEventCount: 0,
				completedEventCount: 0,
				reasoningBytes: 0,
				textBytes: 0,
				success: false,
				failureKind: failure.code,
				failure,
			});
			return { failure, eventsObserved: 0 };
		} finally {
			settled = true;
			input.signal.removeEventListener("abort", cancel);
			removeMessage();
			await responseChain;
			await terminating;
			this.#running = false;
		}
	}

	#identity(requestId: string) {
		return {
			protocolVersion: AGENT_WORKER_PROTOCOL_VERSION,
			coordinatorEpoch: this.#lease.coordinatorEpoch,
			workerId: this.#lease.workerId,
			workerGeneration: this.#lease.workerGeneration,
			leaseId: this.#lease.leaseId,
			jobId: this.#lease.jobId,
			sessionId: this.#lease.sessionId,
			turnId: this.#lease.turnId,
			timelineWindowId: this.#activeTimelineWindowId,
			timelineVersion: this.#activeTimelineVersion,
			requestId,
			sequence: this.#commandSequence + 1,
		};
	}

	#acceptTimeline(windowId: string, version: number): void {
		if (!windowId.trim() || !Number.isSafeInteger(version) || version < 1) {
			throw invalid("provider timeline is invalid");
		}
		if (this.#timelineInitialized
			&& windowId === this.#activeTimelineWindowId
			&& version !== this.#activeTimelineVersion + 1) {
			throw invalid("provider timeline is not contiguous");
		}
		if (windowId !== this.#activeTimelineWindowId && this.#seenTimelineWindowIds.has(windowId)) {
			throw invalid("provider timeline window was already replaced");
		}
		this.#timelineInitialized = true;
		this.#activeTimelineWindowId = windowId;
		this.#activeTimelineVersion = version;
		this.#seenTimelineWindowIds.add(windowId);
	}

	#assertResponseIdentity(
		response: AgentWorkerProviderResponse | AgentWorkerProviderDiagnosticEnvelope,
		requestId: string,
		expectedSequence: number,
	): void {
		if (response.workerId !== this.#lease.workerId
			|| response.protocolVersion !== AGENT_WORKER_PROTOCOL_VERSION
			|| response.coordinatorEpoch !== this.#lease.coordinatorEpoch
			|| response.workerGeneration !== this.#lease.workerGeneration
			|| response.leaseId !== this.#lease.leaseId
			|| response.jobId !== this.#lease.jobId
			|| response.sessionId !== this.#lease.sessionId
			|| response.turnId !== this.#lease.turnId
			|| response.timelineWindowId !== this.#activeTimelineWindowId
			|| response.timelineVersion !== this.#activeTimelineVersion
			|| response.requestId !== requestId
			|| response.sequence !== expectedSequence) {
			throw invalid("provider response fence does not match active request");
		}
	}
}

function invalid(message: string): AgentWorkerProviderRpcError {
	return new AgentWorkerProviderRpcError(message);
}

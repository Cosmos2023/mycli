import { randomUUID } from "node:crypto";
import type { AgentWorkerLease, AgentWorkerLeaseFailure } from "./agent-worker-pool.ts";
import {
	AgentWorkerProviderRpcError,
	parseAgentWorkerProviderCommand,
	parseAgentWorkerProviderResponse,
} from "./agent-worker-provider-rpc.ts";
import type { AgentWorkerProviderResponse } from "./agent-worker-provider-rpc.ts";
import { AGENT_WORKER_PROTOCOL_VERSION } from "./agent-worker-protocol.ts";
import type {
	ProviderStepExecutionInput,
	ProviderStepExecutor,
} from "./provider-step-executor.ts";
import type { ProviderAgentLoopResult } from "./provider-agent-loop.ts";
import { publishProviderStreamDiagnostics } from "./runtime-observability.ts";

export interface WorkerProviderStepExecutorOptions {
	readonly lease: AgentWorkerLease;
	readonly createRequestId?: () => string;
}

export class WorkerProviderStepExecutor implements ProviderStepExecutor {
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
		input.signal.throwIfAborted();
		this.#acceptTimeline(input.timelineWindowId, input.timelineVersion);
		this.#running = true;
		const requestId = this.#createRequestId();
		let settled = false;
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
		const removeMessage = this.#lease.onMessage((value) => {
			let response: AgentWorkerProviderResponse;
			try {
				response = parseAgentWorkerProviderResponse(value);
				this.#assertResponseIdentity(response, requestId, this.#responseSequence + 1);
			} catch (error) {
				fail(error instanceof Error ? error : invalid("provider response is invalid"));
				void this.#lease.terminate("provider protocol failure");
				return;
			}
			this.#responseSequence = response.sequence;
			if (response.type === "provider_step_event") {
				try {
					input.emit(response.event);
				} catch (error) {
					fail(error instanceof Error ? error : invalid("provider event handler failed"));
					void this.#lease.terminate("provider event handler failed");
				}
				return;
			}
			if (response.type === "provider_step_diagnostic") {
				publishProviderStreamDiagnostics(input.recordDiagnostic, response.diagnostic);
				return;
			}
			if (settled) return;
			settled = true;
			resolveResult(response.result);
		});
		const cancel = (): void => {
			try {
				this.#lease.postMessage(parseAgentWorkerProviderCommand({
					type: "provider_step_cancel",
					...this.#identity(requestId),
				}));
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
				}),
				route: input.providerRoute,
				request: input.request,
				requestMaxRetries: input.config.requestMaxRetries,
				maxRetries: input.maxRetries,
				toolCallsAllowed: input.toolCallsAllowed,
			}));
			input.signal.addEventListener("abort", cancel, { once: true });
			if (input.signal.aborted) cancel();
			return await Promise.race([
				result,
				this.#lease.failure.then((failure) => Promise.reject(workerFailure(failure))),
			]);
		} finally {
			settled = true;
			input.signal.removeEventListener("abort", cancel);
			removeMessage();
			this.#running = false;
		}
	}

	#identity(requestId: string) {
		this.#commandSequence += 1;
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
			sequence: this.#commandSequence,
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
		response: AgentWorkerProviderResponse,
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

function workerFailure(failure: AgentWorkerLeaseFailure): AgentWorkerProviderRpcError {
	return invalid(`${failure.code}: ${failure.message}`);
}

function invalid(message: string): AgentWorkerProviderRpcError {
	return new AgentWorkerProviderRpcError(message);
}

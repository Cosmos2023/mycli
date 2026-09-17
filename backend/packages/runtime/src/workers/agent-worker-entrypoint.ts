import type { ProviderUsage } from "@mycli/core";
import { parentPort, workerData } from "node:worker_threads";
import { UserTurnCancellation } from "../abort.ts";
import { ProviderRegistry } from "@mycli/providers";
import type { ProviderAttemptUpdate } from "@mycli/contracts";
import {
	parseAgentWorkerProviderCommand,
	parseAgentWorkerProviderResponse,
	projectAgentWorkerProviderDiagnostics,
} from "./agent-worker-provider-rpc.ts";
import type { AgentWorkerProviderCommand } from "./agent-worker-provider-rpc.ts";
import {
	ProviderAgentLoop,
	normalizeProviderAgentLoopFailure,
} from "../providers/provider-agent-loop.ts";

interface AgentWorkerData {
	readonly workerId: string;
	readonly workerGeneration: number;
}

interface ActiveJob {
	readonly coordinatorEpoch: string;
	readonly leaseId: string;
	readonly jobId: string;
	readonly sessionId: string;
	readonly turnId: string;
	commandSequence: number;
	responseSequence: number;
	timelineWindowId?: string;
	timelineVersion?: number;
	readonly timelineWindowIds: Set<string>;
	request?: ActiveProviderRequest;
	completedRequest?: { readonly requestId: string; readonly acknowledgedAttemptSequence: number };
}

interface ActiveProviderRequest {
	readonly requestId: string;
	readonly controller: AbortController;
	sequence: number;
	acknowledgedAttemptSequence: number;
	pendingAttempt?: {
		readonly sequence: number;
		readonly resolve: () => void;
	};
}

type CoordinatorMessage =
	| {
		readonly type: "lease";
		readonly coordinatorEpoch: string;
		readonly workerId: string;
		readonly workerGeneration: number;
		readonly leaseId: string;
		readonly jobId: string;
		readonly sessionId: string;
		readonly turnId: string;
	}
	| { readonly type: "release"; readonly leaseId: string; readonly jobId: string }
	| { readonly type: "shutdown" };

const port = parentPort;
if (!port) throw new Error("agent_worker_requires_parent_port");

const data = workerData as AgentWorkerData;
const providers = new ProviderRegistry();
const providerLoop = new ProviderAgentLoop();
let active: ActiveJob | undefined;

port.on("message", (value: unknown) => {
	if (!isCoordinatorMessage(value)) {
		void handleProviderCommand(value);
		return;
	}
	const message = value;
	if (message.type === "lease") {
		if (active
			|| message.workerId !== data.workerId
			|| message.workerGeneration !== data.workerGeneration) {
			protocolError("invalid_lease");
			return;
		}
		active = {
			coordinatorEpoch: message.coordinatorEpoch,
			leaseId: message.leaseId,
			jobId: message.jobId,
			sessionId: message.sessionId,
			turnId: message.turnId,
			commandSequence: 0,
			responseSequence: 0,
			timelineWindowIds: new Set(),
		};
		port.postMessage({
			type: "leased",
			workerId: data.workerId,
			workerGeneration: data.workerGeneration,
			leaseId: active.leaseId,
			jobId: active.jobId,
		});
		return;
	}
	if (message.type === "release") {
		if (!active || active.request
			|| active.leaseId !== message.leaseId || active.jobId !== message.jobId) {
			protocolError("invalid_release");
			return;
		}
		const released = active;
		active = undefined;
		port.postMessage({
			type: "released",
			workerId: data.workerId,
			workerGeneration: data.workerGeneration,
			leaseId: released.leaseId,
			jobId: released.jobId,
		});
		return;
	}
	if (message.type !== "shutdown") {
		protocolError("malformed_control_message");
		return;
	}
	active?.request?.controller.abort();
	active = undefined;
	port.postMessage({
		type: "stopped",
		workerId: data.workerId,
		workerGeneration: data.workerGeneration,
	});
	port.close();
});

port.postMessage({
	type: "ready",
	workerId: data.workerId,
	workerGeneration: data.workerGeneration,
});

function protocolError(reason: string): void {
	active?.request?.controller.abort();
	port!.postMessage({
		type: "protocol_error",
		workerId: data.workerId,
		workerGeneration: data.workerGeneration,
		reason,
	});
}

async function handleProviderCommand(value: unknown): Promise<void> {
	let command: AgentWorkerProviderCommand;
	try {
		command = parseAgentWorkerProviderCommand(value);
	} catch {
		protocolError("malformed_provider_message");
		return;
	}
	if (!matchesActive(command)) {
		protocolError("invalid_provider_fence");
		return;
	}
	if (!acceptCommandSequence(command)) {
		protocolError("invalid_provider_sequence");
		return;
	}
	if (command.type === "provider_step_cancel") {
		if (!active?.request || active.request.requestId !== command.requestId) {
			protocolError("invalid_provider_cancellation");
			return;
		}
		active.request.controller.abort(command.userInitiated ? new UserTurnCancellation() : undefined);
		return;
	}
	if (command.type === "provider_step_attempt_ack") {
		const request = active?.request;
		if (!request && active?.completedRequest?.requestId === command.requestId
			&& command.attemptSequence <= active.completedRequest.acknowledgedAttemptSequence) return;
		if (!request || request.requestId !== command.requestId) {
			protocolError("invalid_provider_attempt_acknowledgement");
			return;
		}
		if (command.attemptSequence <= request.acknowledgedAttemptSequence) return;
		if (request.pendingAttempt?.sequence !== command.attemptSequence) {
			protocolError("invalid_provider_attempt_acknowledgement");
			return;
		}
		request.acknowledgedAttemptSequence = command.attemptSequence;
		const pending = request.pendingAttempt;
		request.pendingAttempt = undefined;
		pending.resolve();
		return;
	}
	if (!active || active.request) {
		protocolError("provider_request_already_active");
		return;
	}
	if (!acceptTimeline(command)) {
		protocolError("invalid_provider_timeline");
		return;
	}
	const request: ActiveProviderRequest = {
		requestId: command.requestId,
		controller: new AbortController(),
		sequence: 0,
		acknowledgedAttemptSequence: command.attemptState?.sequence ?? 0,
	};
	active.request = request;
	try {
		const result = await providerLoop.runStep({
			requestId: command.requestId,
			errorContextVersion: command.errorContextVersion,
			provider: providers.create(command.config, command.route),
			request: command.request,
			requestMaxRetries: command.requestMaxRetries,
			maxRetries: command.maxRetries,
			signal: request.controller.signal,
			toolCallsAllowed: command.toolCallsAllowed,
			...(command.recordUsage ? { recordUsage: async (usage: ProviderUsage, attempt: number) => {
				postProviderResponse(command, request, { type: "provider_step_usage", usage, attempt });
			} } : {}),
			...(command.attemptState ? { attemptState: command.attemptState } : {}),
			...(command.recordAttempts ? {
				recordAttempt: (update: ProviderAttemptUpdate) => recordAttempt(command, request, update),
			} : {}),
			emit: (event) => postProviderResponse(command, request, {
				type: "provider_step_event",
				event,
			}),
			recordDiagnostic: (diagnostic) => postProviderResponse(command, request, {
				type: "provider_step_diagnostic",
				diagnostic: projectAgentWorkerProviderDiagnostics(diagnostic, command.streamDiagnosticsVersion),
			}),
			normalizeFailure: (error) => normalizeProviderAgentLoopFailure(
				error,
				request.controller.signal,
			),
		});
		postProviderResponse(command, request, { type: "provider_step_result", result });
	} catch (error) {
		postProviderResponse(command, request, {
			type: "provider_step_result",
			result: {
				failure: normalizeProviderAgentLoopFailure(error, request.controller.signal),
				eventsObserved: 0,
			},
		});
	} finally {
		if (active?.request === request) {
			active.completedRequest = {
				requestId: request.requestId,
				acknowledgedAttemptSequence: request.acknowledgedAttemptSequence,
			};
			active.request = undefined;
		}
	}
}

async function recordAttempt(
	command: AgentWorkerProviderCommand,
	request: ActiveProviderRequest,
	update: ProviderAttemptUpdate,
): Promise<void> {
	if (active?.request !== request || request.pendingAttempt
		|| update.sequence !== request.acknowledgedAttemptSequence + 1) {
		throw new Error("invalid_provider_attempt_proposal");
	}
	await new Promise<void>((resolve, reject) => {
		request.pendingAttempt = { sequence: update.sequence, resolve };
		try {
			postProviderResponse(command, request, { type: "provider_step_attempt", update });
		} catch (error) {
			request.pendingAttempt = undefined;
			reject(error);
		}
	});
}

function postProviderResponse(
	command: AgentWorkerProviderCommand,
	request: ActiveProviderRequest,
	payload: Readonly<Record<string, unknown>>,
): void {
	if (!active || active.request !== request) return;
	const response = parseAgentWorkerProviderResponse({
		...payload,
		workerId: data.workerId,
		workerGeneration: data.workerGeneration,
		leaseId: command.leaseId,
		jobId: command.jobId,
		requestId: command.requestId,
		protocolVersion: command.protocolVersion,
		coordinatorEpoch: command.coordinatorEpoch,
		sessionId: command.sessionId,
		turnId: command.turnId,
		timelineWindowId: command.timelineWindowId,
		timelineVersion: command.timelineVersion,
		sequence: active.responseSequence + 1,
	});
	port!.postMessage(response);
	request.sequence += 1;
	active.responseSequence += 1;
}

function matchesActive(command: AgentWorkerProviderCommand): boolean {
	const identityMatches = active !== undefined
		&& command.coordinatorEpoch === active.coordinatorEpoch
		&& command.workerId === data.workerId
		&& command.workerGeneration === data.workerGeneration
		&& command.leaseId === active.leaseId
		&& command.jobId === active.jobId
		&& command.sessionId === active.sessionId
		&& command.turnId === active.turnId;
	if (!identityMatches || !active) return false;
	return command.type === "provider_step_execute"
		|| (command.timelineWindowId === active.timelineWindowId
			&& command.timelineVersion === active.timelineVersion);
}

function acceptCommandSequence(command: AgentWorkerProviderCommand): boolean {
	if (!active || command.sequence !== active.commandSequence + 1) return false;
	active.commandSequence = command.sequence;
	return true;
}

function acceptTimeline(command: Extract<AgentWorkerProviderCommand, {
	readonly type: "provider_step_execute";
}>): boolean {
	if (!active) return false;
	if (active.timelineWindowId === undefined) {
		active.timelineWindowId = command.timelineWindowId;
		active.timelineVersion = command.timelineVersion;
		active.timelineWindowIds.add(command.timelineWindowId);
		return true;
	}
	if (command.timelineWindowId === active.timelineWindowId
		&& command.timelineVersion !== (active.timelineVersion ?? 0) + 1) {
		return false;
	}
	if (command.timelineWindowId !== active.timelineWindowId
		&& active.timelineWindowIds.has(command.timelineWindowId)) {
		return false;
	}
	active.timelineWindowId = command.timelineWindowId;
	active.timelineVersion = command.timelineVersion;
	active.timelineWindowIds.add(command.timelineWindowId);
	return true;
}

function isCoordinatorMessage(value: unknown): value is CoordinatorMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const message = value as Readonly<Record<string, unknown>>;
	if (message.type === "shutdown") return Object.keys(message).length === 1;
	if (message.type === "release") {
		return Object.keys(message).length === 3
			&& typeof message.leaseId === "string"
			&& typeof message.jobId === "string";
	}
	return message.type === "lease"
		&& Object.keys(message).length === 8
		&& typeof message.coordinatorEpoch === "string"
		&& typeof message.workerId === "string"
		&& Number.isSafeInteger(message.workerGeneration)
		&& typeof message.leaseId === "string"
		&& typeof message.jobId === "string"
		&& typeof message.sessionId === "string"
		&& typeof message.turnId === "string";
}

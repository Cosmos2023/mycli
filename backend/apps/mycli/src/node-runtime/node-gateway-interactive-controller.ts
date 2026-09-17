import type {
	GatewayEventOwnership,
	RuntimeGatewayEventMethod,
} from "./node-gateway-event-projector.ts";
import type {
	PendingSessionApproval,
	PendingSessionClarification,
} from "@mycli/runtime";
import { permissionRequestJson } from "@mycli/tools";
import { approvalChoiceLabel } from "./agent-interactive-requests.ts";
import { approvalPreviewPayload } from "./approval-preview.ts";

type JsonObject = Record<string, unknown>;

type InteractiveRequestMethod = "approval.request" | "clarify.request" | "mcp.elicitation.request";
type InteractiveResponseMethod = "approval.respond" | "clarify.respond" | "mcp.elicitation.respond";

interface QueuedInteractiveRequest {
	readonly method: InteractiveRequestMethod;
	readonly params: JsonObject;
	readonly identity: string;
	readonly ownership: GatewayEventOwnership;
}

interface NodeGatewayInteractiveControllerOptions {
	readonly publish: (
		method: RuntimeGatewayEventMethod,
		params: JsonObject,
		ownership: GatewayEventOwnership,
	) => void;
}

export class NodeGatewayInteractiveController {
	readonly #options: NodeGatewayInteractiveControllerOptions;
	readonly #requests: QueuedInteractiveRequest[] = [];

	constructor(options: NodeGatewayInteractiveControllerOptions) {
		this.#options = options;
	}

	hasPending(): boolean {
		return this.#requests.length > 0;
	}

	reemitVisibleRequest(): boolean {
		const current = this.#requests[0];
		if (!current) return false;
		this.#options.publish(current.method, current.params, current.ownership);
		return true;
	}

	clear(): void {
		this.#requests.length = 0;
	}

	emit(
		method: RuntimeGatewayEventMethod,
		params: JsonObject,
		ownership: GatewayEventOwnership,
	): void {
		if (isInteractiveRequestMethod(method)) {
			this.#enqueue(method, params, ownership);
			return;
		}
		if (isInteractiveResponseMethod(method)) {
			this.#resolve(method, params, ownership);
			return;
		}
		this.#options.publish(method, params, ownership);
	}

	cancel(params: JsonObject): boolean {
		const index = this.#requests.findIndex((request) =>
			interactiveResponseMatchesRequest(request.params, params));
		if (index < 0) return false;
		const request = this.#requests[index]!;
		const wasVisible = index === 0;
		this.#requests.splice(index, 1);
		if (wasVisible) {
			this.#options.publish("interactive.cancelled", params, request.ownership);
			this.#publishNext();
		}
		return true;
	}

	#enqueue(
		method: InteractiveRequestMethod,
		params: JsonObject,
		ownership: GatewayEventOwnership,
	): void {
		const identity = interactiveRequestIdentity(method, params);
		if (this.#requests.some((request) => request.identity === identity)) return;
		this.#requests.push({
			method,
			params: { ...params },
			identity,
			ownership,
		});
		if (this.#requests.length === 1) this.#publishNext();
	}

	#resolve(
		method: InteractiveResponseMethod,
		params: JsonObject,
		fallbackOwnership: GatewayEventOwnership,
	): void {
		const requestMethod = method === "approval.respond" ? "approval.request"
			: method === "mcp.elicitation.respond" ? "mcp.elicitation.request" : "clarify.request";
		const index = this.#requests.findIndex((request) => (
			request.method === requestMethod
			&& interactiveResponseMatchesRequest(request.params, params)
		));
		const request = index >= 0 ? this.#requests[index] : undefined;
		const wasVisible = index === 0;
		if (index >= 0) this.#requests.splice(index, 1);
		this.#options.publish(method, params, request?.ownership ?? fallbackOwnership);
		if (wasVisible) this.#publishNext();
	}

	#publishNext(): void {
		const next = this.#requests[0];
		if (next) this.#options.publish(next.method, next.params, next.ownership);
	}
}

export function approvalRequestPayload(
	approval: PendingSessionApproval,
	generation: number,
): JsonObject {
	return {
		session_id: approval.sessionId,
		generation,
		client_turn_id: approval.clientTurnId,
		turn_id: approval.turnId,
		decision_id: approval.decisionId,
		call_id: approval.callId,
		preview: approval.preview,
		reason: approval.reason,
		tool_name: approval.toolName,
		action: approval.toolName,
		...approvalPreviewPayload(approval),
		options: approval.options.map((choice) => ({
			choice,
			label: approvalChoiceLabel(choice),
		})),
		...(approval.permissionRequest ? {
			permission_request: permissionRequestJson(approval.permissionRequest),
		} : {}),
	};
}

export function clarificationRequestPayload(
	clarification: PendingSessionClarification,
	generation: number,
): JsonObject {
	return {
		session_id: clarification.sessionId,
		generation,
		client_turn_id: clarification.clientTurnId,
		turn_id: clarification.turnId,
		request_id: clarification.requestId,
		tool_id: clarification.callId,
		call_id: clarification.callId,
		tool_name: clarification.toolName,
		question: clarification.question,
		options: clarification.options.map((option) => ({ ...option })),
		header: clarification.header,
		multi_select: clarification.multiSelect,
	};
}

export function isApprovalChoice(
	value: string,
): value is PendingSessionApproval["options"][number] {
	return value === "approve_once"
		|| value === "reject"
		|| value === "allow_session"
		|| value === "always_allow";
}

function isInteractiveRequestMethod(method: string): method is InteractiveRequestMethod {
	return method === "approval.request" || method === "clarify.request" || method === "mcp.elicitation.request";
}

function isInteractiveResponseMethod(method: string): method is InteractiveResponseMethod {
	return method === "approval.respond" || method === "clarify.respond" || method === "mcp.elicitation.respond";
}

function interactiveRequestIdentity(method: InteractiveRequestMethod, params: JsonObject): string {
	const requestId = method === "approval.request"
		? optionalString(params.decision_id)
		: optionalString(params.request_id);
	const sessionId = optionalString(params.session_id)
		?? optionalString(params.child_session_id)
		?? "";
	const generation = positiveInteger(params.generation) ?? 0;
	return `${method}\u0000${sessionId}\u0000${generation}\u0000${requestId ?? ""}`;
}

function interactiveResponseMatchesRequest(request: JsonObject, response: JsonObject): boolean {
	const requestId = optionalString(request.decision_id) ?? optionalString(request.request_id);
	const responseId = optionalString(response.decision_id) ?? optionalString(response.request_id);
	if (!requestId || requestId !== responseId) return false;
	const requestSessionId = optionalString(request.session_id)
		?? optionalString(request.child_session_id);
	const responseSessionId = optionalString(response.session_id)
		?? optionalString(response.child_session_id);
	if (requestSessionId && responseSessionId && requestSessionId !== responseSessionId) return false;
	const requestGeneration = positiveInteger(request.generation);
	const responseGeneration = positiveInteger(response.generation);
	return requestGeneration === undefined
		|| responseGeneration === undefined
		|| requestGeneration === responseGeneration;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

import { randomUUID } from "node:crypto";
import { errorPublicDetails, errorSummary, isDiagnosticRecoveryActionId, readErrorContext, type GatewayEventNotification } from "@mycli/contracts";
import type { NodeBackend, StartNodeBackendOptions } from "../node-runtime/node-backend.ts";
import { HeadlessGatewayClient, isObject } from "./gateway-client.ts";
import { MAX_FINAL_BYTES } from "./io.ts";
import { HeadlessError, type HeadlessResult } from "./types.ts";

interface HeadlessSessionOptions {
	readonly backend: NodeBackend;
	readonly prompt: string;
	readonly readOnly: boolean;
	readonly signal: AbortSignal;
	readonly emit: (event: Readonly<Record<string, unknown>>) => void;
}

export type HeadlessBackendFactory = (options: StartNodeBackendOptions) => NodeBackend | Promise<NodeBackend>;

export async function runHeadlessSession(options: HeadlessSessionOptions): Promise<HeadlessResult> {
	const clientTurnId = randomUUID();
	let sessionId: string | undefined;
	let turnId: string | undefined;
	let terminalResult: HeadlessResult | undefined;
	let resolveTerminal!: (value: HeadlessResult) => void;
	let rejectTerminal!: (error: unknown) => void;
	const terminal = new Promise<HeadlessResult>((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject; });
	void terminal.catch(() => undefined);
	const finish = (result: HeadlessResult): void => {
		if (terminalResult) return;
		terminalResult = { ...result, ...(sessionId ? { session_id: sessionId } : {}), ...(turnId ? { turn_id: turnId } : {}) };
		resolveTerminal(terminalResult);
	};
	const interaction = (kind: string, params: Readonly<Record<string, unknown>> = {}): void => {
		options.emit({ type: "interaction.required", kind,
			...(typeof params.request_id === "string" ? { request_id: params.request_id } : {}),
			...(typeof params.decision_id === "string" ? { decision_id: params.decision_id } : {}),
		});
		finish({ status: "interaction_required", exit_code: 3, code: kind });
	};
	const onEvent = (event: GatewayEventNotification): void => {
		if (event.method === "runtime.ready" && typeof event.params.session_id === "string") sessionId = event.params.session_id;
		if (event.method === "approval.request" || event.method === "clarify.request") {
			interaction(event.method === "approval.request" ? "approval_required" : "clarification_required", event.params);
			return;
		}
		if (terminalResult || !("client_turn_id" in event.params) || event.params.client_turn_id !== clientTurnId) return;
		if ("turn_id" in event.params && typeof event.params.turn_id === "string") turnId = event.params.turn_id;
		switch (event.method) {
			case "gateway.error": finish({ status: "failed", exit_code: 1, code: event.params.code, ...failureFacts(event.params) }); break;
			case "turn.started":
				options.emit({ type: "turn.started", session_id: sessionId, turn_id: turnId }); break;
			case "message.delta":
				options.emit({ type: "message.delta", text: event.params.text }); break;
			case "tool.start":
				options.emit({ type: "tool.started", name: event.params.name, call_id: event.params.call_id }); break;
			case "tool.complete":
			case "tool.failed":
				options.emit({ type: "tool.completed", name: event.params.name, call_id: event.params.call_id, success: event.params.success }); break;
			case "turn.completed": {
				if (event.params.turn_state !== "completed" || event.params.pending_decision) {
					interaction("interaction_required"); break;
				}
				if (Buffer.byteLength(event.params.assistant_message) > MAX_FINAL_BYTES) throw new HeadlessError("output_too_large");
				const usage = Object.fromEntries(Object.entries(event.params.usage).filter(
					(entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0,
				));
				finish({ status: "completed", exit_code: 0, final_message: event.params.assistant_message, usage }); break;
			}
			case "turn.failed": finish({ status: "failed", exit_code: 1, code: event.params.code, ...failureFacts(event.params) }); break;
			case "turn.interrupted": finish({ status: "interrupted", exit_code: 130, code: "interrupted", ...failureFacts(event.params) }); break;
			default: break;
		}
	};
	const client = new HeadlessGatewayClient(options.backend, options.signal, onEvent, rejectTerminal);
	try {
		await client.ready;
		const bootstrap = await client.bootstrap();
		if (typeof bootstrap.session_id !== "string" || !isObject(bootstrap.status)) throw new HeadlessError("bootstrap_invalid");
		sessionId = bootstrap.session_id;
		options.emit({ type: "session.started", session_id: sessionId, model: bootstrap.model });
		if (terminalResult) return { ...terminalResult, session_id: sessionId };
		const status = bootstrap.status;
		if (!isObject(status.trust) || status.trust.state !== "trusted") interaction("workspace_trust_required");
		else if (status.pending_decision === true || status.pending_clarification === true || status.suspended_turn === true
			|| status.has_pending_input === true || status.turn_running === true) interaction("session_recovery_required");
		if (terminalResult) return terminalResult;
		if (options.readOnly) await client.request("permissions.update", { profile: "read-only" });
		await client.request("turn.submit", {
			message: options.prompt, client_turn_id: clientTurnId, client_user_message_id: randomUUID(), collaboration_mode: "default",
		});
		return await terminal;
	} catch (error) {
		const failure = error instanceof HeadlessError ? error : new HeadlessError("execution_failed");
		return {
			status: failure.exitCode === 130 || failure.exitCode === 143 ? "interrupted" : "failed",
			exit_code: failure.exitCode, code: failure.code,
			...failureFacts({ error_context: failure.errorContext }),
			...(sessionId ? { session_id: sessionId } : {}), ...(turnId ? { turn_id: turnId } : {}),
		};
	} finally { client.close(); }
}

function failureFacts(params: Readonly<Record<string, unknown>>): Partial<HeadlessResult> {
	const context = readErrorContext(params.error_context);
	if (!context) return {};
	const details = errorPublicDetails(context);
	return { error_context: context, message: errorSummary(context),
		...(details ? { additional_details: details } : {}),
		...(Array.isArray(params.recovery_actions) ? { recovery_actions: params.recovery_actions.filter(isDiagnosticRecoveryActionId) } : {}),
	};
}

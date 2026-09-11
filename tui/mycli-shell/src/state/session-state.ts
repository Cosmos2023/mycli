import {
	authProvidersFromUnknown,
	credentialReadinessFromUnknown,
	modelCatalogFromPayload,
	runtimeStateWithCredentialReadiness,
	trustFromPayload,
} from "./catalog-state.ts";
import { runtimeStateWithStartupUpdate } from "./command-state.ts";
import { applyQueuePayload, runtimeStateWithLegacyQueueMigration } from "./input-queue.ts";
import {
	booleanValue,
	collaborationModeValue,
	generationValue,
	nextId,
	recordValue,
	stringValue,
} from "./payload-values.ts";
import { permissionStateFromUnknown } from "./permission-state.ts";
import { reduceRuntimeEvent } from "./runtime-event-reducer.ts";
import type { RuntimeShellState } from "./runtime-state-model.ts";
import { sessionChangeCanApply } from "./session-ownership.ts";
import { applyShellBootstrap } from "./transcript-shell.ts";

export function runtimeStateFromBootstrap(state: RuntimeShellState, payload: Record<string, unknown>): RuntimeShellState {
	const status = recordValue(payload.status);
	const turnRunning = booleanValue(status.turn_running) ?? false;
	const trust = trustFromPayload(payload.trust ?? status.trust, String(payload.workspace ?? state.workspace));
	const welcome = recordValue(payload.welcome);
	const startupMark = recordValue(welcome.startup_mark);
	const welcomeText = welcome
		? `${String(startupMark.text ?? "mycli")}\n${String(welcome.workspace ?? payload.workspace ?? "")}`.trim()
		: "mycli";
	const provider = stringValue(payload.provider) ?? state.provider;
	const model = stringValue(payload.model) ?? state.model;
	const models = modelCatalogFromPayload(payload)
		?? modelCatalogFromPayload(status)
		?? state.models;
	const bootstrapState = {
		...state,
		sessionId: stringValue(payload.session_id) ?? state.sessionId,
		sessionGeneration: generationValue(payload.generation)
			?? generationValue(status.generation)
			?? state.sessionGeneration,
		sessionTitle: stringValue(payload.session_title) ?? state.sessionTitle,
		workspace: stringValue(payload.workspace) ?? state.workspace,
		model,
		collaborationMode: collaborationModeValue(payload.collaboration_mode) ?? collaborationModeValue(status.collaboration_mode) ?? state.collaborationMode,
		provider,
		models,
		authProviders: authProvidersFromUnknown(payload.auth_providers),
		authReadiness: credentialReadinessFromUnknown(payload.auth_status) ?? state.authReadiness,
		permissions: permissionStateFromUnknown(payload.permissions ?? status.permissions) ?? state.permissions,
		status,
		trust,
		trustGateDismissed: trust.state === "trusted",
		turnRunning,
		activeTurnId: turnRunning ? stringValue(status.turn_id) : null,
		activeClientTurnId: turnRunning ? stringValue(status.client_turn_id) : null,
		activeAssistantItemId: turnRunning ? state.activeAssistantItemId : null,
		liveReasoning: turnRunning ? state.liveReasoning : null,
		transcript: [
			...state.transcript,
			{ id: "welcome", type: "system_notice", text: welcomeText, folded: false, metadata: welcome },
		],
	};
	const updateState = runtimeStateWithStartupUpdate(bootstrapState, payload.update);
	const nextState = applyQueuePayload(updateState, status, "status");
	return applyShellBootstrap(
		runtimeStateWithLegacyQueueMigration(nextState, payload),
		Array.isArray(payload.background_shells) ? payload.background_shells : status.background_shells,
	);
}

export function runtimeStateAfterSessionResume(
	state: RuntimeShellState,
	sessionId: string,
	sessionTitle: string,
	payload: Record<string, unknown>,
): RuntimeShellState {
	const generation = generationValue(payload.generation);
	if (!sessionChangeCanApply(state, sessionId, generation)) return state;
	const eventStatus = stringValue(state.status.session_id) === sessionId
		? state.status
		: {};
	const activationEventsAlreadyApplied = state.sessionId === sessionId
		&& (generation === null || state.sessionGeneration === generation);
	let nextState: RuntimeShellState = {
		...(activationEventsAlreadyApplied
			? { ...state, sessionTitle }
			: reduceRuntimeEvent(state, "session.changed", {
				session_id: sessionId,
				session_title: sessionTitle,
				...(generation !== null ? { generation } : {}),
			})),
		transcript: activationEventsAlreadyApplied ? state.transcript : [],
	};
	if (!activationEventsAlreadyApplied && Object.keys(eventStatus).length > 0) {
		nextState = reduceRuntimeEvent(nextState, "status.changed", eventStatus);
	}
	const backgroundShells = Array.isArray(payload.background_shells)
		? payload.background_shells
		: eventStatus.background_shells;
	nextState = applyShellBootstrap(nextState, backgroundShells);
	nextState = runtimeStateWithCredentialReadiness(nextState, payload);
	return runtimeStateWithLegacyQueueMigration(
		applyQueuePayload(nextState, payload, "event"),
		payload,
	);
}

export function runtimeStateWithSessionCommandNotice(
	state: RuntimeShellState,
	command: string,
	result: Record<string, unknown>,
): RuntimeShellState {
	const lines = Array.isArray(result.lines)
		? result.lines.filter((line): line is string => typeof line === "string")
		: [];
	const notice = lines.join("\n") || "Session changed.";
	return {
		...state,
		transcript: [
			...state.transcript,
			{
				id: nextId("session-notice"),
				type: "system_notice",
				text: notice,
				folded: false,
				metadata: { transient: true, command },
			},
		],
	};
}

import { StorageFailure } from "@mycli/storage";
import { SlashCommandError } from "./node-slash-command-registry.ts";
import { SessionServiceError } from "./session-service.ts";

type GatewayErrorData = Record<string, unknown>;

export class GatewayFailure extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly data: GatewayErrorData = {},
	) {
		super(message);
		this.name = "GatewayFailure";
	}
}

export function gatewayFailure(error: unknown): GatewayFailure {
	if (error instanceof GatewayFailure) return error;
	if (error instanceof SlashCommandError) {
		return new GatewayFailure(error.code, error.message);
	}
	if (error instanceof SessionServiceError) return sessionServiceFailure(error);
	if (isObject(error) && error.code === "model_catalog_error") {
		return new GatewayFailure(
			"model_catalog_error",
			"Model catalog could not be loaded.",
		);
	}
	if (isObject(error) && error.code === "session_state_invalid") {
		return new GatewayFailure("session_state_invalid", "Persisted session state is invalid.");
	}
	if (isObject(error) && error.code === "session_state_version_unsupported") {
		return new GatewayFailure(
			"session_state_version_unsupported",
			"Persisted session state version is unsupported.",
		);
	}
	if (isObject(error) && error.code === "session_not_found") {
		return new GatewayFailure("session_not_found", "Session was not found.");
	}
	if (isObject(error) && error.code === "session_in_use") {
		return new GatewayFailure(
			"session_in_use",
			"Session is already open in another mycli window.",
		);
	}
	if (isObject(error) && error.code === "session_metadata_conflict") {
		return new GatewayFailure(
			"session_changed",
			"Session metadata changed. Review the latest recovery options and try again.",
		);
	}
	if (isObject(error) && error.code === "turn_in_progress") {
		return new GatewayFailure("turn_in_progress", "A turn is already running.");
	}
	if (isObject(error) && error.code === "message_id_conflict") {
		return new GatewayFailure(
			"message_id_conflict",
			"client_turn_id already has a different payload.",
		);
	}
	if (isObject(error) && error.code === "invalid_params") {
		return new GatewayFailure("invalid_params", "Request parameters are invalid.");
	}
	if (error instanceof StorageFailure || (isObject(error) && error.code === "persistence_error")) {
		return new GatewayFailure("persistence_error", "Session persistence failed.");
	}
	if (isObject(error) && error.code === "queue_conflict") {
		return new GatewayFailure("queue_conflict", "Queued input conflicts with current state.");
	}
	if (isObject(error) && error.code === "queue_capacity") {
		return new GatewayFailure("queue_capacity", "Queued input exceeds the queue capacity.");
	}
	if (isObject(error) && error.code === "approval_not_pending") {
		return new GatewayFailure("approval_not_pending", "No pending approval is available.");
	}
	if (isObject(error) && error.code === "approval_conflict") {
		return new GatewayFailure("approval_conflict", "Approval state conflicts with the request.");
	}
	if (isObject(error) && error.code === "clarification_not_pending") {
		return new GatewayFailure(
			"clarification_not_pending",
			"No pending clarification is available.",
		);
	}
	return new GatewayFailure("internal_error", "Gateway request failed.");
}

function sessionServiceFailure(error: SessionServiceError): GatewayFailure {
	switch (error.code) {
		case "session_not_found":
			return new GatewayFailure("session_not_found", "Session was not found.");
		case "session_ambiguous":
			return new GatewayFailure("session_ambiguous", "More than one session has that title.");
		case "session_in_use":
			return new GatewayFailure("session_in_use", "Session is already open in another mycli window.");
		case "session_deleted":
			return new GatewayFailure("session_deleted", "Deleted sessions cannot be resumed or changed.");
		case "session_changed":
			return new GatewayFailure(
				"session_changed",
				"Session metadata changed. Review the latest recovery options and try again.",
			);
		case "repair_not_available":
			return new GatewayFailure(
				"repair_not_available",
				"The selected session recovery action is no longer available.",
			);
		case "repair_unavailable":
			return new GatewayFailure(
				"repair_unavailable",
				"The selected session recovery action cannot be completed in this workspace.",
			);
		case "repair_failed":
			return new GatewayFailure("repair_failed", "Session recovery could not be completed.");
		case "invalid_arguments":
			return new GatewayFailure("invalid_params", "Request parameters are invalid.");
		default:
			return new GatewayFailure("internal_error", "Gateway request failed.");
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

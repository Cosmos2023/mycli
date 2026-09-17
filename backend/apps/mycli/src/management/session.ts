import {
	SessionServiceError,
	type SessionService,
	type SessionExport,
	type SessionSummary,
} from "../node-runtime/session-service.ts";
import type {
	ManagementResponse,
	SessionManagementCommand,
} from "./types.ts";
import { TrainingExportError } from "../node-runtime/session-training-export.ts";
import type { TrainingExportHandler, TrainingExportResult } from "../node-runtime/session-training-export.ts";

export interface SessionManagementResponse extends ManagementResponse {
	readonly sessions?: readonly SessionSummary[];
	readonly session?: SessionSummary;
	readonly exportedSession?: SessionExport;
	readonly trainingExport?: TrainingExportResult;
}

export class SessionManagementService {
	readonly #sessions: SessionService;

	constructor(sessions: SessionService, readonly exportTraining?: TrainingExportHandler) {
		this.#sessions = sessions;
	}

	async execute(command: SessionManagementCommand, signal: AbortSignal = new AbortController().signal): Promise<SessionManagementResponse> {
		try {
			signal.throwIfAborted();
			return await this.#execute(command, signal);
		} catch (error) {
			if (error instanceof SessionServiceError || error instanceof TrainingExportError) {
				return failure(command.action, error.message, error.code);
			}
			throw error;
		}
	}

	async #execute(command: SessionManagementCommand, signal: AbortSignal): Promise<SessionManagementResponse> {
		if (command.action === "list") {
			const sessions = this.#sessions.list({
				...(command.workspaceRoot ? { workspaceRoot: command.workspaceRoot } : {}),
				...(command.search ? { search: command.search } : {}),
				...(command.model ? { model: command.model } : {}),
				...(command.collaborationMode
					? { collaborationMode: command.collaborationMode }
					: {}),
				...(command.permissionProfile
					? { permissionProfile: command.permissionProfile }
					: {}),
				...(command.status ? { lifecycleStatus: command.status } : {}),
				includeArchived: command.all,
				includeDeleted: command.all,
				limit: command.last ? 1 : command.limit ?? 20,
			});
			return Object.freeze({
				ok: true,
				action: command.action,
				message: sessions.length > 0 ? `${sessions.length} session(s)` : "no sessions found",
				sessions,
			});
		}
		const source = this.#sessions.resolve(command.sessionId);
		if (command.action === "fork") {
			return success(command.action, this.#sessions.fork(source.id, command.targetSessionId));
		}
		if (command.action === "rename") {
			return success(command.action, this.#sessions.rename(source.id, command.title));
		}
		if (command.action === "archive") {
			return success(command.action, this.#sessions.archive(source.id));
		}
		if (command.action === "unarchive") {
			return success(command.action, this.#sessions.archive(source.id, false));
		}
		if (command.action === "delete") {
			if (!command.force) {
				return failure(
					command.action,
					"session delete requires --force",
					"confirmation_required",
				);
			}
			return success(command.action, this.#sessions.delete(source.id));
		}
		if (command.action === "export" && command.training) {
			if (!this.exportTraining) return failure(command.action, "Training export is unavailable.", "management_unavailable");
			const trainingExport = await this.exportTraining(source, command.training, signal);
			return { ok: true, action: command.action, message: `exported one conversation with ${trainingExport.report.messages} message(s)`, trainingExport };
		}
		const exportedSession = this.#sessions.export(source.id);
		return Object.freeze({
			ok: true,
			action: command.action,
			message: `exported session ${source.id}`,
			session: source,
			exportedSession,
		});
	}
}

function success(action: string, session: SessionSummary): SessionManagementResponse {
	return Object.freeze({
		ok: true,
		action,
		message: `${action} session ${session.id}`,
		session,
	});
}

function failure(action: string, message: string, issue: string): SessionManagementResponse {
	return Object.freeze({
		ok: false,
		action,
		message,
		issues: Object.freeze([issue]),
	});
}

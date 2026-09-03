import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
	findModelCatalogEntry,
	type ManagedExecutionPolicyConstraints,
	type ModelCatalogEntry,
} from "@mycli/config";
import type { ReasoningEffort } from "@mycli/core";
import type {
	RuntimeSessionStore,
	SessionLeaseState,
	SessionOverview,
	SessionPendingState,
} from "@mycli/storage";
import type { PermissionProfile } from "@mycli/tools";
import {
	parseSessionPreferences,
	saveSessionPreferences,
	sessionPreferencesFromConfig,
	type SessionPreferenceConfig,
	type SessionPreferences,
} from "./session-preferences.ts";

const SESSION_QUERY_LIMIT = 1_000;
const SESSION_EXPORT_ITEM_LIMIT = 200;
const SESSION_EXPORT_TEXT_LIMIT = 200_000;

export type SessionLifecycleStatus =
	| "active"
	| "archived"
	| "deleted"
	| "waiting_approval"
	| "waiting_clarification"
	| "interrupted";

export interface SessionSummary {
	readonly version: 1;
	readonly id: string;
	readonly title?: string;
	readonly cwd: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly lastActiveAt: string;
	readonly model: string;
	readonly provider: string;
	readonly reasoningEffort: ReasoningEffort;
	readonly collaborationMode: "default" | "plan";
	readonly permissionProfile: PermissionProfile;
	readonly lifecycleStatus: SessionLifecycleStatus;
	readonly storageStatus: string;
	readonly messageCount: number;
	readonly summaryCount: number;
	readonly metadataRevision: number;
	readonly leaseState: SessionLeaseState;
	readonly pendingState: SessionPendingState;
	readonly parentId?: string;
	readonly forkPoint?: number;
	readonly preferenceIssue?: "session_state_invalid";
	readonly metadataIssue?: "session_state_invalid" | "session_state_version_unsupported";
}

export interface SessionQuery {
	readonly workspaceRoot?: string;
	readonly search?: string;
	readonly model?: string;
	readonly collaborationMode?: "default" | "plan";
	readonly permissionProfile?: PermissionProfile;
	readonly lifecycleStatus?: SessionLifecycleStatus;
	readonly includeArchived?: boolean;
	readonly includeDeleted?: boolean;
	readonly limit?: number;
	readonly offset?: number;
}

export type ResumeRepairIssueCode =
	| "missing_workspace"
	| "missing_credential"
	| "unsupported_model"
	| "permission_override"
	| "active_owner"
	| "stale_owner"
	| "schema_incompatible"
	| "pending_interaction"
	| "archived_session"
	| "deleted_session";

export interface ResumeRepairIssue {
	readonly code: ResumeRepairIssueCode;
	readonly blocking: boolean;
	readonly message: string;
	readonly action?: ResumeRepairAction;
}

export type ResumeRepairAction =
	| "takeover_stale_owner"
	| "unarchive"
	| "fork_with_current_settings";

export interface ResumeRepairPreview {
	readonly version: 1;
	readonly session: SessionSummary;
	readonly ready: boolean;
	readonly requiresConfirmation: boolean;
	readonly issues: readonly ResumeRepairIssue[];
	readonly actions: readonly ResumeRepairAction[];
}

export interface ApplyResumeRepairInput {
	readonly sessionId: string;
	readonly expectedMetadataRevision: number;
	readonly action: ResumeRepairAction;
}

export interface ApplyResumeRepairResult {
	readonly sourceSessionId: string;
	readonly sessionId: string;
	readonly forked: boolean;
	readonly summary: SessionSummary;
}

export interface SessionExport {
	readonly version: 1;
	readonly exportedAt: string;
	readonly session: SessionSummary;
	readonly messages: readonly {
		readonly type: "user_message" | "assistant_message";
		readonly text: string;
		readonly createdAt?: string;
	}[];
	readonly truncated: boolean;
}

export interface SessionServiceOptions {
	readonly store: RuntimeSessionStore;
	readonly currentConfig: () => SessionPreferenceConfig;
	readonly currentPermissionProfile?: () => PermissionProfile;
	readonly loadModelCatalog: (
		preferences: SessionPreferences,
		workspaceRoot: string,
		sessionId: string,
	) => Promise<readonly ModelCatalogEntry[]>;
	readonly hasCredential: (preferences: SessionPreferences) => boolean | Promise<boolean>;
	readonly managedExecutionPolicy?: ManagedExecutionPolicyConstraints;
	readonly workspaceAvailable?: (workspaceRoot: string) => boolean;
	readonly createSessionId?: () => string;
	readonly clock?: () => string;
}

export class SessionServiceError extends Error {
	constructor(readonly code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "SessionServiceError";
	}
}

export class SessionService {
	readonly #options: SessionServiceOptions;

	constructor(options: SessionServiceOptions) {
		this.#options = options;
	}

	list(query: SessionQuery = {}): readonly SessionSummary[] {
		const page = sessionPage(query);
		const overviews = this.#options.store.listSessions({
			...(query.workspaceRoot ? { workspaceRoot: query.workspaceRoot } : {}),
			...(query.search ? { search: query.search } : {}),
			includeArchived: true,
			includeDeleted: true,
			limit: SESSION_QUERY_LIMIT,
		});
		const preferences = this.#preferencesBySession(overviews.map((item) => item.sessionId));
		return Object.freeze(overviews
			.map((overview) => this.#summary(overview, preferences.get(overview.sessionId)))
			.filter((summary) => sessionVisible(summary, query))
			.slice(page.offset, page.offset + page.limit));
	}

	load(sessionId: string): SessionSummary {
		const summary = this.inspect(sessionId);
		if (!summary) throw new SessionServiceError("session_not_found", "session does not exist");
		return summary;
	}

	inspect(sessionId: string): SessionSummary | undefined {
		const id = boundedIdentity(sessionId, "session id");
		const overview = this.#options.store.loadSession(id);
		if (!overview) return undefined;
		return this.#summary(overview, this.#preferencesBySession([id]).get(id));
	}

	resolve(reference: string): SessionSummary {
		const normalized = boundedIdentity(reference, "session reference");
		const direct = this.#options.store.loadSession(normalized);
		if (direct) return this.load(normalized);
		const matches = this.list({ includeArchived: true, includeDeleted: true, limit: SESSION_QUERY_LIMIT })
			.filter((summary) => summary.title === normalized);
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) {
			throw new SessionServiceError("session_ambiguous", "more than one session has that title");
		}
		throw new SessionServiceError("session_not_found", "session does not exist");
	}

	rename(sessionId: string, title: string): SessionSummary {
		const current = this.load(sessionId);
		assertMutable(current, "rename", true);
		this.#options.store.updateSessionMetadata({
			sessionId: current.id,
			expectedRevision: current.metadataRevision,
			title,
		});
		return this.load(current.id);
	}

	archive(sessionId: string, archived = true): SessionSummary {
		const current = this.load(sessionId);
		assertMutable(current, archived ? "archive" : "unarchive", !archived);
		this.#options.store.updateSessionMetadata({
			sessionId: current.id,
			expectedRevision: current.metadataRevision,
			archived,
		});
		return this.load(current.id);
	}

	delete(sessionId: string): SessionSummary {
		const current = this.load(sessionId);
		assertMutable(current, "delete", false);
		this.#options.store.updateSessionMetadata({
			sessionId: current.id,
			expectedRevision: current.metadataRevision,
			deleted: true,
		});
		return this.load(current.id);
	}

	fork(sessionId: string, targetSessionId = this.#createSessionId()): SessionSummary {
		const source = this.load(sessionId);
		if (source.lifecycleStatus === "deleted") {
			throw new SessionServiceError("session_deleted", "deleted sessions cannot be forked");
		}
		this.#options.store.forkSession({
			sourceSessionId: source.id,
			targetSessionId: boundedIdentity(targetSessionId, "target session id"),
		});
		return this.load(targetSessionId);
	}

	async previewResume(sessionId: string): Promise<ResumeRepairPreview> {
		const session = this.load(sessionId);
		const preferences = this.#preferencesBySession([session.id]).get(session.id)?.preferences;
		const issues: ResumeRepairIssue[] = [];
		if (session.lifecycleStatus === "deleted") {
			issues.push(issue("deleted_session", true, "The session was deleted."));
		} else if (session.lifecycleStatus === "archived") {
			issues.push(issue(
				"archived_session",
				true,
				"The session is archived.",
				"unarchive",
			));
		}
		if (session.metadataIssue || session.preferenceIssue) {
			issues.push(issue(
				"schema_incompatible",
				true,
				"Persisted session settings are not compatible with this mycli version.",
			));
		}
		if (!this.#workspaceAvailable(session.cwd)) {
			issues.push(issue(
				"missing_workspace",
				true,
				"The saved workspace is no longer available.",
				"fork_with_current_settings",
			));
		}
		if (preferences) {
			const catalog = await this.#options.loadModelCatalog(
				preferences,
				session.cwd,
				session.id,
			);
			if (!findModelCatalogEntry(catalog, {
				provider: preferences.provider,
				protocol: preferences.protocol,
				model: preferences.model,
				baseUrl: preferences.apiBaseUrl,
			})) {
				issues.push(issue(
					"unsupported_model",
					true,
					"The saved model is no longer available.",
					"fork_with_current_settings",
				));
			}
			if (!await this.#options.hasCredential(preferences)) {
				issues.push(issue(
					"missing_credential",
					true,
					"The saved credential is no longer available.",
					"fork_with_current_settings",
				));
			}
			if (permissionConflicts(
				preferences.permissionProfile,
				this.#options.managedExecutionPolicy,
			)) {
				issues.push(issue(
					"permission_override",
					true,
					"Managed policy no longer permits the saved permission profile.",
					"fork_with_current_settings",
				));
			}
		}
		if (session.leaseState === "active") {
			issues.push(issue("active_owner", true, "The session is active in another process."));
		} else if (session.leaseState === "stale") {
			issues.push(issue(
				"stale_owner",
				true,
				"The previous session owner is no longer running.",
				"takeover_stale_owner",
			));
		}
		if (session.pendingState !== "none") {
			issues.push(issue(
				"pending_interaction",
				false,
				pendingInteractionMessage(session.pendingState),
			));
		}
		const actions = Object.freeze([...new Set(issues.flatMap((item) => item.action ? [item.action] : []))]);
		return Object.freeze({
			version: 1 as const,
			session,
			ready: !issues.some((item) => item.blocking),
			requiresConfirmation: issues.some((item) => item.blocking && item.action !== undefined),
			issues: Object.freeze(issues),
			actions,
		});
	}

	async applyResumeRepair(input: ApplyResumeRepairInput): Promise<ApplyResumeRepairResult> {
		const preview = await this.previewResume(input.sessionId);
		if (preview.session.metadataRevision !== input.expectedMetadataRevision) {
			throw new SessionServiceError("session_changed", "session metadata changed after preview");
		}
		if (!preview.actions.includes(input.action)) {
			throw new SessionServiceError("repair_not_available", "selected repair is not available");
		}
		if (input.action === "takeover_stale_owner") {
			return Object.freeze({
				sourceSessionId: preview.session.id,
				sessionId: preview.session.id,
				forked: false,
				summary: preview.session,
			});
		}
		if (input.action === "unarchive") {
			const summary = this.archive(preview.session.id, false);
			return Object.freeze({
				sourceSessionId: preview.session.id,
				sessionId: summary.id,
				forked: false,
				summary,
			});
		}
		const config = this.#options.currentConfig();
		if (!this.#workspaceAvailable(config.workspaceRoot)) {
			throw new SessionServiceError("repair_unavailable", "current workspace is not available");
		}
		const targetSessionId = this.#createSessionId();
		this.#options.store.forkSession({
			sourceSessionId: preview.session.id,
			targetSessionId,
			targetWorkspaceRoot: config.workspaceRoot,
		});
		const target = this.#options.store.loadSession(targetSessionId);
		if (!target) throw new SessionServiceError("repair_failed", "recovery fork was not created");
		saveSessionPreferences(this.#options.store, {
			sessionId: targetSessionId,
			workspaceRoot: target.workspaceRoot,
			threadId: target.threadId,
			preferences: sessionPreferencesFromConfig(
				config,
				"default",
				this.#currentPermissionProfile(),
			),
		});
		this.#options.store.updateSessionMetadata({
			sessionId: targetSessionId,
			expectedRevision: 0,
			title: recoveredTitle(preview.session),
		});
		return Object.freeze({
			sourceSessionId: preview.session.id,
			sessionId: targetSessionId,
			forked: true,
			summary: this.load(targetSessionId),
		});
	}

	export(sessionId: string): SessionExport {
		const session = this.load(sessionId);
		const items = this.#options.store.loadRecentReadableTranscript(session.id);
		const messages: {
			type: "user_message" | "assistant_message";
			text: string;
			createdAt?: string;
		}[] = [];
		let retainedChars = 0;
		let truncated = false;
		for (const item of items) {
			if (item.type !== "user_message" && item.type !== "assistant_message") continue;
			if (typeof item.text !== "string" || !item.text) continue;
			if (messages.length >= SESSION_EXPORT_ITEM_LIMIT
				|| retainedChars + item.text.length > SESSION_EXPORT_TEXT_LIMIT) {
				truncated = true;
				break;
			}
			messages.push({
				type: item.type,
				text: item.text,
				...(item.created_at ? { createdAt: item.created_at } : {}),
			});
			retainedChars += item.text.length;
		}
		return Object.freeze({
			version: 1 as const,
			exportedAt: (this.#options.clock ?? (() => new Date().toISOString()))(),
			session,
			messages: Object.freeze(messages),
			truncated,
		});
	}

	#summary(
		overview: SessionOverview,
		preferenceResult: PreferenceResult | undefined,
	): SessionSummary {
		const config = this.#options.currentConfig();
		const preferences = preferenceResult?.preferences;
		return Object.freeze({
			version: 1 as const,
			id: overview.sessionId,
			...(overview.title ? { title: overview.title } : {}),
			cwd: overview.workspaceRoot,
			createdAt: overview.createdAt,
			updatedAt: overview.updatedAt,
			lastActiveAt: overview.lastActiveAt,
			model: preferences?.model ?? config.model,
			provider: preferences?.provider ?? config.provider,
			reasoningEffort: preferences?.reasoningEffort
				?? (config.thinkingEnabled ? config.reasoningEffort : "none"),
			collaborationMode: preferences?.collaborationMode ?? "default",
			permissionProfile: preferences?.permissionProfile ?? this.#currentPermissionProfile(),
			lifecycleStatus: lifecycleStatus(overview),
			storageStatus: overview.status,
			messageCount: overview.messageCount,
			summaryCount: overview.summaryCount,
			metadataRevision: overview.metadataRevision ?? 0,
			leaseState: overview.leaseState ?? "unlocked",
			pendingState: overview.pendingState ?? "none",
			...(overview.parentId ? { parentId: overview.parentId } : {}),
			...(overview.forkPoint === undefined ? {} : { forkPoint: overview.forkPoint }),
			...(preferenceResult?.issue ? { preferenceIssue: preferenceResult.issue } : {}),
			...(overview.metadataIssue ? { metadataIssue: overview.metadataIssue } : {}),
		});
	}

	#preferencesBySession(sessionIds: readonly string[]): ReadonlyMap<string, PreferenceResult> {
		const rows = this.#options.store.loadStates(sessionIds, ["session_preferences"]);
		return new Map<string, PreferenceResult>(rows.map((row): readonly [string, PreferenceResult] => {
			try {
				return [row.sessionId, Object.freeze({
					preferences: parseSessionPreferences(row.payload),
				})] as const;
			} catch {
				return [row.sessionId, Object.freeze({
					issue: "session_state_invalid" as const,
				})] as const;
			}
		}));
	}

	#currentPermissionProfile(): PermissionProfile {
		return this.#options.currentPermissionProfile?.() ?? "workspace";
	}

	#workspaceAvailable(workspaceRoot: string): boolean {
		return (this.#options.workspaceAvailable ?? defaultWorkspaceAvailable)(workspaceRoot);
	}

	#createSessionId(): string {
		return boundedIdentity(
			(this.#options.createSessionId ?? (() => randomUUID()))(),
			"generated session id",
		);
	}
}

interface PreferenceResult {
	readonly preferences?: SessionPreferences;
	readonly issue?: "session_state_invalid";
}

function lifecycleStatus(overview: SessionOverview): SessionLifecycleStatus {
	if (overview.deleted) return "deleted";
	if (overview.archived) return "archived";
	if (overview.pendingState === "approval") return "waiting_approval";
	if (overview.pendingState === "clarification") return "waiting_clarification";
	if (overview.pendingState === "interrupted") return "interrupted";
	return "active";
}

function sessionVisible(summary: SessionSummary, query: SessionQuery): boolean {
	if (!query.includeDeleted && summary.lifecycleStatus === "deleted") return false;
	if (!query.includeArchived && summary.lifecycleStatus === "archived") return false;
	if (query.model && summary.model !== query.model) return false;
	if (query.collaborationMode && summary.collaborationMode !== query.collaborationMode) return false;
	if (query.permissionProfile && summary.permissionProfile !== query.permissionProfile) return false;
	if (query.lifecycleStatus && summary.lifecycleStatus !== query.lifecycleStatus) return false;
	return true;
}

function sessionPage(query: SessionQuery): { readonly limit: number; readonly offset: number } {
	const limit = query.limit ?? 20;
	const offset = query.offset ?? 0;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
		throw new SessionServiceError("invalid_arguments", "session limit must be between 1 and 200");
	}
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > SESSION_QUERY_LIMIT) {
		throw new SessionServiceError("invalid_arguments", "session offset is out of range");
	}
	return Object.freeze({ limit, offset });
}

function assertMutable(
	session: SessionSummary,
	action: string,
	allowOwned: boolean,
): void {
	if (session.lifecycleStatus === "deleted" && action !== "unarchive") {
		throw new SessionServiceError("session_deleted", `cannot ${action} a deleted session`);
	}
	if (session.leaseState === "active" || (!allowOwned && session.leaseState === "owned")) {
		throw new SessionServiceError("session_in_use", `cannot ${action} a session owned by a runtime`);
	}
}

function issue(
	code: ResumeRepairIssueCode,
	blocking: boolean,
	message: string,
	action?: ResumeRepairAction,
): ResumeRepairIssue {
	return Object.freeze({ code, blocking, message, ...(action ? { action } : {}) });
}

function pendingInteractionMessage(state: SessionPendingState): string {
	if (state === "approval") return "The session has a pending approval.";
	if (state === "clarification") return "The session has a pending question.";
	return "The previous turn was interrupted and can be continued.";
}

function permissionConflicts(
	profile: PermissionProfile | undefined,
	managed: ManagedExecutionPolicyConstraints | undefined,
): boolean {
	if (!profile || !managed) return false;
	if (profile === "full-access") return true;
	return profile === "workspace"
		&& managed.writableRoots !== undefined
		&& managed.writableRoots.length === 0;
}

function defaultWorkspaceAvailable(workspaceRoot: string): boolean {
	try {
		return existsSync(workspaceRoot) && statSync(workspaceRoot).isDirectory();
	} catch {
		return false;
	}
}

function recoveredTitle(session: SessionSummary): string {
	const base = session.title?.trim() || session.id;
	return `${base.slice(0, 244)} (recovered)`;
}

function boundedIdentity(value: unknown, label: string): string {
	if (typeof value !== "string") throw new SessionServiceError("invalid_arguments", `${label} is invalid`);
	const normalized = value.trim();
	if (!normalized || normalized.length > 512 || /[\r\n\0]/u.test(normalized)) {
		throw new SessionServiceError("invalid_arguments", `${label} is invalid`);
	}
	return normalized;
}

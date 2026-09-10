import {
	gatewayContractCatalog,
	createErrorContext,
	errorDefinition,
	errorSummary,
	legacyGatewayReason,
	projectGatewayErrorPayload,
	projectGatewayErrorData,
	isGatewayErrorCode,
	readErrorContext,
	DIAGNOSTIC_RECOVERY_ACTION_IDS,
	slashCommandArguments,
} from "@mycli/contracts";
import { loadGatewayProviderAttempts } from "./node-gateway-provider-attempts.ts";
import type {
	RuntimeTurnRecord,
} from "@mycli/contracts";
import {
	type ReasoningEffort,
} from "@mycli/core";
import type { TranscriptItem } from "@mycli/storage";
import { DEFAULT_GATEWAY_LIMITS, type GatewayTransport } from "@mycli/gateway";
import { resolveErrorRecovery } from "@mycli/runtime";
import { projectGatewayToolRecord, type GatewayTranscriptItem, type GatewayResult } from "@mycli/contracts";
import {
	builtinCommandRoutingNames,
	commandDiscoveryManifest,
	commandManifest,
	resolveSlashCommand,
	SlashCommandError,
	type SlashCommandSurface,
} from "./node-slash-command-registry.ts";
import {
	diagnosticCommandResult,
	errorCommandResult,
	listCommandResult,
	noticeCommandResult,
	preformattedCommandResult,
	statusCommandResult,
} from "./node-slash-command-results.ts";
import { extractProposedPlan } from "./proposed-plan.ts";
import {
	GatewayFailure,
	gatewayFailure,
	gatewayFailureDiagnostic,
	gatewayRequestOccurrenceId,
} from "./node-gateway-errors.ts";
import { MYCLI_VERSION } from "../version.ts";
import {
	NodeGatewayEventProjector,
	type GatewayEventMethod,
	type RuntimeGatewayEventMethod,
} from "./node-gateway-event-projector.ts";
import {
	NodeGatewayRpcTransport,
	type NodeGatewayRpcFailure,
	type NodeGatewayRpcRequest,
} from "./node-gateway-rpc-transport.ts";
import { NodeGatewaySessionController } from "./node-gateway-session-controller.ts";
import {
	gatewayQueueItem,
	legacyMigrationRecord,
	NodeGatewayTurnController,
	queueEventPayload,
} from "./node-gateway-turn-controller.ts";
import {
	approvalRequestPayload,
	clarificationRequestPayload,
	NodeGatewayInteractiveController,
} from "./node-gateway-interactive-controller.ts";
import { NodeGatewayShellController } from "./node-gateway-shell-controller.ts";
import {
	cachedUpdateStatusPayload,
	credentialReadinessPayload,
	NodeGatewaySettingsController,
	sandboxForPermission as settingsSandboxForPermission,
} from "./node-gateway-settings-controller.ts";
import { requiredTrimmedString as requiredString } from "./node-gateway-validation.ts";
import type {
	CreateNodeGatewayOptions,
	NodeGateway,
	NodeGatewayCompactionResult,
	NodeGatewayIntegrations,
} from "./node-gateway-types.ts";
export type {
	CreateNodeGatewayOptions,
	CredentialReadinessSource,
	NodeGateway,
	NodeGatewayBackgroundTaskCommands,
	NodeGatewayCompactionResult,
	NodeGatewayControlCommands,
	NodeGatewayCredentialReadiness,
	NodeGatewayFileHistoryCommands,
	NodeGatewayIntegrationCommands,
	NodeGatewayIntegrations,
	NodeGatewayMemoryCommands,
	NodeGatewayRuntime,
	NodeGatewaySessionCommands,
	NodeGatewayTraceCommands,
	NodeGatewayUpdateCommands,
} from "./node-gateway-types.ts";

type JsonObject = Record<string, unknown>;
const TRANSCRIPT_PAGE_MAX_BYTES = Math.floor(DEFAULT_GATEWAY_LIMITS.maxFrameBytes * 0.75);

class InProcessNodeGateway implements NodeGateway {
	readonly transport: GatewayTransport;
	readonly completion: Promise<number>;
	readonly #options: CreateNodeGatewayOptions;
	readonly #rpcTransport: NodeGatewayRpcTransport;
	readonly #eventProjector: NodeGatewayEventProjector;
	readonly #interactiveController: NodeGatewayInteractiveController;
	readonly #sessionController: NodeGatewaySessionController;
	readonly #turnController: NodeGatewayTurnController;
	readonly #shellController: NodeGatewayShellController;
	readonly #settingsController: NodeGatewaySettingsController;
	readonly #resolveCompletion: (code: number) => void;
	#closed = false;
	#errorContextVersion: 1 | undefined;
	#closePromise: Promise<void> | null = null;
	#manualCompaction: { readonly controller: AbortController; readonly task: Promise<NodeGatewayCompactionResult> } | null = null;
	#unsubscribeSubagents: (() => void) | null = null;
	#unsubscribeExtensions: (() => void) | null = null;
	#unsubscribeAgentInteractiveRequests: (() => void) | null = null;
	readonly #closeAfterResponses = new WeakSet<JsonObject>();

	constructor(options: CreateNodeGatewayOptions) {
		this.#options = options;
		let resolveCompletion!: (code: number) => void;
		this.completion = new Promise<number>((resolve) => { resolveCompletion = resolve; });
		this.#resolveCompletion = resolveCompletion;
		this.#eventProjector = new NodeGatewayEventProjector({
			errorContextVersion: () => this.#errorContextVersion,
			clock: options.clock ?? (() => Date.now() / 1000),
			currentOwnership: (_method, params) => this.#turnController.currentOwnership(params),
			write: (notification) => { this.#rpcTransport.writeNotification(notification); },
		});
		this.#interactiveController = new NodeGatewayInteractiveController({
			publish: (method, params, ownership) => {
				this.#eventProjector.emitRuntime(method, params, ownership);
			},
		});
		this.#sessionController = new NodeGatewaySessionController({
			initialSessionId: options.sessionId,
			initialWorkspaceRoot: options.workspaceRoot,
			initialRuntime: options.runtime,
			...(options.sessionCoordinator ? { coordinator: options.sessionCoordinator } : {}),
			...(options.sessionCommands ? { commands: options.sessionCommands } : {}),
			isClosed: () => this.#closed,
			hasActiveTurn: () => this.#turnController.hasActiveTurn(),
			isTurnAdmissionPending: () => this.#turnController.isAdmissionPending(),
			hasPendingInteractiveRequest: () => this.#interactiveController.hasPending(),
			hasPendingAgentRequest: () =>
				(this.#options.agentInteractiveRequests?.pending().length ?? 0) > 0,
			activateSettings: (workspaceRoot, runtime) =>
				this.#settingsController.activateSession(workspaceRoot, runtime),
			activeShellPayloads: () => this.#shellController.activePayloads(),
			authProviders: () => this.#settingsController.authProviders(),
			credentialReadiness: () => this.#settingsController.credentialReadiness(),
			status: () => this.#status(),
			queuePayload: queueEventPayload,
			publish: (method, params) => { this.#emitRuntime(method, params); },
			publishDirect: (method, params) => { this.#emitDirect(method, params); },
			requestNextQueuedTurn: () => { this.#turnController.requestNextQueuedTurn(); },
		});
		this.#settingsController = new NodeGatewaySettingsController({
			provider: options.provider,
			model: options.model,
			...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
			...(options.updateStatus ? { updateStatus: options.updateStatus } : {}),
			...(options.sandboxReadiness ? { sandboxReadiness: options.sandboxReadiness } : {}),
			...(options.controlCommands ? { controlCommands: options.controlCommands } : {}),
			...(options.updateCommands ? { updateCommands: options.updateCommands } : {}),
			...(options.workspaceTrust ? { workspaceTrust: options.workspaceTrust } : {}),
			integrationsAvailable: options.integrations?.listResources !== undefined,
			runtime: () => this.#sessionController.runtime(),
			workspaceRoot: () => this.#sessionController.workspaceRoot(),
			claimSessionControl: (message) => this.#sessionController.claimControl(message),
			status: () => this.#status(),
			contextWindow: () => this.#turnController.contextWindow(),
			publish: (method, params) => { this.#emitRuntime(method, params); },
		});
		this.#turnController = new NodeGatewayTurnController({
			dependencies: options,
			session: this.#sessionController,
			settings: this.#settingsController,
			isClosed: () => this.#closed,
			status: () => this.#status(),
			publish: (method, params) => { this.#emitRuntime(method, params); },
		});
		this.#shellController = new NodeGatewayShellController({
			manager: options.shellManager,
			lifecycle: options.shellLifecycle,
			loadOutput: options.loadShellOutput,
			context: () => this.#sessionController.context(),
			isClosed: () => this.#closed,
			publish: (method, params) => { this.#emitRuntime(method, params); },
		});
		this.#rpcTransport = new NodeGatewayRpcTransport({
			projectResult: (method, result) => projectGatewayErrorPayload(method, result, this.#errorContextVersion === 1 ? "read" : "legacy") as JsonObject,
			dispatch: (request) => this.#handleRequest(request),
			mapFailure: (request, error) => this.#mapRpcFailure(request, error),
			onRequestFailed: (request, failure) => {
				this.#projectRequestFailure(request, failure);
			},
			shouldCloseAfterResponse: (request, result) => request.method === "shutdown"
				|| this.#closeAfterResponses.has(result),
			close: () => this.close(),
		});
		this.transport = this.#rpcTransport.transport;
		this.#sessionController.bindQueue();
		this.#bindSubagents();
		this.#bindExtensions();
		this.#bindAgentInteractiveRequests();
		this.#emitDirect("runtime.ready", { session_id: this.#sessionController.sessionId() });
		this.#turnController.requestNextQueuedTurn();
	}

	close(): Promise<void> {
		this.#closePromise ??= (async () => {
			if (this.#closed) return;
			this.#closed = true;
			const manualCompaction = this.#manualCompaction;
			manualCompaction?.controller.abort();
			this.#sessionController.close();
			this.#shellController.close();
				this.#unsubscribeSubagents?.();
				this.#unsubscribeSubagents = null;
				this.#unsubscribeExtensions?.();
				this.#unsubscribeExtensions = null;
			this.#unsubscribeAgentInteractiveRequests?.();
			this.#unsubscribeAgentInteractiveRequests = null;
			this.#interactiveController.clear();
			let exitCode = 0;
			try {
				await this.#turnController.close();
				await manualCompaction?.task.catch(() => undefined);
				await this.#options.close();
			} catch {
				exitCode = 1;
			} finally {
				if (!await this.#rpcTransport.close()) exitCode = 1;
				this.#resolveCompletion(exitCode);
			}
		})();
		return this.#closePromise;
	}

	kill(): void {
		void this.close();
	}

	diagnostic(): string {
		return this.#rpcTransport.diagnostic();
	}

	publishRecoveredInterrupt(record: RuntimeTurnRecord, options: {
		readonly inputRolledBack?: boolean;
	} = {}): void {
		this.#turnController.publishRecoveredInterrupt(record, options);
	}

	#handleRequest(request: NodeGatewayRpcRequest): JsonObject | Promise<JsonObject> {
		switch (request.method) {
			case "initialize":
				return this.#bootstrap(
					{ ...request.params, protocol_version: request.params.protocol_version ?? 1 },
					false,
				);
			case "status.get":
			case "status.inspect":
				return this.#status();
			case "workspace.trust.status":
				return this.#settingsController.trustStatus();
			case "workspace.trust.set":
				return this.#settingsController.setWorkspaceTrust(request.params);
			case "permissions.list":
				return this.#settingsController.permissions();
			case "permissions.update":
				return this.#settingsController.updatePermissions(request.params);
			case "extension.manifest":
				return extensionManifest(
					this.#options.integrations?.toolNames?.() ?? this.#options.toolNames ?? [],
					integrationToolManifest(this.#options.integrations),
				);
			case "resource.list":
				return this.#resourceList();
			case "session.bootstrap":
				return this.#bootstrap(request.params, true);
			case "transcript.load":
				return this.#transcript(request.params);
			case "provider.attempts.load":
				return loadGatewayProviderAttempts(this.#options.loadProviderAttempts, {
					sessionId: optionalString(request.params.session_id) ?? this.#sessionController.sessionId(),
					...(typeof request.params.turn_id === "string" ? { turnId: request.params.turn_id } : {}),
					...(typeof request.params.request_id === "string" ? { requestId: request.params.request_id } : {}),
					...(typeof request.params.after_sequence === "number" ? { afterSequence: request.params.after_sequence } : {}),
					...(typeof request.params.before_event_id === "string" ? { beforeEventId: request.params.before_event_id } : {}),
					...(typeof request.params.limit === "number" ? { limit: request.params.limit } : {}),
				});
			case "command.list":
				return this.#commandList(request.params);
			case "command.run":
				return this.#commandRun(request.params);
			case "completion.slash":
				return this.#completeSlash(request.params);
			case "completion.path":
				return this.#completePath(request.params);
			case "auth.api_key.save":
				return this.#settingsController.saveApiKey(request.params);
			case "provider.list":
				return this.#settingsController.providerList();
			case "model.list":
				return this.#settingsController.modelList(request.params);
			case "model.select":
				return this.#settingsController.selectModel(request.params);
			case "provider.connectivity.validate":
				return this.#settingsController.validateConnectivity();
			case "settings.load":
				return this.#settingsController.loadSettings();
			case "settings.keymap.reset":
				return this.#settingsController.resetKeymap();
			case "settings.save":
				return this.#settingsController.saveSettings(request.params);
			case "update.status":
				return this.#settingsController.updateStatus();
			case "update.dismiss":
				return this.#settingsController.updateDismiss(request.params);
			case "trace.export":
				return this.#traceExport(request.params);
			case "session.list":
				return this.#sessionController.list(request.params);
			case "session.resume.preview":
				return this.#sessionController.previewResume(request.params);
			case "session.new":
				return this.#sessionController.startNew();
			case "session.resume":
				return this.#sessionController.resume(request.params);
			case "session.tree":
				return this.#sessionController.tree(request.params);
			case "shell.list":
				return this.#shellController.list();
			case "shell.output.load":
				return this.#shellController.output(request.params);
			case "shell.stop":
				return this.#shellController.stop(request.params);
			case "shell.stop_all":
				return this.#shellController.stopAll();
			case "turn.submit":
				return this.#turnController.submit(request.params);
			case "approval.respond":
			case "decision.resolve":
				return this.#turnController.respondApproval(request.params);
			case "clarify.respond":
				return this.#turnController.respondClarification(request.params);
			case "turn.steer":
				return this.#turnController.steer(request.params);
			case "turn.follow_up":
				return this.#turnController.followUp(request.params);
			case "turn.queue.pop":
				return this.#turnController.popQueue(request.params);
			case "turn.queue.clear":
				return this.#turnController.clearQueue(request.params);
			case "turn.queue.restore.ack":
				return this.#turnController.acknowledgeQueueRestore(request.params);
			case "turn.queue.migration.ack":
				return this.#turnController.acknowledgeQueueMigration(request.params);
			case "turn.interrupt":
				return this.#turnController.interrupt(request.params);
			case "shutdown":
				return { ok: true };
			default:
				throw new GatewayFailure("method_not_found", "Unknown gateway method.");
		}
	}

	#mapRpcFailure(
		request: NodeGatewayRpcRequest | null,
		error: unknown,
	): NodeGatewayRpcFailure {
		if (!request) {
			return { code: "invalid_params", message: "Invalid JSON-RPC request." };
		}
		const failure = gatewayFailure(error);
		const data = { ...projectGatewayErrorData(failure.data, this.#errorContextVersion === 1 ? "read" : "legacy") as JsonObject };
		delete data.recovery_actions;
		const existingContext = readErrorContext(data.error_context);
		const occurrenceId = existingContext?.id ?? gatewayRequestOccurrenceId();
		const diagnostic = gatewayFailureDiagnostic(failure.code);
		const errorContext = this.#errorContextVersion === 1 && data.error_context_invalid !== true ? existingContext
			?? createErrorContext({
				id: occurrenceId, reason: legacyGatewayReason(failure.code, failure.data.dispatched === false ? false : undefined),
				source: "gateway", scope: { kind: "request", id: occurrenceId },
				outcome: failure.data.dispatched === false || ["invalid_params", "invalid_arguments", "turn_in_progress", "queue_conflict", "approval_not_pending", "clarification_not_pending"].includes(failure.code)
					? { state: "not_started", effects: "none" } : { state: "unknown", effects: "possible" },
			}) : undefined;
		const recoveryActions = errorContext ? resolveErrorRecovery(errorContext, {
			ownershipCurrent: true, connected: true, activeOperation: this.#turnController.hasActiveTurn(),
			effects: errorContext.outcome.effects === "none" ? "none" : "unknown", imageInput: "unknown",
			availableActions: DIAGNOSTIC_RECOVERY_ACTION_IDS,
		}).map((action) => action.id) : data.error_context_invalid === true ? [] : diagnostic.recoveryActions;
		return {
			code: failure.code,
			message: errorContext ? errorSummary(errorContext) : failure.message,
			data: projectGatewayErrorData({
				...data,
				occurrence_id: occurrenceId,
				category: errorContext ? errorDefinition(errorContext.reason).category : diagnostic.category,
				...(errorContext ? { error_context: errorContext } : {}),
				...(this.#errorContextVersion === 1 || recoveryActions.length > 0
					? { recovery_actions: recoveryActions }
					: {}),
			}, this.#errorContextVersion === 1 ? "read" : "legacy") as JsonObject,
		};
	}

	#projectRequestFailure(
		request: NodeGatewayRpcRequest,
		failure: NodeGatewayRpcFailure,
	): void {
		if (failure.code === "auth_required") return;
		const data = failure.data ?? {};
		this.#emitRuntime("gateway.error", {
			code: isGatewayErrorCode(failure.code) ? failure.code : "internal_error",
			message: failure.message,
			method: request.method,
			...(typeof data.additional_details === "string" ? { additional_details: data.additional_details } : {}),
			...(data.error_context ? { error_context: data.error_context } : {}),
			...(data.error_context_invalid === true ? { error_context_invalid: true } : {}),
			...(typeof data.occurrence_id === "string"
				? { occurrence_id: data.occurrence_id }
				: {}),
			...(typeof data.category === "string" ? { category: data.category } : {}),
			...(Array.isArray(data.recovery_actions)
				? { recovery_actions: data.recovery_actions }
				: {}),
		});
	}

	async #bootstrap(params: JsonObject, reemitPendingState: boolean): Promise<JsonObject> {
		if (params.protocol_version !== 1) {
			throw new GatewayFailure("incompatible_protocol", "Unsupported gateway protocol version.");
		}
		const [authProviders, authStatus] = await Promise.all([
			this.#settingsController.authProviders(),
			this.#settingsController.credentialReadiness(),
		]);
		this.#errorContextVersion = Array.isArray(params.supported_error_context_versions)
			&& params.supported_error_context_versions.includes(1) ? 1 : undefined;
		const payload: JsonObject = {
			protocol_version: 1,
			...(this.#errorContextVersion ? { error_context_version: this.#errorContextVersion } : {}),
			session_id: this.#sessionController.sessionId(),
			workspace: this.#sessionController.workspaceRoot(),
			provider: this.#settingsController.provider,
			model: this.#settingsController.model,
			status: this.#status(),
			background_shells: this.#shellController.activePayloads(),
			auth_providers: authProviders,
			...(authStatus ? { auth_status: credentialReadinessPayload(authStatus) } : {}),
			permissions: this.#settingsController.permissions(),
			...(this.#settingsController.visibleUpdateStatus ? {
				update: cachedUpdateStatusPayload(this.#settingsController.visibleUpdateStatus),
			} : {}),
			welcome: {
				startup_mark: { text: "mycli" },
				workspace: this.#sessionController.workspaceRoot(),
			},
		};
		const migration = this.#sessionController.queueCoordinator()?.legacyMigration();
		if (migration) payload.legacy_user_queue_migration = {
			token: migration.token,
			records: migration.records.map(legacyMigrationRecord),
		};
		const session = this.#options.sessionCoordinator?.snapshot();
		const restorePendingState = reemitPendingState && !this.#interactiveController.reemitVisibleRequest();
		if (restorePendingState && session?.pendingApproval
			&& (!this.#turnController.hasActiveTurn()
				|| session.binding.hasActiveApproval?.(session.pendingApproval.decisionId))) {
			this.#emitRuntime(
				"approval.request",
				approvalRequestPayload(session.pendingApproval, session.generation),
			);
		}
		if (restorePendingState && session?.pendingClarification) {
			this.#emitRuntime(
				"clarify.request",
				clarificationRequestPayload(session.pendingClarification, session.generation),
			);
		}
		return payload;
	}

	async #transcript(params: JsonObject): Promise<JsonObject> {
		const sessionId = optionalString(params.session_id) ?? this.#sessionController.sessionId();
		const attempts = this.#options.loadProviderAttempts && !optionalString(params.before)
			? loadGatewayProviderAttempts(this.#options.loadProviderAttempts, { sessionId, limit: 200 })
			: undefined;
		let limit = transcriptPageLimit(params.limit);
		for (;;) {
			let result = {
				...await this.#transcriptPage({ ...params, session_id: sessionId, limit }),
				...(attempts ? { provider_attempts: attempts.records, provider_attempts_truncated: attempts.has_more,
					provider_attempts_next_before: attempts.next_before_event_id } : {}),
			};
			if (this.#errorContextVersion === 1) result = await this.#refreshErrorRecovery(result, sessionId);
			if (Buffer.byteLength(JSON.stringify(result), "utf8") <= TRANSCRIPT_PAGE_MAX_BYTES) return result;
			if (limit === 1) {
				throw new GatewayFailure("gateway_message_too_large", "Transcript item exceeds the gateway page budget.");
			}
			// Reload with the same cursor so storage owns the shortened page's continuation.
			limit = Math.max(1, Math.floor(limit / 2));
		}
	}

	async #refreshErrorRecovery<Result extends JsonObject>(result: Result, sessionId: string): Promise<Result> {
		if (!Array.isArray(result.items)) return result;
		const items = result.items;
		const contexts = items.map((item) => isObject(item) && isObject(item.metadata) ? readErrorContext(item.metadata.error_context) : undefined);
		let imageInput: "supported" | "unsupported" | "unknown" = "unknown";
		if (contexts.some((context) => context?.reason === "capability.image_input_unsupported")) {
			try {
				const models = await this.#settingsController.models(this.#settingsController.provider);
				const selected = models.find((model) => model.current === true && model.model === this.#settingsController.model);
				imageInput = selected?.supports_images === true ? "supported" : selected?.supports_images === false ? "unsupported" : "unknown";
			} catch { /* History remains readable when the model catalog is unavailable. */ }
		}
		return { ...result, items: items.map((item, index) => {
			const context = contexts[index];
			if (!isObject(item) || !isObject(item.metadata) || !context) return item;
			const actions = resolveErrorRecovery(context, {
				ownershipCurrent: sessionId === this.#sessionController.sessionId(), connected: true,
				activeOperation: this.#turnController.hasActiveTurn(),
				effects: context.scope.kind === "provider_attempt" || context.outcome.effects !== "none" ? "unknown" : "none",
				imageInput, availableActions: DIAGNOSTIC_RECOVERY_ACTION_IDS,
			});
			return { ...item, metadata: { ...item.metadata, recovery_actions: actions.map((action) => action.id) } };
		}) };
	}

	async #transcriptPage(params: JsonObject): Promise<JsonObject> {
		const sessionId = optionalString(params.session_id) ?? this.#sessionController.sessionId();
		const before = optionalString(params.before);
		const limit = transcriptPageLimit(params.limit);
		if (sessionId === this.#sessionController.sessionId()
			&& this.#options.loadTranscriptPage
			&& (!before || before.startsWith("v1."))) {
			try {
				const page = this.#options.loadTranscriptPage(sessionId, {
					...(before ? { before } : {}),
					limit,
				});
				if (!before && !page.hasCanonicalHistory && this.#options.loadTranscript) {
					return paginatedTranscript(
						sessionId,
						this.#options.loadTranscript(sessionId).flatMap(gatewayTranscriptItems),
						params,
					);
				}
				return {
					session_id: sessionId,
					items: page.items.flatMap(gatewayTranscriptItems),
					next_before: page.nextBefore,
					read_only: false,
				};
			} catch (error) {
				if (error instanceof RangeError) {
					throw new GatewayFailure("invalid_params", "Transcript cursor or limit is invalid.");
				}
				throw error;
			}
		}
		if (sessionId === this.#sessionController.sessionId() && this.#options.loadTranscript) {
			return paginatedTranscript(
				sessionId,
				this.#options.loadTranscript(sessionId).flatMap(gatewayTranscriptItems),
				params,
			);
		}
		if (this.#options.sessionCoordinator) {
			const prepared = await this.#options.sessionCoordinator.inspect(sessionId);
			if (!prepared.readOnly
				&& this.#options.loadTranscriptPage
				&& (!before || before.startsWith("v1."))) {
				try {
					const page = this.#options.loadTranscriptPage(sessionId, {
						...(before ? { before } : {}),
						limit,
					});
					if (!before && !page.hasCanonicalHistory && this.#options.loadTranscript) {
						return paginatedTranscript(
							sessionId,
							this.#options.loadTranscript(sessionId).flatMap(gatewayTranscriptItems),
							params,
							false,
						);
					}
					return {
						session_id: sessionId,
						items: page.items.flatMap(gatewayTranscriptItems),
						next_before: page.nextBefore,
						read_only: false,
					};
				} catch (error) {
					if (error instanceof RangeError) {
						throw new GatewayFailure("invalid_params", "Transcript cursor or limit is invalid.");
					}
					throw error;
				}
			}
			return paginatedTranscript(
				sessionId,
				(prepared.readOnly || !this.#options.loadTranscript
					? prepared.transcript
					: this.#options.loadTranscript(sessionId)).flatMap(gatewayTranscriptItems),
				params,
				prepared.readOnly,
			);
		}
		if (sessionId !== this.#sessionController.sessionId()) {
			throw new GatewayFailure("invalid_params", "Unknown session.");
		}
		const items = this.#options.loadConversation(sessionId).map((message, index) => ({
			id: `${sessionId}:message:${index + 1}`,
			type: message.role === "user" ? "user" : "assistant_final",
			text: message.content,
			folded: false,
			metadata: {},
		}));
		return paginatedTranscript(sessionId, items, params);
	}

	#commandList(params: JsonObject): JsonObject {
		const surface = slashCommandSurface(params.surface);
		const builtInNames = builtinCommandRoutingNames();
		const integrationCommands = (this.#options.integrations?.commands?.list() ?? [])
			.filter(({ name }) => typeof name === "string"
				&& ![...builtInNames].some((reserved) => slashCommandArguments(name, reserved) !== null));
		const commands = [
			...commandDiscoveryManifest(surface).map((command) => {
				const unavailableReason = this.#commandUnavailableReason(command.id);
				return {
					...command,
					available: unavailableReason === undefined,
					...(unavailableReason ? { unavailable_reason: unavailableReason } : {}),
				};
			}),
			...integrationCommands,
			];
		return {
			commands,
			routing_names: [
				...builtInNames,
				...integrationCommands.flatMap((command) =>
					typeof command.name === "string" ? [command.name.trim()] : []),
			],
		};
	}

	#commandUnavailableReason(id: string): string | undefined {
		if (["login", "model", "settings"].includes(id) && !this.#options.controlCommands) {
			return "Runtime configuration controls are unavailable";
		}
		if (id === "memory" && !this.#options.memoryCommands) return "Session memory is unavailable";
		if (["fork", "resume", "session_maintenance", "session_search"].includes(id)
			&& !this.#options.sessionCommands) {
			return "Session storage controls are unavailable";
		}
		if (id === "trace" && !this.#options.traceCommands) return "Runtime trace export is unavailable";
		if (id === "update" && !this.#options.updateCommands) return "Update status is unavailable";
		if (["changes", "undo"].includes(id) && !this.#options.fileHistoryCommands) {
			return "File history is unavailable";
		}
		if (id === "ps" && !this.#options.shellManager) {
			return "Background terminals are unavailable";
		}
		if (id === "resources" && !this.#options.integrations?.listResources) {
			return "Integration resources are unavailable";
		}
		return undefined;
	}

	#completeSlash(params: JsonObject): JsonObject {
		const prefix = optionalString(params.prefix) ?? "/";
		const surface = params.surface === undefined ? "tui" : slashCommandSurface(params.surface);
		const commands = this.#commandList({ surface }).commands;
		return {
			items: Array.isArray(commands) ? commands.flatMap((value) => {
				if (
					!isObject(value)
					|| value.search_only === true
					|| value.available === false
					|| typeof value.name !== "string"
					|| !value.name.startsWith(prefix)
				) {
					return [];
				}
				return [{
					value: value.name,
					description: typeof value.description === "string" ? value.description : "",
				}];
			}) : [],
		};
	}

	async #completePath(params: JsonObject): Promise<JsonObject> {
		const prefix = optionalString(params.prefix) ?? "@";
		const items = await this.#options.controlCommands?.completePath(prefix) ?? [];
		return { items };
	}

	#traceExport(params: JsonObject): JsonObject {
		const trace = this.#options.traceCommands;
		if (!trace) throw new GatewayFailure("internal_error", "Trace export is unavailable.");
		const tail = params.tail === undefined ? 50 : positiveInteger(params.tail);
		if (tail === undefined) throw new GatewayFailure("invalid_params", "tail must be a positive integer.");
		return {
			session_id: this.#sessionController.sessionId(),
			format: "jsonl",
			rows: trace.export(this.#sessionController.sessionId()).slice(-tail),
		};
	}

	async #commandRun(params: JsonObject): Promise<JsonObject> {
		const command = requiredString(params.command, "command").trim();
		const surface = slashCommandSurface(params.surface);
		let invocation;
		try {
			invocation = resolveSlashCommand({
				text: command,
				surface,
				turnRunning: this.#turnController.hasActiveTurn(),
			});
		} catch (error) {
			if (!(error instanceof SlashCommandError && error.code === "unknown_command")) {
				throw error;
			}
			const integrationResult = await this.#options.integrations?.commands?.run(
				command,
				new AbortController().signal,
			);
			if (integrationResult) return integrationResult;
			throw error;
		}
		if (invocation.owner === "tui") {
			return {
				execution: "tui",
				command_id: invocation.commandId,
				client_action: invocation.clientAction ?? "",
				args: invocation.args,
				presentation: invocation.presentation,
			};
		}
		if (invocation.commandId === "ps") {
			if (invocation.args === "stop-all") {
				return this.#shellController.stopAllCommandResult();
			}
			if (invocation.args) {
				return errorCommandResult(invocation, "Unsupported terminals action", "/ps [stop-all]");
			}
			return this.#shellController.psCommandResult();
		}
		const coreResult = await this.#coreCommand(invocation);
		if (coreResult) return coreResult;
		throw new GatewayFailure("method_not_found", "Unknown command.");
	}

	async #coreCommand(invocation: ReturnType<typeof resolveSlashCommand>): Promise<JsonObject | undefined> {
		if (invocation.commandId === "new") {
			const created = await this.#sessionController.startNew();
			return {
				...created,
				...noticeCommandResult(invocation, "New session", `session=${created.session_id}`, {
					extra: { mutated_session: true },
				}),
			};
		}
		if (invocation.commandId === "status") {
			const status = this.#status();
			const permissions = isObject(status.permissions) ? status.permissions : {};
			const effective = isObject(permissions.effective) ? permissions.effective : {};
			const sandboxReadiness = isObject(permissions.sandbox_readiness)
				? permissions.sandbox_readiness
				: {};
			const contextWindow = isObject(status.context_window) ? status.context_window : {};
			const usedTokens = typeof contextWindow.used_tokens === "number" ? contextWindow.used_tokens : 0;
			const maxTokens = typeof contextWindow.max_tokens === "number" ? contextWindow.max_tokens : 0;
			return statusCommandResult(invocation, [
				{ label: "Session", value: String(status.session_id ?? this.#sessionController.sessionId()) },
				{ label: "Model", value: this.#settingsController.model },
				{ label: "Provider", value: this.#settingsController.provider },
				{ label: "Directory", value: this.#sessionController.workspaceRoot() },
				{
					label: "Context",
					value: maxTokens > 0
						? `${Math.round(usedTokens / maxTokens * 100)}% (${usedTokens}/${maxTokens})`
						: "unknown",
				},
				{ label: "Pending", value: status.pending_decision ? "yes" : "no" },
				{ label: "Suspended", value: status.suspended_turn ? "yes" : "no" },
				{ label: "Session state", value: String(status.session_lifecycle_status ?? "active") },
				{ label: "Session lock", value: String(status.session_lock_state ?? "unlocked") },
				{ label: "Recovery", value: String(status.session_pending_state ?? "none") },
				{
					label: "Permissions",
					value: String(permissions.active ?? this.#settingsController.permissionProfile),
				},
				{ label: "Sandbox", value: String(effective.sandbox_mode ?? "unknown") },
				{ label: "Filesystem", value: String(effective.filesystem ?? "unknown") },
				{ label: "Network", value: String(effective.network ?? "unknown") },
				{ label: "Approval", value: String(effective.approval_behavior ?? "unknown") },
				{ label: "Policy source", value: String(effective.source ?? "unknown") },
				{ label: "Sandbox readiness", value: String(sandboxReadiness.state ?? "unknown") },
				{ label: "State", value: String(status.state ?? "idle") },
			]);
		}
		if (invocation.commandId === "update") {
			return this.#settingsController.updateCommand(invocation);
		}
		if (invocation.commandId === "usage") {
			const usage = aggregateUsage(
				this.#options.loadTurnRollouts?.(this.#sessionController.sessionId()) ?? [],
			);
			return diagnosticCommandResult(
				invocation,
				"Usage",
				Object.entries(usage).map(([key, value]) => ({
					label: humanize(key),
					value: String(value),
				})),
			);
		}
		if (invocation.commandId === "context") {
			const contextWindow = this.#status().context_window;
			const context = isObject(contextWindow) ? contextWindow : {};
			const used = typeof context.used_tokens === "number" ? context.used_tokens : 0;
			const maximum = typeof context.max_tokens === "number" ? context.max_tokens : 0;
			const source = typeof context.source === "string" ? context.source : "unknown";
			return diagnosticCommandResult(invocation, "Context", [
				{ label: "Used tokens", value: String(used) },
				{ label: "Max tokens", value: String(maximum) },
				{
					label: "Usage ratio",
					value: maximum > 0 ? `${Math.round(used / maximum * 100)}%` : "unknown",
				},
				{ label: "Source", value: source },
			]);
		}
		if (invocation.commandId === "stats") {
			const rollouts = this.#options.loadTurnRollouts?.(this.#sessionController.sessionId()) ?? [];
			const transcript = this.#options.loadTranscript?.(this.#sessionController.sessionId()) ?? [];
			return diagnosticCommandResult(invocation, "Runtime stats", [
				{ label: "Turns", value: String(rollouts.length) },
				{ label: "Transcript items", value: String(transcript.length) },
				{ label: "Tool calls", value: String(transcript.filter((item) => item.type === "tool").length) },
			]);
		}
		if (invocation.commandId === "tools") {
			const manifest = integrationToolManifest(this.#options.integrations);
			const tools = isObject(manifest) && Array.isArray(manifest.tools) ? manifest.tools : [];
			const toolRows = tools.flatMap((value, index) => {
				if (!isObject(value)) return [];
				const availability = isObject(value.availability) ? value.availability : {};
				return [{
					key: String(value.id ?? `tool:${index}`),
					label: String(value.name ?? value.id ?? "Tool"),
					values: [String(value.source ?? "runtime"), String(value.toolset ?? "")].filter(Boolean),
					...(typeof availability.status === "string" ? { status: availability.status } : {}),
					...(typeof value.description === "string" ? { detail: value.description } : {}),
				}];
			});
			if (!invocation.args || invocation.args === "list") {
				return listCommandResult(invocation, "Tools", toolRows);
			}
			if (invocation.args === "sets") {
				const toolsets = isObject(manifest) && Array.isArray(manifest.toolsets)
					? manifest.toolsets
					: [];
				return listCommandResult(invocation, "Tool sets", toolsets.flatMap((value, index) => {
					if (!isObject(value)) return [];
					return [{
						key: `toolset:${index}`,
						label: String(value.id ?? "Tool set"),
						values: [`tools=${String(value.tool_count ?? 0)}`],
					}];
				}));
			}
			if (invocation.args === "hooks") {
				const resources = await this.#options.integrations?.listResources?.() ?? [];
				const hooks = resources.filter((value) => value.type === "hook");
				return listCommandResult(invocation, "Hooks", hooks.map((value, index) => ({
					key: String(value.id ?? `hook:${index}`),
					label: String(value.name ?? value.id ?? "Hook"),
					values: [String(value.source ?? "runtime")],
					status: String(value.status ?? "configured"),
					...(typeof value.detail === "string" ? { detail: value.detail } : {}),
				})));
			}
			if (invocation.args === "extensions") {
				return listCommandResult(
					invocation,
					"Extensions",
					toolRows.filter((row) => !row.values.includes("builtin")),
				);
			}
			if (invocation.args === "plugins") {
				const resources = await this.#options.integrations?.listResources?.() ?? [];
				const resourceRows = resources.filter((value) => value.type === "plugin")
					.map((value, index) => ({
						key: `plugin-resource:${index}`,
						label: String(value.name ?? value.id ?? "Plugin"),
						values: [String(value.source ?? "runtime")],
						status: String(value.status ?? "available"),
						...(typeof value.detail === "string" ? { detail: value.detail } : {}),
					}));
				const commandRows = (this.#options.integrations?.commands?.list() ?? [])
					.filter((value) => typeof value.name === "string" && value.name.startsWith("/plugin"))
					.map((value, index) => ({
						key: `plugin-command:${index}`,
						label: String(value.name),
						values: ["command"],
						...(typeof value.description === "string" ? { detail: value.description } : {}),
					}));
				return listCommandResult(invocation, "Plugins", [...resourceRows, ...commandRows]);
			}
			const pluginArguments = slashCommandArguments(invocation.args, "plugins");
			if (pluginArguments) {
				const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/u.exec(pluginArguments);
				if (!match) {
					return errorCommandResult(
						invocation,
						"Plugin ID and command name are required",
						"/tools plugins <plugin-id> <command-name> [json-args]",
					);
				}
				const [, pluginId, commandName, rawArguments = ""] = match;
				const route = `/plugin:${pluginId}:${commandName}${rawArguments ? ` ${rawArguments}` : ""}`;
				let result: JsonObject | undefined;
				try {
					result = await this.#options.integrations?.commands?.run(
						route,
						new AbortController().signal,
					);
				} catch {
					return errorCommandResult(
						invocation,
						"Invalid plugin command arguments",
						"/tools plugins <plugin-id> <command-name> [json-args]",
					);
				}
				if (!result) {
					return errorCommandResult(invocation, "Plugin command was not found");
				}
				const lines = Array.isArray(result.lines)
					? result.lines.filter((line): line is string => typeof line === "string")
					: [];
				return preformattedCommandResult(invocation, "Plugin output", lines, {
					presentation: "transcript",
					extra: {
						...(typeof result.ok === "boolean" ? { ok: result.ok } : {}),
						...(typeof result.error === "string" ? { error: result.error } : {}),
					},
				});
			}
			return errorCommandResult(
				invocation,
				"Unsupported tools action",
				"/tools [list|sets|hooks|extensions|plugins]",
			);
		}
		if (invocation.commandId === "skills") {
			const resources = await this.#options.integrations?.listResources?.() ?? [];
			return listCommandResult(invocation, "Skills", resources.flatMap((value, index) =>
				value.type === "skill" ? [{
					key: `skill:${index}`,
					label: String(value.name ?? "Skill"),
					values: [String(value.source ?? "runtime")],
					status: String(value.status ?? "available"),
					detail: typeof value.detail === "string" ? value.detail : undefined,
				}] : []));
		}
		if (invocation.commandId === "agents") {
			const tasks = this.#options.backgroundTaskCommands;
			const args = invocation.args;
			const childSessionId = slashCommandArguments(args, "kill");
			if (childSessionId !== null) {
				if (!childSessionId || /\s/u.test(childSessionId)) {
					return errorCommandResult(invocation, "Child session ID is required", "/agents kill <child-session-id>");
				}
				if (!tasks) throw new GatewayFailure("method_not_found", "Background task controls are unavailable.");
				const interrupted = await tasks.interrupt(
					this.#sessionController.sessionId(),
					childSessionId,
				);
				return noticeCommandResult(
					invocation,
					"Background agent",
					interrupted ? `interrupted=${childSessionId}` : `not_found=${childSessionId}`,
					{ extra: { interrupted } },
				);
			}
			if (args === "kill-all") {
				if (!tasks) throw new GatewayFailure("method_not_found", "Background task controls are unavailable.");
				const interrupted = await tasks.interruptAll(this.#sessionController.sessionId());
				return noticeCommandResult(invocation, "Background agents", `interrupted=${interrupted}`, {
					extra: { interrupted },
				});
			}
			if (!/\s/u.test(args)) {
				const requested = args;
				const records = tasks?.list(this.#sessionController.sessionId()) ?? [];
				const selected = requested
					? records.filter((record) => record.childSessionId === requested)
					: records;
				return listCommandResult(invocation, "Background agents", selected.map((record, index) => ({
					key: String(record.taskId ?? `task:${index}`),
					label: String(record.childSessionId ?? "Background agent"),
					values: [String(record.taskName ?? "agent")],
					status: String(record.status ?? "unknown"),
					detail: isObject(record.payload) && typeof record.payload.progressSummary === "string"
						? record.payload.progressSummary
						: undefined,
				})));
			}
			return errorCommandResult(
				invocation,
				"Unsupported agents action",
				"/agents [child-session-id|kill <child-session-id>|kill-all]",
			);
		}
		if (invocation.commandId === "memory") {
			const memory = this.#options.memoryCommands;
			if (!memory) throw new GatewayFailure("method_not_found", "Memory commands are unavailable.");
			const args = invocation.args;
			if (!args || args === "list") {
				return listCommandResult(invocation, "Memory", memoryRows(await memory.scan()));
			}
			if (args === "path") {
				return diagnosticCommandResult(invocation, "Memory", [{
					label: "Path",
					value: await memory.directory(),
				}]);
			}
			if (args.startsWith("search ")) {
				const query = args.slice("search ".length).trim().toLocaleLowerCase();
				if (!query) return errorCommandResult(invocation, "Search query is required", "/memory search <query>");
				const matches = (await memory.scan()).filter((item) =>
					[item.filename, item.name, item.description, item.content].some((value) =>
						typeof value === "string" && value.toLocaleLowerCase().includes(query)));
				return listCommandResult(invocation, "Memory", memoryRows(matches));
			}
			if (args.startsWith("add ")) {
				const parsed = parseMemoryAdd(args.slice("add ".length));
				const saved = await memory.remember(parsed);
				return noticeCommandResult(
					invocation,
					"Memory updated",
					`memory_saved=${String(saved.filename ?? parsed.name)}`,
					{ presentation: "transcript" },
				);
			}
			if (args.startsWith("forget ")) {
				const query = args.slice("forget ".length).trim();
				if (!query) return errorCommandResult(invocation, "Memory name is required", "/memory forget <name>");
				const removed = await memory.forget(query);
				return noticeCommandResult(
					invocation,
					"Memory updated",
					removed.length ? `memory_forgot=${removed.length}` : "memory_forget_no_match",
					{ presentation: "transcript" },
				);
			}
			return errorCommandResult(
				invocation,
				"Unsupported memory action",
				"/memory [list|path|search|add|forget]",
			);
		}
		if (invocation.commandId === "changes") {
			const history = this.#options.fileHistoryCommands;
			if (!history) throw new GatewayFailure("method_not_found", "File history is unavailable.");
			const snapshots = await history.list(this.#sessionController.sessionId());
			return listCommandResult(invocation, "File changes", snapshots.map((snapshot) => ({
				key: snapshot.snapshotId,
				label: snapshot.path,
				values: [snapshot.turnId, snapshot.toolName],
			})));
		}
		if (invocation.commandId === "undo") {
			const history = this.#options.fileHistoryCommands;
			if (!history) throw new GatewayFailure("method_not_found", "File history is unavailable.");
			let result;
			try {
				result = await history.undo(this.#sessionController.sessionId());
			} catch {
				return noticeCommandResult(
					invocation,
					"Undo incomplete",
					"File history is unavailable.",
					{ severity: "warning" },
				);
			}
			const changes = [
				...result.restoredPaths.map((path) => `restored ${path}`),
				...result.deletedPaths.map((path) => `deleted ${path}`),
			];
			return noticeCommandResult(
				invocation,
				result.error ? "Undo incomplete" : "Undo complete",
				result.error ?? (changes.join(", ") || "No file changes found."),
				{
					severity: result.error ? "warning" : "success",
					extra: {
						...(result.snapshotId ? { snapshot_id: result.snapshotId } : {}),
						restored_count: result.restoredPaths.length,
						deleted_count: result.deletedPaths.length,
					},
				},
			);
		}
		if (invocation.commandId === "fork") {
			const sessions = this.#options.sessionCommands;
			if (!sessions) throw new GatewayFailure("method_not_found", "Session fork is unavailable.");
			let parsed;
			try {
				parsed = parseForkArguments(invocation.args, this.#sessionController.sessionId());
			} catch {
				return errorCommandResult(
					invocation,
					"Invalid fork arguments",
					"/fork [source] [new-session] [message-index]",
				);
			}
			let result;
			try {
				result = sessions.fork(parsed);
			} catch {
				return errorCommandResult(invocation, "Unable to fork session");
			}
			const resumed = await this.#sessionController.resume({ session_id: result.targetSessionId });
			return {
				...resumed,
				...noticeCommandResult(
					invocation,
					"Session forked",
					`forked=${result.sourceSessionId}->${result.targetSessionId}; fork_point=${result.forkPoint}; messages=${result.messageCount}`,
					{
						extra: {
							mutated_session: true,
							fork_point: result.forkPoint,
							message_count: result.messageCount,
						},
					},
				),
			};
		}
		if (invocation.commandId === "session_search") {
			if (!invocation.args) {
				return errorCommandResult(invocation, "Search query is required", "/session search <query>");
			}
			const sessions = this.#options.sessionCommands;
			if (!sessions) throw new GatewayFailure("method_not_found", "Session search is unavailable.");
			const matches = sessions.search(invocation.args, this.#sessionController.workspaceRoot());
			return listCommandResult(invocation, "Session search", matches.map((match, index) => ({
				key: `search:${index}:${match.sessionId}:${match.messageIndex}`,
				label: `${match.sessionId}:${match.messageIndex}`,
				values: [match.role],
				detail: match.snippet,
			})));
		}
		if (invocation.commandId === "session_maintenance") {
			const action = sessionMaintenanceAction(invocation.args);
			if (!action) {
				return errorCommandResult(
					invocation,
					"Unsupported session maintenance action",
					"/session maintenance [--apply-empty|--apply-payloads|--apply-orphans|--apply-vacuum|--apply-transcript-normalization|--apply-content-blobs|--apply-content-blob-gc]",
				);
			}
			const sessions = this.#options.sessionCommands;
			if (!sessions) throw new GatewayFailure("method_not_found", "Session maintenance is unavailable.");
			const result = await sessions.maintenance(action, this.#sessionController.workspaceRoot());
			if (action === "report") {
				return listCommandResult(invocation, "Session maintenance", commandObjectRows(result));
			}
			const response = noticeCommandResult(
				invocation,
				"Session maintenance",
				commandObjectSummary(result),
				{
					severity: result.status === "failed" ? "error" : "success",
					extra: action === "transcript_normalization"
						|| action === "content_blobs" || action === "content_blob_gc"
						? { ...result }
						: undefined,
				},
			);
			if ((action === "transcript_normalization" || action === "content_blobs")
				&& result.backend_restart_required === true) {
				this.#closeAfterResponses.add(response);
			}
			return response;
		}
		if (invocation.commandId === "trace") {
			const trace = this.#options.traceCommands;
			if (!trace) throw new GatewayFailure("method_not_found", "Trace commands are unavailable.");
			if (!invocation.args) {
				return listCommandResult(
					invocation,
					"Trace",
					trace.inspect(this.#sessionController.sessionId()).map(
					(value, index) => ({
						key: `trace:${index}`,
						label: String(value.kind ?? "event"),
						values: [String(value.turnId ?? value.turn_id ?? "")].filter(Boolean),
						status: typeof value.status === "string" ? value.status : undefined,
					}),
				));
			}
			if (invocation.args === "export") {
				return preformattedCommandResult(
					invocation,
					"Trace export",
					trace.export(this.#sessionController.sessionId()),
					{ presentation: "transcript" },
				);
			}
			if (invocation.args === "logs") {
				return preformattedCommandResult(invocation, "Trace logs", trace.logs());
			}
			return errorCommandResult(invocation, "Unsupported trace action", "/trace [export|logs]");
		}
		if (invocation.commandId === "help") {
			return listCommandResult(invocation, "Commands", commandManifest("cli").map((command) => ({
				key: `command:${command.id}`,
				label: command.name,
				detail: command.description,
			})));
		}
		if (invocation.commandId === "model") {
			const selection = parseModelSelection(invocation.args);
			const selectedModel = selection.model
				?? (selection.reasoningEffort ? this.#settingsController.model : undefined);
			if (selectedModel) {
				const catalog = await this.#settingsController.models(this.#settingsController.provider);
				const entry = catalog.find((candidate) => candidate.model === selectedModel);
				if (!entry) {
					return errorCommandResult(
						invocation,
						`Model '${selectedModel}' is not available`,
						"/model [model] [--thinking-effort level]",
					);
				}
				const provider = typeof entry.provider === "string" ? entry.provider : "";
				const protocol = typeof entry.protocol === "string" ? entry.protocol : "";
				const baseUrl = typeof entry.base_url === "string" ? entry.base_url : "";
				if (!provider || !protocol || !baseUrl) {
					throw new GatewayFailure("internal_error", "Model catalog entry is incomplete.");
				}
				try {
					await this.#settingsController.selectModel({
						provider,
						protocol,
						model: selectedModel,
						base_url: baseUrl,
						...(selection.reasoningEffort
							? { reasoning_effort: selection.reasoningEffort }
							: {}),
					});
				} catch (error) {
					const failure = gatewayFailure(error);
					return errorCommandResult(
						invocation,
						failure.message,
						"/model [model] [--thinking-effort level]",
					);
				}
			}
			this.#emitRuntime("status.changed", this.#status());
			return noticeCommandResult(invocation, "Model updated", [
				`model=${this.#settingsController.model}`,
				...(this.#settingsController.reasoningEffort
					? [`thinking_effort=${this.#settingsController.reasoningEffort}`]
					: []),
			].join("; "), {
				extra: {
					mutated_model: true,
					model: this.#settingsController.model,
					...(this.#settingsController.reasoningEffort
						? { thinking_effort: this.#settingsController.reasoningEffort }
						: {}),
				},
			});
		}
		if (invocation.commandId === "plan" || invocation.commandId === "mode") {
			const requested = invocation.commandId === "plan"
				? "plan"
				: invocation.args || this.#settingsController.collaborationMode;
			if (requested !== "default" && requested !== "plan") {
				return errorCommandResult(invocation, "Unsupported collaboration mode", "/mode [default|plan]");
			}
			const mutated = requested !== this.#settingsController.collaborationMode
				|| invocation.commandId === "plan";
			this.#settingsController.setCollaborationMode(requested);
			return noticeCommandResult(invocation, "Collaboration mode", `collaboration_mode=${requested}`, {
				extra: {
					mutated_mode: mutated,
					collaboration_mode: requested,
				},
			});
		}
		if (invocation.commandId === "sandbox") {
			const sandbox = this.#settingsController.updateSandbox(invocation.args);
			return noticeCommandResult(invocation, "Sandbox", `sandbox=${sandbox}`, {
				extra: { mutated_mode: Boolean(invocation.args), sandbox_mode: sandbox },
			});
		}
		if (invocation.commandId === "permissions") {
			const runtime = this.#sessionController.runtime();
			if (!invocation.args) {
				const allowances = runtime.listCommandAllowances?.() ?? [];
				const permissions = this.#settingsController.permissions();
				const effective = isObject(permissions.effective) ? permissions.effective : {};
				const readiness = isObject(permissions.sandbox_readiness)
					? permissions.sandbox_readiness
					: {};
				return listCommandResult(invocation, "Permissions", [
					{
						key: "permissions:profile",
						label: "Profile",
						values: [this.#settingsController.permissionProfile],
					},
					{
						key: "permissions:sandbox",
						label: "Sandbox",
						values: [String(
							effective.sandbox_mode
								?? settingsSandboxForPermission(this.#settingsController.permissionProfile),
						)],
					},
					{
						key: "permissions:filesystem",
						label: "Filesystem",
						values: [String(effective.filesystem ?? "unknown")],
					},
					{
						key: "permissions:network",
						label: "Network",
						values: [String(effective.network ?? "unknown")],
					},
					{
						key: "permissions:source",
						label: "Policy source",
						values: [String(effective.source ?? "unknown")],
					},
					{
						key: "permissions:readiness",
						label: "Sandbox readiness",
						values: [String(readiness.state ?? "unknown")],
					},
					{
						key: "permissions:allowances",
						label: "Session allowances",
						values: [String(allowances.length)],
					},
					...allowances.map((allowance, index) => ({
						key: `permissions:allowance:${index}`,
						label: allowance.join(" "),
						values: ["allow_session"],
					})),
				]);
			}
			let summary: string;
			let cleared: number | undefined;
			if (invocation.args.startsWith("allow ")) {
				const pattern = requiredCommandPattern(invocation.args.slice("allow ".length));
				if (!runtime.addCommandAllowance) {
					throw new GatewayFailure("method_not_found", "Command allowances are unavailable.");
				}
				runtime.addCommandAllowance(pattern);
				summary = `allowed=${pattern}`;
			} else if (invocation.args.startsWith("revoke ")) {
				const pattern = requiredCommandPattern(invocation.args.slice("revoke ".length));
				if (!runtime.removeCommandAllowance) {
					throw new GatewayFailure("method_not_found", "Command allowances are unavailable.");
				}
				runtime.removeCommandAllowance(pattern);
				summary = `revoked=${pattern}`;
			} else if (invocation.args === "clear") {
				if (!runtime.clearCommandAllowances) {
					throw new GatewayFailure("method_not_found", "Command allowances are unavailable.");
				}
				cleared = runtime.clearCommandAllowances();
				summary = `cleared=${cleared}`;
			} else {
				return errorCommandResult(
					invocation,
					"Unsupported permissions action",
					"/permissions [allow <pattern>|revoke <pattern>|clear]",
				);
			}
			this.#emitRuntime("status.changed", this.#status());
			return noticeCommandResult(invocation, "Permissions updated", summary, {
				presentation: "transcript",
				extra: { ...(cleared === undefined ? {} : { cleared }) },
			});
		}
		if (invocation.commandId === "compact") {
			const compact = this.#sessionController.runtime().compact;
			if (!compact) throw new GatewayFailure("method_not_found", "Manual compaction is unavailable.");
			if (this.#closed) throw new GatewayFailure("gateway_closed", "Gateway is closed.");
			const controller = new AbortController();
			const operation = { controller, task: Promise.resolve().then(() => compact({
				modelOverride: this.#settingsController.model, signal: controller.signal,
			})) };
			this.#manualCompaction = operation;
			let result: NodeGatewayCompactionResult;
			try {
				result = await operation.task;
			} finally {
				if (this.#manualCompaction === operation) this.#manualCompaction = null;
			}
			const presentation = compactionCommandPresentation(result);
			return noticeCommandResult(
				invocation,
				presentation.title,
				presentation.summary,
				{
					severity: presentation.severity,
					extra: {
						command_kind: "compact",
						compaction_status: result.status,
						tokens: { before: result.beforeTokens, after: result.afterTokens },
						...(result.failure ? { failure: result.failure } : {}),
						...(result.usage ? { usage: result.usage } : {}),
					},
				},
			);
		}
		if (invocation.commandId === "resume") {
			if (!invocation.args) {
				return errorCommandResult(invocation, "Session ID is required", "/resume [session-id]");
			}
			const resumed = await this.#sessionController.resume({ session_id: invocation.args });
			return {
				...resumed,
				...noticeCommandResult(invocation, "Session resumed", `session=${resumed.session_id}`, {
					extra: { mutated_session: true },
				}),
			};
		}
		if (invocation.commandId === "quit") {
			return noticeCommandResult(invocation, "Exit", "Bye.", {
				extra: { exit_requested: true },
			});
		}
		return undefined;
	}

	async #resourceList(): Promise<JsonObject> {
		const resources = await this.#options.integrations?.listResources?.() ?? [];
		return { resources: resources.map(boundedResource).filter(isObject) };
	}

	#status(): JsonObject {
		const session = this.#options.sessionCoordinator?.snapshot();
		const summary = this.#options.sessionCommands?.inspect?.(this.#sessionController.sessionId());
		const queue = this.#sessionController.queueCoordinator()?.snapshot() ?? session?.queue;
		const steering = queue?.pendingSteers ?? [];
		const rejectedSteers = queue?.rejectedSteers ?? [];
		const followUps = queue?.followUps ?? [];
		const deferredInputs = [...rejectedSteers, ...followUps];
		const pendingInputCount = steering.length + deferredInputs.length;
		return {
			session_id: this.#sessionController.sessionId(),
			...(session ? { generation: session.generation } : {}),
			workspace: this.#sessionController.workspaceRoot(),
			provider: this.#settingsController.provider,
			model: this.#settingsController.model,
			...(this.#settingsController.reasoningEffort
				? { thinking_effort: this.#settingsController.reasoningEffort }
				: {}),
			collaboration_mode: this.#settingsController.collaborationMode,
			...(summary ? {
				session_lifecycle_status: summary.lifecycleStatus,
				session_lock_state: summary.leaseState,
				session_pending_state: summary.pendingState,
				session_metadata_revision: summary.metadataRevision,
				...(summary.parentId ? { parent_session_id: summary.parentId } : {}),
				...(summary.forkPoint === undefined ? {} : { fork_point: summary.forkPoint }),
			} : {}),
			context_window: this.#turnController.contextWindow(),
			pending_decision: session?.pendingApproval !== undefined,
			pending_clarification: session?.pendingClarification !== undefined,
			suspended_turn: session?.pendingApproval !== undefined
				|| session?.pendingClarification !== undefined
				|| session?.suspendedTurn === true,
			turn_running: this.#turnController.hasActiveTurn(),
			turn_id: this.#turnController.activeTurnId(),
			queued_steering: steering.map((item) => item.text),
			queued_follow_up: deferredInputs.map((item) => item.text),
			has_pending_input: pendingInputCount > 0,
			queue_activity: {
				kind: pendingInputCount > 0 ? "pending_input" : "idle",
				has_pending_input: pendingInputCount > 0,
				steering_count: steering.length,
				follow_up_count: deferredInputs.length,
			},
			queue_revision: queue?.revision ?? 0,
			queue_items: {
				pending_steers: queue?.pendingSteers.map(gatewayQueueItem) ?? [],
				rejected_steers: rejectedSteers.map(gatewayQueueItem),
				follow_ups: followUps.map(gatewayQueueItem),
			},
			background_shells: this.#shellController.activePayloads(),
			trust: this.#settingsController.trustStatus(),
			permissions: this.#settingsController.permissions(),
		};
	}

	#bindSubagents(): void {
		this.#unsubscribeSubagents = this.#options.integrations?.subscribeSubagents?.((value) => {
			const parentSessionId = boundedRequiredValue(value.parent_session_id, 256);
			if (parentSessionId && parentSessionId !== this.#sessionController.context().sessionId) return;
			const subagent = boundedSubagent(value);
			if (subagent) this.#emitRuntime("subagent.updated", { subagent });
		}) ?? null;
	}

	#bindExtensions(): void {
		this.#unsubscribeExtensions = this.#options.integrations?.subscribeExtensions?.((version) => {
			if (this.#closed) return;
			this.#emitDirect("extension.updated", { version });
		}) ?? null;
	}

	#bindAgentInteractiveRequests(): void {
		this.#unsubscribeAgentInteractiveRequests = this.#options.agentInteractiveRequests?.subscribe(
			(notification) => {
				if (this.#closed) return;
				if (notification.method === "interactive.cancelled") {
					this.#interactiveController.cancel({ ...notification.params });
					return;
				}
				this.#emitRuntime(notification.method, { ...notification.params });
			},
		) ?? null;
	}

	#emitRuntime(method: RuntimeGatewayEventMethod, params: JsonObject): void {
		this.#interactiveController.emit(
			method,
			params,
			this.#turnController.currentOwnership(params),
		);
	}

	#emitDirect(method: GatewayEventMethod, params: JsonObject): void {
		this.#eventProjector.emitDirect(method, params);
	}
}

interface CompactionCommandPresentation {
	readonly title: string;
	readonly summary: string;
	readonly severity: "info" | "success" | "warning" | "error";
}

function compactionCommandPresentation(
	result: NodeGatewayCompactionResult,
): CompactionCommandPresentation {
	switch (result.status) {
		case "compressed":
			return {
				title: "Context compacted",
				summary: `Context compacted: ${result.beforeTokens} -> ${result.afterTokens} tokens.`,
				severity: "success",
			};
		case "not_needed":
			return {
				title: "Nothing to compact",
				summary: "Nothing to compact. Only base context and retained recent turns remain.",
				severity: "info",
			};
		case "skipped":
			return {
				title: "Compaction skipped",
				summary: `Compaction skipped. Context remains at ${result.beforeTokens} tokens.`,
				severity: "warning",
			};
		case "failed":
			return {
				title: "Compaction failed",
				summary: result.failure
					? [result.failure.message, result.failure.additionalDetails].filter(Boolean).join("\n")
					: `Compaction failed. Context remains at ${result.beforeTokens} tokens.`,
				severity: "error",
			};
		case "interrupted":
			return {
				title: "Compaction interrupted",
				summary: `Compaction interrupted. Context remains at ${result.beforeTokens} tokens.`,
				severity: "warning",
			};
	}
}

export function createNodeGateway(options: CreateNodeGatewayOptions): NodeGateway {
	return new InProcessNodeGateway(options);
}

function gatewayTranscriptItem(item: TranscriptItem): GatewayTranscriptItem {
	const type = {
		user_message: "user",
		assistant_message: "assistant_final",
		turn_completed: "turn_completed",
		clarification: "clarification",
		reasoning_summary: "reasoning",
		tool: "tool_summary",
		error: "error",
		warning: "warning",
		status: "system_notice",
		file_change: "system_notice",
		plan_update: "plan_update",
		web_search: "web_search",
	}[item.type];
	const metadata: JsonObject = { ...(item.metadata ?? {}) };
	if (item.type === "turn_completed" && item.duration_ms !== undefined) {
		metadata.duration_ms = item.duration_ms;
	}
	if (item.type === "tool") {
		if (item.tool_name) metadata.tool_name = item.tool_name;
		if (item.call_id) metadata.call_id = item.call_id;
		if (item.command) metadata.command = item.command;
		if (item.exit_code !== undefined) metadata.exit_code = item.exit_code;
		if (item.duration_ms !== undefined) metadata.duration_ms = item.duration_ms;
		if (item.truncated) metadata.truncated = true;
		if (item.omitted_chars !== undefined) metadata.omitted_chars = item.omitted_chars;
		if (item.status) {
			metadata.status = item.status === "completed" ? "done" : item.status;
			if (item.status === "completed" && metadata.success === undefined) metadata.success = true;
		}
		if (item.output) metadata.output_preview = item.output;
	}
	if (item.type === "web_search") {
		if (item.call_id) metadata.call_id = item.call_id;
		if (item.status) metadata.status = item.status;
	}
	const projected: GatewayTranscriptItem = {
		id: item.id,
		...(item.turn_id ? { turn_id: item.turn_id } : {}),
		type,
		text: item.text ?? (item.type === "tool" ? item.tool_name ?? "Tool" : ""),
		created_at: item.created_at ?? "",
		folded: false,
		metadata,
	};
	return item.type === "tool"
		? { ...projected, tool_record: projectGatewayToolRecord({ text: projected.text, metadata }) }
		: projected;
}

function gatewayTranscriptItems(item: TranscriptItem): readonly GatewayTranscriptItem[] {
	const projected = gatewayTranscriptItem(item);
	if (item.type !== "assistant_message") return [projected];
	const proposedPlan = extractProposedPlan(item.text ?? "");
	if (!proposedPlan) return [projected];

	const plan: GatewayTranscriptItem = {
		id: `${item.id}:proposed-plan`,
		...(item.turn_id ? { turn_id: item.turn_id } : {}),
		type: "proposed_plan",
		text: proposedPlan.planText,
		created_at: item.created_at ?? "",
		folded: false,
		metadata: {
			status: "proposed",
			source: "assistant_message",
		},
	};
	return proposedPlan.assistantText
		? [{ ...projected, text: proposedPlan.assistantText }, plan]
		: [plan];
}

function paginatedTranscript(
	sessionId: string,
	projected: readonly GatewayTranscriptItem[],
	params: JsonObject,
	readOnly = false,
): GatewayResult<"transcript.load"> {
	const before = optionalString(params.before);
	const beforeIndex = before
		? projected.findIndex((item) => item.id === before)
		: projected.length;
	const end = beforeIndex < 0 ? projected.length : beforeIndex;
	const limit = positiveInteger(params.limit);
	const selected = limit === undefined
		? projected.slice(0, end)
		: projected.slice(Math.max(0, end - limit), end);
	return {
		session_id: sessionId,
		items: selected,
		next_before: selected.length < end ? selected[0]?.id ?? null : null,
		read_only: readOnly,
	};
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value > 0
		? value
		: undefined;
}

function transcriptPageLimit(value: unknown): number {
	if (value === undefined || value === null) return 500;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 500) {
		throw new GatewayFailure("invalid_params", "limit must be an integer between 1 and 500.");
	}
	return value;
}

function extensionManifest(toolNames: readonly string[], toolManifest?: JsonObject): JsonObject {
	return {
		schema_version: 1,
		agent: { name: "mycli", version: MYCLI_VERSION, runtime: "node" },
		rpc_methods: gatewayContractCatalog.rpcMethods.map((name) => ({ name })),
		event_streams: gatewayContractCatalog.eventStreams.map((name) => ({ name })),
		capabilities: {
			no_tool_turns: true,
			tools: toolNames.length > 0,
			tool_names: toolNames,
		},
		...(toolManifest ? { tool_manifest: toolManifest } : {}),
	};
}

function integrationToolManifest(
	integrations: NodeGatewayIntegrations | undefined,
): JsonObject | undefined {
	return typeof integrations?.toolManifest === "function"
		? integrations.toolManifest()
		: integrations?.toolManifest;
}

function boundedResource(value: JsonObject): JsonObject {
	const resource: JsonObject = {};
	for (const key of ["id", "type", "name", "source", "status", "detail", "command"] as const) {
		const item = value[key];
		if (typeof item === "string" && item.trim()) {
			resource[key] = boundedString(item.trim(), key === "detail" ? 512 : 256);
		}
	}
	if (typeof value.enabled === "boolean") resource.enabled = value.enabled;
	return resource;
}

function boundedSubagent(
	value: Readonly<Record<string, unknown>>,
): JsonObject | undefined {
	const runId = boundedRequiredValue(value.run_id, 256);
	const childSessionId = boundedRequiredValue(value.child_session_id, 256);
	const role = boundedRequiredValue(value.role, 64);
	const status = boundedRequiredValue(value.status, 32);
	const summary = boundedRequiredValue(value.summary, 512);
	if (!runId || !childSessionId || !role || !status || !summary) return undefined;
	const progress = Array.isArray(value.progress)
		? value.progress.slice(0, 32).flatMap((item) => {
			if (!isObject(item)) return [];
			const kind = boundedRequiredValue(item.kind, 64);
			if (!kind) return [];
			return [{
				kind,
				...(boundedOptionalValue(item.tool_name, 128) ? {
					tool_name: boundedOptionalValue(item.tool_name, 128),
				} : {}),
					...(boundedOptionalValue(item.summary, 512) ? {
						summary: boundedOptionalValue(item.summary, 512),
					} : {}),
					...(boundedOptionalValue(item.call_id, 256) ? {
						call_id: boundedOptionalValue(item.call_id, 256),
					} : {}),
					...(boundedOptionalValue(item.status, 32) ? {
						status: boundedOptionalValue(item.status, 32),
					} : {}),
				}];
		})
		: [];
	return {
		run_id: runId,
		child_session_id: childSessionId,
		role,
		status,
		summary,
		progress,
		...boundedSubagentStrings(value),
		...(boundedNonNegativeInteger(value.tool_calls) === undefined ? {} : {
			tool_calls: boundedNonNegativeInteger(value.tool_calls),
		}),
		...(boundedNonNegativeInteger(value.total_tokens) === undefined ? {} : {
			total_tokens: boundedNonNegativeInteger(value.total_tokens),
		}),
		...(boundedNonNegativeInteger(value.duration_ms) === undefined ? {} : {
			duration_ms: boundedNonNegativeInteger(value.duration_ms),
		}),
	};
}

function boundedSubagentStrings(value: Readonly<Record<string, unknown>>): JsonObject {
	const result: JsonObject = {};
	for (const [key, limit] of [
		["parent_turn_id", 256],
		["thread_id", 256],
		["root_thread_id", 256],
		["parent_thread_id", 256],
		["agent_path", 512],
		["task_name", 64],
		["nickname", 64],
		["lifecycle_kind", 64],
		["description", 2_048],
		["mode", 32],
		["error", 4_096],
		["started_at", 64],
		["completed_at", 64],
		["path", 256],
	] as const) {
		const bounded = boundedOptionalValue(value[key], limit);
		if (bounded) result[key] = bounded;
	}
	return result;
}

function boundedNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

function boundedRequiredValue(value: unknown, limit: number): string | undefined {
	return typeof value === "string" && value.trim()
		? boundedString(value.trim(), limit)
		: undefined;
}

function boundedOptionalValue(value: unknown, limit: number): string | undefined {
	return boundedRequiredValue(value, limit);
}

function slashCommandSurface(value: unknown): SlashCommandSurface {
	if (value === "cli" || value === "tui") return value;
	throw new GatewayFailure("invalid_params", "surface must be cli or tui.");
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function aggregateUsage(rollouts: readonly JsonObject[]): Readonly<Record<string, number>> {
	const totals: Record<string, number> = { turns: rollouts.length };
	for (const rollout of rollouts) {
		const continuation = isObject(rollout.continuation_state)
			? rollout.continuation_state
			: undefined;
		const usage = continuation && isObject(continuation.usage) ? continuation.usage : undefined;
		if (!usage) continue;
		for (const [key, value] of Object.entries(usage)) {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
			totals[key.slice(0, 64)] = (totals[key.slice(0, 64)] ?? 0) + value;
		}
	}
	return totals;
}

function humanize(value: string): string {
	const normalized = value.replaceAll(/[-_]+/gu, " ").trim();
	return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : "Value";
}

function parseForkArguments(args: string, currentSessionId: string): {
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly forkPoint?: number;
} {
	const parts = shellWords(args);
	if (parts.length > 3) throw new Error("too many fork arguments");
	const sourceSessionId = parts.length >= 2 ? parts[0]! : currentSessionId;
	const targetSessionId = parts.length === 0
		? `${currentSessionId}-fork`
		: parts.length === 1
			? parts[0]!
			: parts[1]!;
	if ([sourceSessionId, targetSessionId].some((value) =>
		!value || value.length > 256 || value.includes("\0"))) {
		throw new Error("invalid session id");
	}
	if (parts.length < 3) return { sourceSessionId, targetSessionId };
	const forkPoint = Number(parts[2]);
	if (!Number.isSafeInteger(forkPoint) || forkPoint < 0 || String(forkPoint) !== parts[2]) {
		throw new Error("invalid fork point");
	}
	return { sourceSessionId, targetSessionId, forkPoint };
}

function shellWords(value: string): readonly string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const character of value.trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/u.test(character)) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}
	if (escaped || quote) throw new Error("unterminated shell word");
	if (current) words.push(current);
	return words;
}

function sessionMaintenanceAction(
	value: string,
): "report" | "empty" | "payloads" | "orphans" | "vacuum" | "transcript_normalization"
	| "content_blobs" | "content_blob_gc" | undefined {
	return {
		"": "report" as const,
		"--apply-empty": "empty" as const,
		"--apply-payloads": "payloads" as const,
		"--apply-orphans": "orphans" as const,
		"--apply-vacuum": "vacuum" as const,
		"--apply-transcript-normalization": "transcript_normalization" as const,
		"--apply-content-blobs": "content_blobs" as const,
		"--apply-content-blob-gc": "content_blob_gc" as const,
	}[value];
}

function commandObjectRows(value: JsonObject): readonly {
	readonly key: string;
	readonly label: string;
	readonly values: readonly string[];
}[] {
	return Object.entries(value).slice(0, 100).map(([key, item]) => ({
		key,
		label: humanize(key),
		values: [commandPrimitiveValue(item)],
	}));
}

function commandObjectSummary(value: JsonObject): string {
	return Object.entries(value).slice(0, 20)
		.map(([key, item]) => `${key}=${commandPrimitiveValue(item)}`)
		.join("; ") || "completed";
}

function commandPrimitiveValue(value: unknown): string {
	if (typeof value === "string") return value.slice(0, 512);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	if (Array.isArray(value)) return `items:${value.length}`;
	if (isObject(value)) return `fields:${Object.keys(value).length}`;
	return "unknown";
}

function parseModelSelection(args: string): {
	readonly model?: string;
	readonly reasoningEffort?: ReasoningEffort;
} {
	const parts = args.trim() ? args.trim().split(/\s+/u) : [];
	let model: string | undefined;
	let reasoningEffort: ReasoningEffort | undefined;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index]!;
		if (part === "--thinking-effort") {
			const value = parts[index + 1];
			if (!value) throw new GatewayFailure("invalid_arguments", "--thinking-effort requires a value.");
			reasoningEffort = reasoningEffortValue(value);
			index += 1;
			continue;
		}
		if (part.startsWith("--thinking-effort=")) {
			reasoningEffort = reasoningEffortValue(part.slice("--thinking-effort=".length));
			continue;
		}
		if (part.startsWith("--")) {
			throw new GatewayFailure("invalid_arguments", `Unsupported model option: ${part}`);
		}
		if (model) throw new GatewayFailure("invalid_arguments", "Only one model may be selected.");
		model = part.slice(0, 256);
	}
	return {
		...(model ? { model } : {}),
		...(reasoningEffort ? { reasoningEffort } : {}),
	};
}

function reasoningEffortValue(value: string): ReasoningEffort {
	if (["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value)) {
		return value as ReasoningEffort;
	}
	throw new GatewayFailure("invalid_arguments", "Unsupported thinking effort.");
}

function memoryRows(memories: readonly JsonObject[]): readonly {
	readonly key: string;
	readonly label: string;
	readonly values: readonly string[];
	readonly status?: string;
	readonly detail?: string;
}[] {
	return memories.slice(0, 100).map((memory, index) => ({
		key: `memory:${index}:${String(memory.filename ?? "entry")}`,
		label: String(memory.name ?? memory.filename ?? "Memory"),
		values: [String(memory.filename ?? "")].filter(Boolean),
		...(typeof memory.kind === "string" ? { status: memory.kind } : {}),
		...(typeof memory.description === "string" && memory.description
			? { detail: memory.description }
			: {}),
	}));
}

function parseMemoryAdd(value: string): {
	readonly kind: "user" | "feedback" | "project" | "reference";
	readonly name: string;
	readonly description: string;
	readonly content: string;
} {
	const separator = value.indexOf("::");
	if (separator < 0) {
		throw new GatewayFailure("invalid_arguments", "Use /memory add <type> <name> :: <content>.");
	}
	const header = value.slice(0, separator).trim();
	const content = value.slice(separator + 2).trim();
	const [rawKind, ...nameParts] = header.split(/\s+/u);
	const name = nameParts.join(" ").trim();
	if (!isMemoryKind(rawKind) || !name || !content) {
		throw new GatewayFailure("invalid_arguments", "Use /memory add <type> <name> :: <content>.");
	}
	return { kind: rawKind, name, description: name, content };
}

function isMemoryKind(value: string | undefined): value is "user" | "feedback" | "project" | "reference" {
	return value === "user" || value === "feedback" || value === "project" || value === "reference";
}

function requiredCommandPattern(value: string): string {
	const pattern = value.trim();
	if (!pattern || pattern.length > 512 || pattern.includes("\0")) {
		throw new GatewayFailure("invalid_arguments", "Command pattern is invalid.");
	}
	return pattern;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: string, limit: number): string {
	return value.slice(0, limit);
}

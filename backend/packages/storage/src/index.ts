export { SessionGoalRepository } from "./sessions/session-goal-repository.ts";
export type { SessionGoalStore, GoalCommit } from "./sessions/session-goal-repository.ts";
export {
	MessageIdConflictError,
	projectMutationMetadata,
	SessionInUseError,
	SessionMetadataConflictError,
	SessionStateError,
	StorageFailure,
} from "./sessions/session-store.ts";
export {
	SESSION_CONTENT_BLOB_LOAD_MANY_MAX_IDS,
	SQLiteSessionContentBlobRepository,
} from "./artifacts/session-content-blob-repository.ts";
export type {
	SessionContentBlobCollectionResult,
	SessionContentBlobMetrics,
	SessionContentBlobRepository,
	SQLiteSessionContentBlobRepositoryOptions,
} from "./artifacts/session-content-blob-repository.ts";
export { analyzeV10ContentBlobMigration } from "./migrations/v10/v10-content-blob-migration-dry-run.ts";
export type {
	V10ContentBlobActiveWriterState,
	V10ContentBlobFtsRebuildWork,
	V10ContentBlobMigrationBatchPlan,
	V10ContentBlobMigrationDryRunOptions,
	V10ContentBlobMigrationDryRunReport,
	V10ContentBlobTemporarySpace,
} from "./migrations/v10/v10-content-blob-migration-dry-run.ts";
export {
	discardV10ContentBlobMigrationStaging,
	reconcileV10ContentBlobMigrationBatchInTransaction,
	stageV10ContentBlobMigrationBatch,
	V10_CONTENT_BLOB_MIGRATION_DROP_STAGING_SQL,
	V10_CONTENT_BLOB_MIGRATION_STAGING_COLUMNS,
	V10_CONTENT_BLOB_MIGRATION_STAGING_SQL,
	V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES,
	V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION,
} from "./migrations/v10/v10-content-blob-migration-staging.ts";
export {
	v10ModelInputSourceHash,
	v10TranscriptSourceHash,
} from "./migrations/v10/v10-content-blob-migration-source-hash.ts";
export type {
	V10ModelInputSourceHashRow,
	V10TranscriptSourceHashRow,
} from "./migrations/v10/v10-content-blob-migration-source-hash.ts";
export type {
	DiscardV10ContentBlobMigrationStagingOptions,
	ReconcileV10ContentBlobMigrationBatchOptions,
	StageV10ContentBlobMigrationBatchOptions,
	V10ContentBlobMigrationStagingBatchResult,
	V10ContentBlobMigrationStagingDiscardResult,
	V10ContentBlobMigrationStagingFailpoint,
} from "./migrations/v10/v10-content-blob-migration-staging.ts";
export {
	applyV10ContentBlobMigrationCutover,
	V10_CONTENT_BLOB_CUTOVER_MINIMUM_FREE_BYTES,
	V10_CONTENT_BLOB_CUTOVER_STAGES,
} from "./migrations/v10/v10-content-blob-migration-cutover.ts";
export type {
	ApplyV10ContentBlobMigrationCutoverOptions,
	V10ContentBlobCutoverStage,
	V10ContentBlobMigrationCutoverResult,
} from "./migrations/v10/v10-content-blob-migration-cutover.ts";
export type {
	AppendSessionSummaryInput,
	AppendAssistantToolCallsInput,
	AppendContextItemInput,
	AppendToolResultInput,
	StoredPlanUpdate,
	StoredToolActivation,
	ApprovalCheckpoint,
	ApprovalTransitionInput,
	CommitCompactionInput,
	CompareAndSetStateInput,
	CommitApprovalResultInput,
	CommitClarificationResponseInput,
	CommitQueuedInputsInput,
	CompleteStoredTurnInput,
	FailStoredTurnInput,
	FinalizeApprovalContinuationInput,
	HistoryItemWindow,
	ForkSessionInput,
	ForkSessionResult,
	ForkAgentConversationInput,
	ForkAgentConversationResult,
	ImportLegacyConversationInput,
	InterruptAmbiguousApprovalInput,
	ProjectedFileChange,
	ProjectedMutationMetadata,
	ReserveTurnInput,
	RuntimeTurnStore,
	RuntimeStateKey,
	SaveQueueSnapshotInput,
	SaveApprovalSuspensionInput,
	SaveParallelApprovalBatchInput,
	SaveClarificationSuspensionInput,
	SaveStateInput,
	SessionLineageNode,
	SessionListQuery,
	SessionEmptyCleanupResult,
	SessionContentBlobMaintenanceMetrics,
	SessionContentBlobOrphanCleanupResult,
	SessionMaintenanceCandidate,
	SessionMaintenanceOptions,
	SessionMaintenanceReport,
	SessionPayloadCleanupResult,
	SessionOrphanCleanupResult,
	SessionOverview,
	SessionLeaseState,
	SessionMetadata,
	SessionPendingState,
	SessionStateBatchEntry,
	SequencedHistoryItem,
	SessionSearchQuery,
	SessionSearchResult,
	SessionLeaseStore,
	SessionStateErrorCode,
	SessionStateSource,
	SessionStateStore,
	SessionStorageMetrics,
	SessionStore,
	SessionVacuumResult,
	TurnStore,
	TurnReservation,
	StoredTurnTerminalization,
	TerminalizeStoredTurnInput,
	TurnTerminalizationStore,
	UpdateSessionMetadataInput,
} from "./sessions/session-store.ts";
export { SQLiteTurnTerminalizationRepository } from "./sessions/turn-terminalization-repository.ts";
export { SQLiteProviderAttemptLedger } from "./projections/provider-attempt-ledger.ts";
export type {
	ProviderAttemptLedgerStore,
	AppendProviderAttemptInput,
	ListProviderAttemptsInput,
	CloseInterruptedProviderAttemptsInput,
	ProviderAttemptLedgerFailpoint,
	SQLiteProviderAttemptLedgerOptions,
} from "./projections/provider-attempt-ledger.ts";
export type {
	SQLiteTurnTerminalizationRepositoryOptions,
	TurnTerminalizationFailpoint,
} from "./sessions/turn-terminalization-repository.ts";
export {
	BACKFILL_SEARCH_SQL,
	SCHEMA_V2_SQL,
	SCHEMA_V5_SQL,
	SCHEMA_V6_SQL,
	SCHEMA_V7_SQL,
	SCHEMA_V8_SQL,
	SCHEMA_V9_SQL,
	SCHEMA_V10_SQL,
	SCHEMA_V10_LEGACY_CLEANUP_SQL,
	SCHEMA_V10_LINEAGE_SQL,
	SCHEMA_V10_TRANSCRIPT_SQL,
	SCHEMA_V10_VERSION,
	SCHEMA_V11_CONTENT_BLOB_SQL,
	SCHEMA_V11_CONTENTLESS_FTS_SQL,
	SCHEMA_V11_CONTENT_REFERENCE_SQL,
	SCHEMA_V11_SQL,
	SCHEMA_V11_TRANSCRIPT_SQL,
	SCHEMA_V11_VERSION,
	SCHEMA_V12_PROVIDER_LEDGER_SQL,
	SCHEMA_V12_SQL,
	SCHEMA_V12_VERSION,
	SCHEMA_V13_SQL,
	SCHEMA_V13_PROVIDER_ATTEMPTS_SQL,
	SCHEMA_V13_VERSION,
	SCHEMA_V14_VERSION,
	SCHEMA_V15_VERSION,
	SESSION_RUNTIME_LEASE_SQL,
	SCHEMA_VERSION,
	TRANSCRIPT_PROJECTION_INDEX_SQL,
} from "./schema.ts";
export {
	createV10SessionDatabase,
	createV11SessionDatabase,
	createV12SessionDatabase,
	SQLiteTranscriptEventRepository,
} from "./transcript/transcript-event-repository.ts";
export { projectTranscriptEventsToProviderItems } from "./projections/transcript-provider-projector.ts";
export type { TranscriptProviderProjectionOptions } from "./projections/transcript-provider-projector.ts";
export { projectTranscriptEventsToReadableItems } from "./projections/transcript-readable-projector.ts";
export { projectTranscriptEventToSearchDocument } from "./projections/transcript-search-projector.ts";
export type { TranscriptSearchDocument } from "./projections/transcript-search-projector.ts";
export type {
	SQLiteTranscriptEventRepositoryOptions,
	TranscriptEventWindow,
	TranscriptEventWindowOptions,
	TranscriptEventRepository,
	TranscriptReadablePage,
	TranscriptReadablePageOptions,
	TranscriptTurnEventWindowOptions,
} from "./transcript/transcript-event-repository.ts";
export { SQLiteAgentEffectLedger } from "./agents/agent-effect-ledger.ts";
export type {
	AgentEffectAttempt,
	AgentEffectAttemptKind,
	AgentEffectAttemptReservation,
	AgentEffectAttemptState,
	AgentEffectAttemptTerminalState,
	AgentEffectLedgerStore,
	CompleteAgentEffectAttemptInput,
	RecoverInterruptedToolAttemptsInput,
	ReserveAgentEffectAttemptInput,
	SQLiteAgentEffectLedgerOptions,
} from "./agents/agent-effect-ledger.ts";
export { SQLiteSessionStore } from "./sessions/sqlite-session-store.ts";
export type { SQLiteSessionStoreOptions } from "./sessions/sqlite-session-store.ts";
export { openRuntimeSessionStore } from "./sessions/runtime-session-store.ts";
export type {
	OpenRuntimeSessionStoreOptions,
	RuntimeSessionStore,
} from "./sessions/runtime-session-store.ts";
export {
	MODEL_INPUT_CONTENT_BLOB_MARKER_JSON,
	SQLiteModelInputLedger,
} from "./projections/model-input-ledger.ts";
export type {
	AppendProviderStepEventInput,
	CommitProviderStepInput,
	CommittedProviderStep,
	ModelInputLedgerFailpoint,
	ModelInputLedgerStore,
	ProviderRequestReference,
	RecoverUnconfirmedProviderStepsInput,
	SQLiteModelInputLedgerOptions,
	UnconfirmedProviderStep,
} from "./projections/model-input-ledger.ts";
export type {
	ProviderStepLifecycleEvent,
	ProviderStepLifecyclePayload,
	ProviderStepLifecycleState,
} from "./projections/model-input-validation.ts";
export { SQLiteAgentThreadRepository } from "./agents/agent-thread-store.ts";
export type {
	AgentRuntimeCheckpoint,
	AgentRuntimeLease,
		AgentRuntimeReconciliationResult,
		AgentSpawnReservation,
		AgentSpawnStore,
		AgentThreadListQuery,
	AgentThreadRecord,
	AgentThreadStore,
		ReserveAgentThreadInput,
		ReserveAgentSpawnInput,
	SaveAgentRuntimeLeaseInput,
	SQLiteAgentThreadRepositoryOptions,
	TransitionAgentThreadInput,
} from "./agents/agent-thread-store.ts";
export { SQLiteAgentLifecycleRepository } from "./agents/agent-lifecycle-store.ts";
export type {
	AgentLifecycleFailpoint,
	AgentLifecycleStore,
	AgentLifecycleTransition,
	SQLiteAgentLifecycleRepositoryOptions,
} from "./agents/agent-lifecycle-store.ts";
export { SQLiteAgentMailboxRepository } from "./agents/agent-mailbox-store.ts";
export type {
	AgentMailboxEnqueueResult,
	AgentMailboxListQuery,
	AgentMailboxStore,
	EnqueueAgentMailboxItemInput,
	SQLiteAgentMailboxRepositoryOptions,
	TransitionAgentMailboxItemInput,
} from "./agents/agent-mailbox-store.ts";
export {
	SessionArtifactPaths,
	StorageIdentityError,
	subagentRunId,
	validateStorageIdentity,
} from "./artifacts/session-artifact-paths.ts";
export {
	SessionArtifactStore,
	sessionSubagentIndexEntry,
} from "./artifacts/session-artifact-store.ts";
export type {
	AppendSessionArtifactEventInput,
	SessionArtifactEventType,
	SessionArtifactFailpoint,
	SessionArtifactOperations,
	SessionArtifactStoreOptions,
	SessionSubagentIndexEntry,
	SessionSubagentSnapshot,
	WriteSubagentSnapshotInput,
	WriteTaskOutputInput,
} from "./artifacts/session-artifact-store.ts";
export {
	SUBAGENT_TASK_DESCRIPTION_MAX_CHARS,
	SUBAGENT_TASK_ERROR_MAX_CHARS,
	SUBAGENT_TASK_OUTPUT_REFERENCE_MAX_CHARS,
	SUBAGENT_TASK_PROGRESS_MAX_CHARS,
	SUBAGENT_TASK_REPORT_MAX_CHARS,
} from "./agents/subagent-task-store.ts";
export type {
	CompleteSubagentTaskInput,
	FailSubagentTaskInput,
	InterruptSubagentTaskInput,
	ReserveSubagentTaskInput,
	SubagentTaskOwnership,
	SubagentTaskPayload,
	SubagentTaskRecord,
	SubagentTaskStatus,
	SubagentTaskStore,
	SubagentTaskUsage,
	UpdateSubagentTaskProgressInput,
} from "./agents/subagent-task-store.ts";
export { SQLiteSessionStateRepository } from "./sessions/sqlite-session-state.ts";
export type { SQLiteSessionStateRepositoryOptions } from "./sessions/sqlite-session-state.ts";
export {
	SHELL_TRANSCRIPT_OUTPUT_MAX_CHARS,
	SHELL_TRANSCRIPT_CHUNK_MAX_CHARS,
	SHELL_TRANSCRIPT_PAGE_DEFAULT_CHARS,
	SHELL_TRANSCRIPT_PAGE_MAX_CHARS,
	shellOutputPageLimit,
	sanitizeShellSnapshotPayload,
	shellHistoryItem,
	validateShellOutputChunk,
	validateShellOutputPageInput,
} from "./transcript/shell-transcript-store.ts";
export type {
	LoadShellOutputPageInput,
	ShellOutputChunk,
	ShellOutputChunkInput,
	ShellOutputPage,
	ShellOutputTranscriptReader,
	ValidatedShellOutputPageInput,
	ShellTranscriptStore,
	UpsertShellSnapshotInput,
} from "./transcript/shell-transcript-store.ts";
export {
	projectTranscript,
	TRANSCRIPT_TEXT_MAX_CHARS,
} from "./projections/transcript-projector.ts";
export type {
	TranscriptItem,
	TranscriptItemType,
	TranscriptProjectionOptions,
} from "./projections/transcript-projector.ts";
export {
	compareTranscriptEventOrder,
	deterministicLegacyTranscriptEventId,
	parseTranscriptEventEnvelope,
	parseTranscriptEventAppendInput,
	TranscriptEventContractError,
	TRANSCRIPT_EVENT_MAX_BATCH_ITEMS,
	TRANSCRIPT_EVENT_SCHEMA_VERSION,
} from "./transcript/transcript-events.ts";
export type {
	AssistantOutputTranscriptPayload,
	AssistantToolCallBatchTranscriptPayload,
	AppendTranscriptDisplayActivityInput,
	AppendCompactionActivityInput,
	CompactionTranscriptPayload,
	ContextTranscriptPayload,
	DisplayActivityTranscriptPayload,
	OpaqueLegacyTranscriptPayload,
	RollbackTranscriptPayload,
	ToolResultTranscriptPayload,
	TranscriptDisplayActivityType,
	TranscriptEventEnvelope,
	TranscriptEventAppendInput,
	TranscriptEventPayloadByType,
	TranscriptEventType,
	TranscriptJsonValue,
	TranscriptLegacyErrorCode,
	TranscriptLegacySourceKind,
	TranscriptLifecyclePhase,
	TranscriptReadableProjection,
	TurnLifecycleTranscriptPayload,
	UserInputTranscriptPayload,
} from "./transcript/transcript-events.ts";
export {
	contentBlobId,
	decodeSessionContentBlob,
	decodeSessionContentBlobUtf8,
	encodeSessionContentBlob,
	SESSION_CONTENT_BLOB_EXTERNALIZATION_THRESHOLD_BYTES,
	SESSION_CONTENT_BLOB_MAX_RAW_BYTES,
	SESSION_CONTENT_BLOB_MIN_COMPRESSION_SAVINGS_BYTES,
} from "./artifacts/session-content-blob.ts";
export type {
	EncodedSessionContentBlob,
	SessionContentBlobCodec,
	StoredSessionContentBlob,
} from "./artifacts/session-content-blob.ts";
export {
	externalizeTranscriptPayload,
	hydrateTranscriptPayload,
} from "./artifacts/transcript-payload-blobs.ts";
export type {
	ExternalizedTranscriptPayload,
	ExternalizeTranscriptPayloadOptions,
	HydrateTranscriptPayloadOptions,
	LoadSessionContentBlob,
	TranscriptPayloadBlobReference,
} from "./artifacts/transcript-payload-blobs.ts";
export { analyzeV10ContentBlobs } from "./migrations/v10/v10-content-blob-analyzer.ts";
export type {
	AnalyzeV10ContentBlobsOptions,
	V10ContentBlobAnalysis,
	V10ContentBlobMigrationHeadroom,
	V10ContentBlobSourceAnalysis,
	V10ContentBlobSourceName,
} from "./migrations/v10/v10-content-blob-analyzer.ts";
export { analyzeV9TranscriptStorage } from "./migrations/v9/v9-transcript-analyzer.ts";
export type {
	AnalyzeV9TranscriptStorageOptions,
	V9TranscriptInvalidProjectionMetrics,
	V9TranscriptLargeContentMetrics,
	V9TranscriptLegacyShape,
	V9TranscriptLegacyShapeCount,
	V9TranscriptMigrationHeadroom,
	V9TranscriptStorageAnalysis,
	V9TranscriptTableMetrics,
	V9TranscriptTableName,
	V9TranscriptTurnAmplificationMetrics,
} from "./migrations/v9/v9-transcript-analyzer.ts";
export {
	stageV9TranscriptNormalizationBatch,
	V9_TRANSCRIPT_NORMALIZATION_MINIMUM_FREE_BYTES,
	V9_TRANSCRIPT_NORMALIZATION_STAGING_SQL,
	V9_TRANSCRIPT_NORMALIZATION_STAGING_VERSION,
} from "./migrations/v9/v9-normalization-staging.ts";
export type {
	StageV9TranscriptNormalizationBatchOptions,
	V9TranscriptNormalizationStagingBatchResult,
} from "./migrations/v9/v9-normalization-staging.ts";
export {
	applyV9TranscriptNormalizationCutover,
	V9_TRANSCRIPT_NORMALIZATION_CUTOVER_STAGES,
} from "./migrations/v9/v9-normalization-cutover.ts";
export type {
	ApplyV9TranscriptNormalizationCutoverOptions,
	V9TranscriptNormalizationCutoverStage,
	V9TranscriptNormalizationCutoverResult,
} from "./migrations/v9/v9-normalization-cutover.ts";
export { analyzeV9TranscriptNormalization } from "./migrations/v9/v9-normalization-dry-run.ts";
export type {
	AnalyzeV9TranscriptNormalizationOptions,
	V9TranscriptNormalizationBatchProgress,
	V9TranscriptNormalizationDryRunReport,
	V9TranscriptNormalizationSavings,
	V9TranscriptNormalizationSourceCoverage,
	V9TranscriptNormalizationTemporarySpace,
} from "./migrations/v9/v9-normalization-dry-run.ts";
export {
	createV9ProjectionManifest,
	V9_PROJECTION_MANIFEST_VERSION,
} from "./migrations/v9/v9-projection-manifest.ts";
export type {
	CreateV9ProjectionManifestOptions,
	V9ProjectionDigest,
	V9ProjectionErrorCode,
	V9ProjectionManifest,
	V9ProviderLedgerManifest,
	V9ProviderLedgerTableManifest,
	V9SessionProjectionManifest,
} from "./migrations/v9/v9-projection-manifest.ts";
export {
	SnapshotStateError,
	TranscriptSnapshotStore,
} from "./transcript/transcript-snapshot-store.ts";
export {
	snapshotRequestSummary,
	snapshotSessionMetadata,
} from "./transcript/transcript-snapshot-metadata.ts";
export type {
	TranscriptSnapshotCoverage,
	TranscriptSnapshotRequestSummary,
	TranscriptSnapshotSessionMetadata,
	TranscriptSnapshotWindow,
} from "./transcript/transcript-snapshot-metadata.ts";
export type {
	LegacySnapshotMessage,
	TranscriptSessionState,
	TranscriptSnapshotFailpoint,
	TranscriptSnapshotLoadResult,
	TranscriptSnapshotOperations,
	TranscriptSnapshotProject,
	TranscriptSnapshotStoreOptions,
	TranscriptSnapshotV2,
	TranscriptSubagentIndexEntry,
} from "./transcript/transcript-snapshot-store.ts";

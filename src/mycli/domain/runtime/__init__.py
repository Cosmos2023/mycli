from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from mycli.domain.conversation import Message
from mycli.domain.memory import MemoryRecord
from mycli.domain.providers import ProtocolId, ProviderId
from mycli.domain.runtime.approvals import (
    ApprovalStatus as ApprovalStatus,
    PendingApproval as PendingApproval,
)
from mycli.domain.runtime.background_jobs import (
    BackgroundJobSummary as BackgroundJobSummary,
)
from mycli.domain.runtime.clarifications import (
    PendingClarification as PendingClarification,
)
from mycli.domain.runtime.canonical_timeline import (
    CanonicalTimelineDurability as CanonicalTimelineDurability,
    CanonicalTimelineItem as CanonicalTimelineItem,
    CanonicalTimelineRole as CanonicalTimelineRole,
    CanonicalTimelineScope as CanonicalTimelineScope,
)
from mycli.domain.runtime.blocks import (
    BlockType as BlockType,
    ModelTurnResult as ModelTurnResult,
    RuntimeBlock as RuntimeBlock,
    RuntimeItem as RuntimeItem,
    RuntimeRole as RuntimeRole,
)
from mycli.domain.runtime.compaction_rehydration import (
    CompactionRehydrationContext as CompactionRehydrationContext,
    FileRehydrationCandidate as FileRehydrationCandidate,
    InvokedSkillSnapshot as InvokedSkillSnapshot,
    RehydratedFile as RehydratedFile,
    RehydratedSkill as RehydratedSkill,
    RehydrationBudget as RehydrationBudget,
)
from mycli.domain.runtime.events import (
    RUNTIME_EVENT_ENVELOPE_VERSION as RUNTIME_EVENT_ENVELOPE_VERSION,
    RuntimeEvent as RuntimeEvent,
    RuntimeEventEnvelope as RuntimeEventEnvelope,
    RuntimeEventType as RuntimeEventType,
)
from mycli.domain.runtime.gateway_contract import (
    SUPPORTED_GATEWAY_EVENT_STREAMS as SUPPORTED_GATEWAY_EVENT_STREAMS,
    SUPPORTED_GATEWAY_RPC_METHODS as SUPPORTED_GATEWAY_RPC_METHODS,
)
from mycli.domain.runtime.planning import (
    PlanItem as PlanItem,
    PlanState as PlanState,
    PlanStatus as PlanStatus,
)
from mycli.domain.runtime.request_shape import (
    FragmentStability as FragmentStability,
    ProviderCachePolicyCapability as ProviderCachePolicyCapability,
    ProviderMessageShape as ProviderMessageShape,
    ProviderProjectionLane as ProviderProjectionLane,
    ProviderProjectionShape as ProviderProjectionShape,
    ProviderRequestPolicyShape as ProviderRequestPolicyShape,
    ProviderRuntimeItemShape as ProviderRuntimeItemShape,
    RequestFragment as RequestFragment,
    RequestFragmentKind as RequestFragmentKind,
    RequestShape as RequestShape,
    stable_hash as stable_hash,
)
from mycli.domain.runtime.protocol import (
    StopReason as StopReason,
    TurnItem as TurnItem,
    TurnItemType as TurnItemType,
    TurnRecord as TurnRecord,
    TurnStatus as TurnStatus,
)
from mycli.domain.runtime.turn_context import (
    TurnContext as TurnContext,
    TurnContextCacheClass as TurnContextCacheClass,
    TurnContextSection as TurnContextSection,
    TurnContextSectionType as TurnContextSectionType,
)
from mycli.domain.runtime.instruction_contract import (
    InstructionContract as InstructionContract,
    InstructionFragment as InstructionFragment,
    InstructionFragmentKind as InstructionFragmentKind,
)
from mycli.domain.runtime.execution_policy import (
    ApprovalGate as ApprovalGate,
    ExecutionPolicy as ExecutionPolicy,
    RuntimeEnvironmentContract as RuntimeEnvironmentContract,
    SandboxProfile as SandboxProfile,
    ShellBackendProfile as ShellBackendProfile,
    ShellExecutionOptions as ShellExecutionOptions,
    ToolRuntimeDecision as ToolRuntimeDecision,
    ToolRuntimeDecisionKind as ToolRuntimeDecisionKind,
    ToolRuntimeEffect as ToolRuntimeEffect,
    ToolRuntimeResult as ToolRuntimeResult,
)
from mycli.domain.runtime.execpolicy import (
    ExecPolicyDecision as ExecPolicyDecision,
    ExecPolicyMatch as ExecPolicyMatch,
    ExecPolicyRule as ExecPolicyRule,
    ExecPolicyRuleSet as ExecPolicyRuleSet,
    ExecPolicySource as ExecPolicySource,
)
from mycli.domain.runtime.session_history import (
    BaselineFragment as BaselineFragment,
    ContextBaseline as ContextBaseline,
    HistoryItem as HistoryItem,
    HistoryItemType as HistoryItemType,
    SessionRuntimeSnapshot as SessionRuntimeSnapshot,
    TurnRollout as TurnRollout,
    TurnRolloutEvent as TurnRolloutEvent,
)
from mycli.domain.runtime.turn_state import SuspendedTurn as SuspendedTurn
from mycli.domain.runtime.tracing import RuntimeTraceEvent as RuntimeTraceEvent
from mycli.domain.tooling.exposure import (
    ToolExposure as ToolExposure,
    ToolExposureEntry as ToolExposureEntry,
    ToolExposureKind as ToolExposureKind,
    ToolRouteKey as ToolRouteKey,
    ToolRouteSource as ToolRouteSource,
)
from mycli.domain.tooling.calls import ToolCall


class RiskLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ReasoningEffort(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    XHIGH = "xhigh"


class ViewMode(StrEnum):
    DEFAULT = "default"
    VERBOSE = "verbose"
    FOCUS = "focus"


class DecisionKind(StrEnum):
    NEEDS_CHOICE = "needs_choice"
    AUTO_ALLOW = "auto_allow"
    DENY = "deny"


class DecisionAction(StrEnum):
    APPROVE_ONCE = "approve_once"
    REJECT = "reject"
    ALLOW_SESSION = "allow_session"


@dataclass(slots=True, frozen=True)
class AgentConfig:
    workspace_root: Path
    provider: ProviderId = ProviderId.OPENAI
    model: str = "gpt-5"
    protocol: ProtocolId = ProtocolId.RESPONSES
    api_base_url: str = "https://api.openai.com/v1"
    api_key: str | None = None
    session_id: str = "default"
    max_prompt_tokens: int = 12000
    max_output_tokens: int = 2048
    fallback_model: str | None = None
    cache_policy_capability: ProviderCachePolicyCapability | None = None
    transport_retry_limit: int = 2
    output_limit_escalation_max_tokens: int = 65_536
    output_recovery_retry_limit: int = 3
    heartbeat_enabled: bool = True
    heartbeat_interval_seconds: float = 30.0
    view_mode: ViewMode = ViewMode.DEFAULT
    statusline_enabled: bool = True
    tui_startup_mark: str = "default"
    reasoning_effort: ReasoningEffort = ReasoningEffort.MEDIUM
    thinking_enabled: bool = True
    thinking_effort: ReasoningEffort | None = ReasoningEffort.MEDIUM
    compression_threshold_tokens: int = 8000
    compaction_l4_trigger_ratio: float = 0.9
    compaction_l4_buffer_tokens: int = 13_000
    compaction_l4_min_savings_ratio: float | None = None
    compaction_l4_input_cost_per_1k: float = 0.0
    compaction_l4_output_cost_per_1k: float = 0.0
    compaction_l4_carry_cost_per_1k: float = 0.0
    compaction_l4_expected_summary_tokens: int = 500
    compaction_l4_carry_turns: int = 1
    compaction_l4_summarizer_model: str | None = None
    compaction_l4_trigger_ratios_by_model: dict[str, float] = field(default_factory=dict)
    compaction_rehydration_file_max_total_tokens: int = 50_000
    compaction_rehydration_file_max_item_tokens: int = 5_000
    compaction_rehydration_skill_max_total_tokens: int = 25_000
    compaction_rehydration_skill_max_item_tokens: int = 5_000
    compaction_rehydration_max_files: int = 5
    compaction_rehydration_max_skills: int = 5
    usage_input_cost_per_1k: float = 0.0
    usage_output_cost_per_1k: float = 0.0
    usage_cache_read_cost_per_1k: float = 0.0
    usage_cache_write_cost_per_1k: float = 0.0
    recent_message_count: int = 6
    auto_approve_medium: bool = True
    max_tool_calls_per_turn: int = 25
    max_tokens_per_turn: int = 200_000
    max_same_tool_calls: int = 4
    no_progress_threshold: int = 6
    force_answer_threshold: int = 12
    reroute_threshold: int = 3


@dataclass(slots=True, frozen=True)
class PendingDecision:
    tool_call: ToolCall
    kind: DecisionKind
    reason: str
    preview: str
    options: tuple[DecisionAction, ...]
    command_pattern: str | None = None

    def __post_init__(self) -> None:
        if not self.options:
            raise ValueError("PendingDecision must declare at least one option.")
        if len(self.options) != len(set(self.options)):
            raise ValueError("PendingDecision options must be unique.")
        pattern = self.command_pattern
        if pattern is not None and not pattern.strip():
            raise ValueError("command_pattern cannot be blank.")
        if DecisionAction.ALLOW_SESSION in self.options:
            if not pattern:
                raise ValueError("PendingDecision that allows sessions requires a non-empty command_pattern.")
        elif pattern:
            raise ValueError(
                "PendingDecision without ALLOW_SESSION cannot hold a non-empty command_pattern."
            )


@dataclass(slots=True, frozen=True)
class SessionCommandAllowance:
    command_pattern: str

    def __post_init__(self) -> None:
        if not self.command_pattern or not self.command_pattern.strip():
            raise ValueError("SessionCommandAllowance requires a non-empty command_pattern.")


@dataclass(slots=True, frozen=True)
class ExecutionContext:
    config: AgentConfig
    memory_records: tuple[MemoryRecord, ...] = ()
    skill_catalog: str = ""
    tool_exposure: ToolExposure | None = None
    available_tool_names: tuple[str, ...] = ()
    plan_state: PlanState = field(default_factory=PlanState)
    conversation_messages: tuple[Message, ...] = ()
    conversation_summary: str | None = None
    history_items: tuple[HistoryItem, ...] = ()
    context_baseline: ContextBaseline | None = None
    runtime_reminders: tuple[str, ...] = ()
    compaction_rehydration: CompactionRehydrationContext = field(
        default_factory=CompactionRehydrationContext
    )
    runtime_environment: RuntimeEnvironmentContract | None = None
    context_file_content: str = ""
    context_file_diagnostics: dict[str, object] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class ModelDecision:
    assistant_message: str | None = None
    progress_message: str | None = None
    tool_call: ToolCall | None = None
    done: bool = False


@dataclass(slots=True, frozen=True)
class ActivityEvent:
    kind: str
    message: str
    tool_name: str | None = None
    path: str | None = None
    query: str | None = None
    preview: str | None = None


@dataclass(slots=True, frozen=True)
class RuntimeStreamEvent:
    kind: str
    text: str = ""
    tool_name: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class TurnResponse:
    assistant_message: str
    activity_events: tuple[ActivityEvent, ...] = field(default_factory=tuple)
    streamed_chunks: tuple[str, ...] = field(default_factory=tuple)
    error_details: tuple[str, ...] = field(default_factory=tuple)
    progress_updates: tuple[str, ...] = field(default_factory=tuple)
    plan_steps: tuple[str, ...] = field(default_factory=tuple)
    pending_decision: PendingDecision | None = None
    turn: TurnRecord | None = None


__all__ = [
    "AgentConfig",
    "ApprovalStatus",
    "ActivityEvent",
    "BackgroundJobSummary",
    "BlockType",
    "BaselineFragment",
    "CompactionRehydrationContext",
    "ContextBaseline",
    "DecisionAction",
    "DecisionKind",
    "ExecutionContext",
    "ExecutionPolicy",
    "FileRehydrationCandidate",
    "FragmentStability",
    "HistoryItem",
    "HistoryItemType",
    "InstructionContract",
    "InstructionFragment",
    "InstructionFragmentKind",
    "InvokedSkillSnapshot",
    "ModelDecision",
    "ModelTurnResult",
    "PendingApproval",
    "PendingClarification",
    "PendingDecision",
    "ApprovalGate",
    "PlanItem",
    "PlanState",
    "PlanStatus",
    "ProviderMessageShape",
    "ProviderCachePolicyCapability",
    "ProviderRequestPolicyShape",
    "ProviderRuntimeItemShape",
    "RequestFragment",
    "RequestFragmentKind",
    "RequestShape",
    "RiskLevel",
    "RehydratedFile",
    "RehydratedSkill",
    "RehydrationBudget",
    "RUNTIME_EVENT_ENVELOPE_VERSION",
    "RuntimeBlock",
    "RuntimeEvent",
    "RuntimeEventEnvelope",
    "RuntimeEventType",
    "RuntimeEnvironmentContract",
    "RuntimeItem",
    "RuntimeRole",
    "RuntimeStreamEvent",
    "RuntimeTraceEvent",
    "SessionCommandAllowance",
    "SandboxProfile",
    "ShellBackendProfile",
    "ShellExecutionOptions",
    "SessionRuntimeSnapshot",
    "StopReason",
    "SuspendedTurn",
    "TurnItem",
    "TurnContext",
    "TurnContextCacheClass",
    "TurnContextSection",
    "TurnContextSectionType",
    "TurnItemType",
    "ViewMode",
    "ToolExposure",
    "ToolExposureEntry",
    "ToolExposureKind",
    "ToolRouteKey",
    "ToolRouteSource",
    "ToolRuntimeDecision",
    "ToolRuntimeDecisionKind",
    "ToolRuntimeEffect",
    "ToolRuntimeResult",
    "TurnRecord",
    "TurnResponse",
    "TurnRollout",
    "TurnRolloutEvent",
    "TurnStatus",
    "stable_hash",
]

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
from mycli.domain.runtime.blocks import (
    BlockType as BlockType,
    ModelTurnResult as ModelTurnResult,
    RuntimeBlock as RuntimeBlock,
    RuntimeItem as RuntimeItem,
    RuntimeRole as RuntimeRole,
)
from mycli.domain.runtime.events import (
    RuntimeEvent as RuntimeEvent,
    RuntimeEventType as RuntimeEventType,
)
from mycli.domain.runtime.planning import (
    PlanItem as PlanItem,
    PlanState as PlanState,
    PlanStatus as PlanStatus,
)
from mycli.domain.runtime.request_shape import (
    FragmentStability as FragmentStability,
    ProviderMessageShape as ProviderMessageShape,
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
    TurnContextSection as TurnContextSection,
    TurnContextSectionType as TurnContextSectionType,
)
from mycli.domain.runtime.instruction_contract import (
    InstructionContract as InstructionContract,
    InstructionFragment as InstructionFragment,
    InstructionFragmentKind as InstructionFragmentKind,
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
    "BlockType",
    "BaselineFragment",
    "ContextBaseline",
    "DecisionAction",
    "DecisionKind",
    "ExecutionContext",
    "FragmentStability",
    "HistoryItem",
    "HistoryItemType",
    "InstructionContract",
    "InstructionFragment",
    "InstructionFragmentKind",
    "ModelDecision",
    "ModelTurnResult",
    "PendingApproval",
    "PendingDecision",
    "PlanItem",
    "PlanState",
    "PlanStatus",
    "ProviderMessageShape",
    "ProviderRuntimeItemShape",
    "RequestFragment",
    "RequestFragmentKind",
    "RequestShape",
    "RiskLevel",
    "RuntimeBlock",
    "RuntimeEvent",
    "RuntimeEventType",
    "RuntimeItem",
    "RuntimeRole",
    "RuntimeTraceEvent",
    "SessionCommandAllowance",
    "SessionRuntimeSnapshot",
    "StopReason",
    "SuspendedTurn",
    "TurnItem",
    "TurnContext",
    "TurnContextSection",
    "TurnContextSectionType",
    "TurnItemType",
    "ToolExposure",
    "ToolExposureEntry",
    "ToolExposureKind",
    "ToolRouteKey",
    "ToolRouteSource",
    "TurnRecord",
    "TurnResponse",
    "TurnRollout",
    "TurnRolloutEvent",
    "TurnStatus",
    "stable_hash",
]

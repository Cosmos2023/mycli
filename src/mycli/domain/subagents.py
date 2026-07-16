from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


SubAgentStatus = str
SubAgentMode = str


def _non_blank(value: str, field_name: str) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError(f"Sub-agent {field_name} cannot be blank.")
    return stripped


def _unique_non_blank(values: tuple[str, ...], field_name: str) -> tuple[str, ...]:
    unique = tuple(dict.fromkeys(value.strip() for value in values if value.strip()))
    if not unique:
        raise ValueError(f"Sub-agent {field_name} cannot be empty.")
    return unique


def _mode(value: str) -> str:
    normalized = value.strip()
    if normalized not in {"sync", "background"}:
        raise ValueError("Sub-agent mode must be 'sync' or 'background'.")
    return normalized


@dataclass(slots=True, frozen=True)
class SubAgentBudget:
    max_turns: int = 8
    max_tool_calls: int | None = None
    no_progress_turn_limit: int = 3
    report_char_limit: int = 8000
    max_concurrent_background_tasks: int = 2

    def __post_init__(self) -> None:
        for field_name in (
            "max_turns",
            "no_progress_turn_limit",
            "report_char_limit",
            "max_concurrent_background_tasks",
        ):
            if getattr(self, field_name) <= 0:
                raise ValueError(f"Sub-agent {field_name} must be positive.")
        if self.max_tool_calls is not None and self.max_tool_calls <= 0:
            raise ValueError("Sub-agent max_tool_calls must be positive when set.")


@dataclass(slots=True, frozen=True)
class SubAgentContextSnapshot:
    baseline_fragments: tuple[str, ...] = ()
    memory_fence: str = ""
    session_summary: str = ""
    tool_names: tuple[str, ...] = ()
    diagnostics: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "baseline_fragments",
            tuple(fragment.strip() for fragment in self.baseline_fragments if fragment.strip()),
        )
        object.__setattr__(self, "memory_fence", self.memory_fence.strip())
        object.__setattr__(self, "session_summary", self.session_summary.strip())
        object.__setattr__(
            self,
            "tool_names",
            tuple(dict.fromkeys(tool.strip() for tool in self.tool_names if tool.strip())),
        )
        object.__setattr__(self, "diagnostics", dict(self.diagnostics))

    def has_content(self) -> bool:
        return bool(
            self.baseline_fragments
            or self.memory_fence
            or self.session_summary
            or self.tool_names
        )


@dataclass(slots=True, frozen=True)
class SubAgentProfile:
    name: str
    system_prompt: str
    default_tools: tuple[str, ...]
    denied_tools: tuple[str, ...] = ()
    budget: SubAgentBudget = field(default_factory=SubAgentBudget)
    model: str | None = None
    max_prompt_tokens: int | None = None
    cache_strategy: str = "inherit_provider_config"

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", _non_blank(self.name, "name"))
        object.__setattr__(
            self,
            "system_prompt",
            _non_blank(self.system_prompt, "system_prompt"),
        )
        object.__setattr__(
            self,
            "default_tools",
            _unique_non_blank(self.default_tools, "default_tools"),
        )
        object.__setattr__(
            self,
            "denied_tools",
            tuple(dict.fromkeys(tool.strip() for tool in self.denied_tools if tool.strip())),
        )
        object.__setattr__(
            self,
            "cache_strategy",
            _non_blank(self.cache_strategy, "cache_strategy"),
        )
        if self.max_prompt_tokens is not None and self.max_prompt_tokens <= 0:
            raise ValueError("Sub-agent max_prompt_tokens must be positive when set.")


@dataclass(slots=True, frozen=True)
class SubAgentInvocation:
    agent_type: str
    description: str
    allowed_tools: tuple[str, ...]
    parent_session_id: str
    parent_turn_id: str
    mode: SubAgentMode = "sync"

    def __post_init__(self) -> None:
        object.__setattr__(self, "agent_type", _non_blank(self.agent_type, "agent_type"))
        object.__setattr__(self, "description", _non_blank(self.description, "description"))
        object.__setattr__(
            self,
            "allowed_tools",
            _unique_non_blank(self.allowed_tools, "allowed_tools"),
        )
        object.__setattr__(
            self,
            "parent_session_id",
            _non_blank(self.parent_session_id, "parent_session_id"),
        )
        object.__setattr__(
            self,
            "parent_turn_id",
            _non_blank(self.parent_turn_id, "parent_turn_id"),
        )
        object.__setattr__(self, "mode", _mode(self.mode))


@dataclass(slots=True, frozen=True)
class SubAgentResult:
    status: SubAgentStatus
    report: str
    child_session_id: str
    tool_calls: int
    error: str | None = None
    context_diagnostics: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "status", _non_blank(self.status, "status"))
        object.__setattr__(
            self,
            "child_session_id",
            _non_blank(self.child_session_id, "child_session_id"),
        )
        if self.tool_calls < 0:
            raise ValueError("Sub-agent tool_calls cannot be negative.")
        object.__setattr__(self, "context_diagnostics", dict(self.context_diagnostics))


@dataclass(slots=True, frozen=True)
class SubAgentOutput:
    child_session_id: str
    status: SubAgentStatus
    report: str
    tool_calls: int
    error: str | None = None
    transcript_lines: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "child_session_id",
            _non_blank(self.child_session_id, "child_session_id"),
        )
        object.__setattr__(self, "status", _non_blank(self.status, "status"))
        if self.tool_calls < 0:
            raise ValueError("Sub-agent tool_calls cannot be negative.")
        object.__setattr__(
            self,
            "transcript_lines",
            tuple(str(line) for line in self.transcript_lines if str(line).strip()),
        )


@dataclass(slots=True, frozen=True)
class SubAgentMessageResult:
    child_session_id: str
    accepted: bool
    delivery: str
    error: str | None = None


@dataclass(slots=True, frozen=True)
class SubAgentRunSummary:
    agent_type: str
    description: str
    status: SubAgentStatus
    child_session_id: str
    tool_calls: int
    mode: SubAgentMode = "sync"
    parent_session_id: str = ""
    parent_turn_id: str = ""
    started_at: str | None = None
    completed_at: str | None = None
    error: str | None = None
    context_diagnostics: dict[str, Any] = field(default_factory=dict)
    allowed_tools: tuple[str, ...] = ()

    @classmethod
    def from_result(
        cls,
        *,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
        started_at: str | None = None,
        completed_at: str | None = None,
    ) -> SubAgentRunSummary:
        return cls(
            agent_type=invocation.agent_type,
            description=invocation.description,
            status=result.status,
            child_session_id=result.child_session_id,
            tool_calls=result.tool_calls,
            mode=invocation.mode,
            parent_session_id=invocation.parent_session_id,
            parent_turn_id=invocation.parent_turn_id,
            started_at=started_at,
            completed_at=completed_at,
            error=result.error,
            context_diagnostics=dict(result.context_diagnostics),
            allowed_tools=invocation.allowed_tools,
        )


__all__ = [
    "SubAgentBudget",
    "SubAgentContextSnapshot",
    "SubAgentInvocation",
    "SubAgentMessageResult",
    "SubAgentMode",
    "SubAgentOutput",
    "SubAgentProfile",
    "SubAgentResult",
    "SubAgentRunSummary",
    "SubAgentStatus",
]

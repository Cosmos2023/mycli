from __future__ import annotations

from dataclasses import dataclass, field


SubAgentStatus = str


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


@dataclass(slots=True, frozen=True)
class SubAgentBudget:
    max_turns: int = 8
    max_tool_calls: int = 20
    no_progress_turn_limit: int = 3
    report_char_limit: int = 8000

    def __post_init__(self) -> None:
        for field_name in (
            "max_turns",
            "max_tool_calls",
            "no_progress_turn_limit",
            "report_char_limit",
        ):
            if getattr(self, field_name) <= 0:
                raise ValueError(f"Sub-agent {field_name} must be positive.")


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


@dataclass(slots=True, frozen=True)
class SubAgentResult:
    status: SubAgentStatus
    report: str
    child_session_id: str
    tool_calls: int
    error: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "status", _non_blank(self.status, "status"))
        object.__setattr__(
            self,
            "child_session_id",
            _non_blank(self.child_session_id, "child_session_id"),
        )
        if self.tool_calls < 0:
            raise ValueError("Sub-agent tool_calls cannot be negative.")


@dataclass(slots=True, frozen=True)
class SubAgentRunSummary:
    agent_type: str
    description: str
    status: SubAgentStatus
    child_session_id: str
    tool_calls: int

    @classmethod
    def from_result(
        cls,
        *,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
    ) -> SubAgentRunSummary:
        return cls(
            agent_type=invocation.agent_type,
            description=invocation.description,
            status=result.status,
            child_session_id=result.child_session_id,
            tool_calls=result.tool_calls,
        )


__all__ = [
    "SubAgentBudget",
    "SubAgentInvocation",
    "SubAgentProfile",
    "SubAgentResult",
    "SubAgentRunSummary",
    "SubAgentStatus",
]

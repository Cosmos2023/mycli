from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState
from mycli.domain.subagents import SubAgentProfile, SubAgentResult
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.tooling.exposure import ToolRouteKey
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec


class SupportsSubAgentTaskService(Protocol):
    def run_task(
        self,
        *,
        description: str,
        agent_type: str,
        allowed_tools: tuple[str, ...],
        mode: str = "sync",
    ) -> SubAgentResult:
        ...


@dataclass(slots=True)
class _SubAgentContributionTool:
    service: SupportsSubAgentTaskService
    profile: SubAgentProfile
    spec: ToolSpec

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        description = str(arguments.get("description", "")).strip()
        if not description:
            return ToolResult(
                success=False,
                summary=f"Failed to start sub-agent: {self.profile.name}",
                error="description is required.",
                raw_payload={
                    "kind": "sub_agent_report",
                    "profile": self.profile.name,
                    "error_kind": "description_required",
                },
            )
        allowed_tools = _coerce_allowed_tools(
            arguments.get("allowed_tools"),
            fallback=self.profile.default_tools,
        )
        mode = str(arguments.get("mode", "sync")).strip() or "sync"
        result = self.service.run_task(
            description=description,
            agent_type=self.profile.name,
            allowed_tools=allowed_tools,
            mode=mode,
        )
        return ToolResult(
            success=result.status == "completed",
            summary=f"Sub-agent {self.profile.name} completed with status {result.status}.",
            error=result.error,
            raw_payload={
                "kind": "sub_agent_report",
                "profile": self.profile.name,
                "status": result.status,
                "child_session_id": result.child_session_id,
                "tool_calls": result.tool_calls,
                "report": result.report,
                "content": result.report,
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


@dataclass(slots=True)
class SubAgentToolContributionProvider:
    service: SupportsSubAgentTaskService
    list_profiles: Callable[[], tuple[SubAgentProfile, ...]] | None = None

    def provide(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
    ) -> tuple[ToolContributionRegistration, ...]:
        del user_message, conversation, plan_state
        profiles = self.list_profiles() if self.list_profiles is not None else _builtin_profiles()
        return tuple(self._registration(profile) for profile in profiles)

    def _registration(self, profile: SubAgentProfile) -> ToolContributionRegistration:
        route_name = f"subagent.{profile.name}"
        spec = ToolSpec(
            name=route_name,
            description=f"Run the {profile.name} sub-agent profile for a bounded delegated task.",
            parameters=(
                ToolParameter(
                    name="description",
                    type="string",
                    required=True,
                    description="Specific child task to delegate.",
                ),
                ToolParameter(
                    name="allowed_tools",
                    type="array",
                    required=False,
                    description="Candidate tool names the parent allows the child to use.",
                    items_schema={"type": "string"},
                ),
                ToolParameter(
                    name="mode",
                    type="string",
                    required=False,
                    description="Task execution mode: sync or background.",
                ),
            ),
            risk_level="medium",
        )
        return ToolContributionRegistration(
            descriptor=ToolContributionDescriptor(
                tool_id=f"subagent:{profile.name}",
                display_name=route_name,
                description=spec.description,
                route_key=ToolRouteKey(namespace="subagent", name=profile.name),
                source=ToolContributionSource.PROVIDER,
                scope=ToolContributionScope.THREAD,
                lifecycle_state=ToolContributionLifecycleState.DECLARED,
                spec=spec,
                origin_metadata={
                    "profile": profile.name,
                    "default_tools": list(profile.default_tools),
                    "denied_tools": list(profile.denied_tools),
                    "availability": "available",
                    "max_turns": profile.budget.max_turns,
                    "max_tool_calls": profile.budget.max_tool_calls,
                    "risk_level": "medium",
                    "approval_policy": "auto_allow_or_request",
                },
            ),
            tool=_SubAgentContributionTool(
                service=self.service,
                profile=profile,
                spec=spec,
            ),
        )


def _coerce_allowed_tools(value: object, *, fallback: tuple[str, ...]) -> tuple[str, ...]:
    if isinstance(value, list):
        tools = tuple(str(item).strip() for item in value if str(item).strip())
        return tools or fallback
    if isinstance(value, tuple):
        tools = tuple(str(item).strip() for item in value if str(item).strip())
        return tools or fallback
    return fallback


def _builtin_profiles() -> tuple[SubAgentProfile, ...]:
    from mycli.domain.subagent_profiles import list_sub_agent_profiles

    return tuple(list_sub_agent_profiles())

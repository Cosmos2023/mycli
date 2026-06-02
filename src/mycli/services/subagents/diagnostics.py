from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.subagents import SubAgentProfile
from mycli.domain.subagent_profiles import list_sub_agent_profiles


@dataclass(frozen=True, slots=True)
class SubAgentProfileDiagnostic:
    name: str
    default_tools: tuple[str, ...]
    denied_tool_count: int
    budget_max_turns: int
    budget_max_tool_calls: int
    availability: str = "available"

    @classmethod
    def from_profile(cls, profile: SubAgentProfile) -> "SubAgentProfileDiagnostic":
        return cls(
            name=profile.name,
            default_tools=profile.default_tools,
            denied_tool_count=len(profile.denied_tools),
            budget_max_turns=profile.budget.max_turns,
            budget_max_tool_calls=profile.budget.max_tool_calls,
        )

    def safe_summary(self) -> str:
        tools = ",".join(self.default_tools)
        return (
            f"{self.name}:tools={tools}:denied={self.denied_tool_count}:"
            f"budget={self.budget_max_turns}/{self.budget_max_tool_calls}"
        )


@dataclass(frozen=True, slots=True)
class SubAgentDiagnostics:
    profile_count: int
    available_count: int
    profiles: tuple[SubAgentProfileDiagnostic, ...]

    @property
    def issue_count(self) -> int:
        return self.profile_count - self.available_count

    def safe_detail(self, *, limit: int = 5) -> str:
        details = [profile.safe_summary() for profile in self.profiles[:limit]]
        if len(self.profiles) > limit:
            details.append("...")
        return ", ".join(details)


def inspect_subagent_profiles() -> SubAgentDiagnostics:
    profiles = tuple(
        SubAgentProfileDiagnostic.from_profile(profile)
        for profile in list_sub_agent_profiles()
    )
    return SubAgentDiagnostics(
        profile_count=len(profiles),
        available_count=sum(1 for profile in profiles if profile.availability == "available"),
        profiles=profiles,
    )

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from mycli.domain.subagents import SubAgentProfile
from mycli.domain.subagent_profiles import list_sub_agent_profiles
from mycli.services.subagents.registry import (
    HIGH_RISK_SUBAGENT_TOOLS,
    SubAgentProfileDiscovery,
    SubAgentProfileRegistry,
)


@dataclass(frozen=True, slots=True)
class SubAgentProfileDiagnostic:
    name: str
    default_tools: tuple[str, ...]
    denied_tool_count: int
    budget_max_turns: int
    budget_max_tool_calls: int
    availability: str = "available"
    source: str = "builtin"
    enabled: bool = True
    issue_count: int = 0
    high_risk_tools: tuple[str, ...] = ()

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
        risk = f":high_risk={','.join(self.high_risk_tools)}" if self.high_risk_tools else ""
        issues = f":issues={self.issue_count}" if self.issue_count else ""
        return (
            f"{self.name}:{self.source}:{self.availability}:tools={tools}:"
            f"denied={self.denied_tool_count}:budget={self.budget_max_turns}/"
            f"{self.budget_max_tool_calls}{risk}{issues}"
        )


@dataclass(frozen=True, slots=True)
class SubAgentDiagnostics:
    profile_count: int
    available_count: int
    disabled_count: int
    profiles: tuple[SubAgentProfileDiagnostic, ...]
    issues: tuple[str, ...] = ()

    @property
    def issue_count(self) -> int:
        return len(self.issues) + sum(profile.issue_count for profile in self.profiles)

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
        disabled_count=0,
        profiles=profiles,
    )


def inspect_configured_subagent_profiles(
    *,
    workspace_root: Path,
    home_dir: Path,
    known_tools: tuple[str, ...] = (),
) -> SubAgentDiagnostics:
    discovery = SubAgentProfileRegistry(workspace_root=workspace_root, home_dir=home_dir).discover()
    return diagnostics_from_discovery(discovery, known_tools=known_tools)


def diagnostics_from_discovery(
    discovery: SubAgentProfileDiscovery,
    *,
    known_tools: tuple[str, ...] = (),
) -> SubAgentDiagnostics:
    known_tool_set = set(known_tools)
    profiles: list[SubAgentProfileDiagnostic] = []
    issues = [issue.safe_line() for issue in discovery.issues]
    for record in discovery.records:
        profile = record.profile
        tools = record.allowed_tools
        unknown_tools = tuple(tool for tool in tools if known_tool_set and tool not in known_tool_set)
        high_risk = tuple(tool for tool in tools if tool in HIGH_RISK_SUBAGENT_TOOLS)
        if unknown_tools:
            issues.append(f"{record.profile_id}: unknown tools: {','.join(unknown_tools)}")
        if high_risk:
            issues.append(f"{record.profile_id}: high-risk tools explicitly allowed: {','.join(high_risk)}")
        profiles.append(
            SubAgentProfileDiagnostic(
                name=record.profile_id,
                default_tools=tools,
                denied_tool_count=len(record.denied_tools),
                budget_max_turns=profile.budget.max_turns if profile is not None else 0,
                budget_max_tool_calls=profile.budget.max_tool_calls if profile is not None else 0,
                availability=record.status,
                source=record.source,
                enabled=record.enabled,
                issue_count=len(record.issues) + len(unknown_tools) + len(high_risk),
                high_risk_tools=high_risk,
            )
        )
    return SubAgentDiagnostics(
        profile_count=len(discovery.records),
        available_count=discovery.enabled_count,
        disabled_count=discovery.disabled_count,
        profiles=tuple(profiles),
        issues=tuple(issues),
    )

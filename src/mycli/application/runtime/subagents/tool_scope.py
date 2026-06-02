from __future__ import annotations

from mycli.domain.subagent_profiles import GLOBAL_CHILD_DENYLIST
from mycli.domain.subagents import SubAgentProfile


def resolve_child_tool_scope(
    *,
    parent_tools: tuple[str, ...],
    requested_tools: tuple[str, ...],
    profile: SubAgentProfile | None,
    policy_denied_tools: tuple[str, ...] = (),
) -> tuple[str, ...]:
    if profile is None:
        return ()
    parent = set(parent_tools)
    requested = set(requested_tools)
    profile_tools = set(profile.default_tools)
    denied = set(GLOBAL_CHILD_DENYLIST)
    denied.update(profile.denied_tools)
    denied.update(policy_denied_tools)

    allowed = parent & requested & profile_tools
    allowed -= denied
    return tuple(tool for tool in profile.default_tools if tool in allowed)


__all__ = ["resolve_child_tool_scope"]

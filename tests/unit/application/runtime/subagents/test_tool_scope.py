from __future__ import annotations

from mycli.application.runtime.subagents.profiles import get_sub_agent_profile
from mycli.application.runtime.subagents.tool_scope import resolve_child_tool_scope


def test_resolver_intersects_parent_request_and_profile() -> None:
    profile = get_sub_agent_profile("explore")

    resolved = resolve_child_tool_scope(
        parent_tools=("Read", "Grep", "Edit", "Task"),
        requested_tools=("Read", "Edit", "Task"),
        profile=profile,
        policy_denied_tools=(),
    )

    assert resolved == ("Read",)


def test_resolver_removes_global_and_policy_denied_tools() -> None:
    profile = get_sub_agent_profile("executor")

    resolved = resolve_child_tool_scope(
        parent_tools=("Read", "Write", "Task", "AskUserQuestion"),
        requested_tools=("Read", "Write", "Task", "AskUserQuestion"),
        profile=profile,
        policy_denied_tools=("Write",),
    )

    assert resolved == ("Read",)


def test_resolver_keeps_stable_profile_order() -> None:
    profile = get_sub_agent_profile("review")

    resolved = resolve_child_tool_scope(
        parent_tools=("Lint", "LS", "Glob", "Grep", "Read"),
        requested_tools=("Lint", "LS", "Glob", "Grep", "Read"),
        profile=profile,
        policy_denied_tools=(),
    )

    assert resolved == ("Read", "LS", "Lint")

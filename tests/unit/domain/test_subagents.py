from __future__ import annotations

import pytest

from mycli.domain.subagents import (
    SubAgentBudget,
    SubAgentInvocation,
    SubAgentProfile,
    SubAgentResult,
    SubAgentRunSummary,
)


def test_profile_has_budget_model_cache_and_denylists() -> None:
    profile = SubAgentProfile(
        name="explore",
        system_prompt="Read only.",
        default_tools=("Read", "Grep", "Read"),
        denied_tools=("Task",),
        budget=SubAgentBudget(max_turns=4, max_tool_calls=7),
        model=None,
        max_prompt_tokens=None,
        cache_strategy="inherit_provider_config",
    )

    assert profile.default_tools == ("Read", "Grep")
    assert profile.denied_tools == ("Task",)
    assert profile.budget.max_turns == 4
    assert profile.budget.max_tool_calls == 7
    assert profile.cache_strategy == "inherit_provider_config"


def test_budget_defaults_match_p3_spec() -> None:
    budget = SubAgentBudget()

    assert budget.max_turns == 8
    assert budget.max_tool_calls == 20
    assert budget.no_progress_turn_limit == 3
    assert budget.report_char_limit == 8000


def test_invocation_normalizes_tools_and_requires_task_identity() -> None:
    invocation = SubAgentInvocation(
        agent_type="explore",
        description="Find entry points",
        allowed_tools=("Grep", "Read", "Read"),
        parent_session_id="demo",
        parent_turn_id="turn_1",
    )

    assert invocation.allowed_tools == ("Grep", "Read")
    assert invocation.parent_session_id == "demo"
    assert invocation.parent_turn_id == "turn_1"


def test_blank_invocation_description_is_rejected() -> None:
    with pytest.raises(ValueError, match="description"):
        SubAgentInvocation(
            agent_type="explore",
            description=" ",
            allowed_tools=("Read",),
            parent_session_id="demo",
            parent_turn_id="turn_1",
        )


def test_summary_preserves_result_status_and_session() -> None:
    invocation = SubAgentInvocation(
        agent_type="review",
        description="Review diff",
        allowed_tools=("Read",),
        parent_session_id="demo",
        parent_turn_id="turn_1",
    )
    result = SubAgentResult(
        status="completed",
        report='<sub-agent-report agent="review" status="completed">ok</sub-agent-report>',
        child_session_id="demo:sub:turn_1:abcd1234",
        tool_calls=2,
    )

    summary = SubAgentRunSummary.from_result(invocation=invocation, result=result)

    assert summary.agent_type == "review"
    assert summary.status == "completed"
    assert summary.tool_calls == 2
    assert summary.child_session_id == "demo:sub:turn_1:abcd1234"

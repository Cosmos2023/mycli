from pathlib import Path

import pytest

from mycli.domain.runtime import (
    ActivityEvent,
    AgentConfig,
    DecisionAction,
    DecisionKind,
    PendingDecision,
    RiskLevel,
    SessionCommandAllowance,
    StopReason,
    TurnItem,
    TurnItemType,
    TurnRecord,
    TurnResponse,
    TurnStatus,
)
from mycli.domain.tool_exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolExposureKind,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.domain.tools import ToolCall
from mycli.tools.base import ToolSpec


def test_agent_config_defaults_are_stable(tmp_path: Path) -> None:
    config = AgentConfig(workspace_root=tmp_path)
    assert config.max_steps == 4
    assert config.session_id == "default"
    assert config.auto_approve_medium is True


def test_risk_level_values_are_stringy() -> None:
    assert RiskLevel.LOW.value == "low"
    assert RiskLevel.HIGH.value == "high"


def test_runtime_exposes_decision_models(tmp_path: Path) -> None:
    decision = PendingDecision(
        tool_call=ToolCall(
            name="run_shell",
            arguments={"args": ["git", "reset", "--hard"]},
            reason="reset workspace state",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="Potentially destructive shell command.",
        preview="git reset --hard",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT, DecisionAction.ALLOW_SESSION),
        command_pattern="git reset --hard",
    )
    allowance = SessionCommandAllowance(command_pattern="git reset --hard")

    assert AgentConfig(workspace_root=tmp_path).session_id == "default"
    assert decision.options[-1] is DecisionAction.ALLOW_SESSION
    assert allowance.command_pattern == "git reset --hard"


def test_runtime_exposes_activity_event_model() -> None:
    event = ActivityEvent(
        kind="tool_started",
        message="Reading: README.md",
        tool_name="read_file",
        path="README.md",
    )

    assert event.kind == "tool_started"
    assert event.message == "Reading: README.md"
    assert event.tool_name == "read_file"
    assert event.path == "README.md"


def test_turn_response_remains_compatible_without_activity_events() -> None:
    response = TurnResponse(assistant_message="done")

    assert response.assistant_message == "done"
    assert response.activity_events == ()
    assert response.progress_updates == ()


def test_runtime_exposes_turn_protocol_models() -> None:
    turn = TurnRecord(
        thread_id="demo",
        turn_id="turn_1",
        status=TurnStatus.COMPLETED,
        stop_reason=StopReason.ASSISTANT_COMPLETED,
        started_at="2026-04-11T00:00:00+00:00",
        completed_at="2026-04-11T00:00:01+00:00",
        items=(
            TurnItem(type=TurnItemType.USER_MESSAGE, text="inspect repo"),
            TurnItem(type=TurnItemType.ASSISTANT_MESSAGE, text="summary"),
        ),
    )

    assert turn.status is TurnStatus.COMPLETED
    assert turn.stop_reason is StopReason.ASSISTANT_COMPLETED
    assert turn.items[0].type is TurnItemType.USER_MESSAGE


def test_pending_decision_defends_against_invalid_states(tmp_path: Path) -> None:
    tool_call = ToolCall(
        name="run_shell",
        arguments={"args": ["noop"]},
        reason="noop",
    )

    with pytest.raises(ValueError, match="at least one option"):
        PendingDecision(
            tool_call=tool_call,
            kind=DecisionKind.NEEDS_CHOICE,
            reason="No options",
            preview="noop",
            options=(),
        )

    with pytest.raises(ValueError, match="unique"):
        PendingDecision(
            tool_call=tool_call,
            kind=DecisionKind.NEEDS_CHOICE,
            reason="Duplicate options",
            preview="noop",
            options=(DecisionAction.APPROVE_ONCE, DecisionAction.APPROVE_ONCE),
        )

    with pytest.raises(ValueError, match="command_pattern cannot be blank"):
        PendingDecision(
            tool_call=tool_call,
            kind=DecisionKind.NEEDS_CHOICE,
            reason="Allow session missing pattern",
            preview="noop",
            options=(DecisionAction.ALLOW_SESSION,),
            command_pattern="",
        )

    with pytest.raises(ValueError, match="non-empty command_pattern"):
        PendingDecision(
            tool_call=tool_call,
            kind=DecisionKind.NEEDS_CHOICE,
            reason="Command pattern without allow",
            preview="noop",
            options=(DecisionAction.APPROVE_ONCE,),
            command_pattern="git pull",
        )


def test_session_command_allowance_requires_non_blank_pattern() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        SessionCommandAllowance(command_pattern="   ")


def test_tool_exposure_keeps_callable_and_namespaced_routes_stable() -> None:
    exposure = ToolExposure(
        direct=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("list_directory"),
                kind=ToolExposureKind.DIRECT,
                source=ToolRouteSource.REGISTRY,
                spec=ToolSpec(name="list_directory", description="List directory"),
            ),
        ),
        deferred=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("edit_file"),
                kind=ToolExposureKind.DEFERRED,
                source=ToolRouteSource.REGISTRY,
                spec=ToolSpec(name="edit_file", description="Edit file"),
            ),
        ),
        dynamic=(
            ToolExposureEntry(
                route_key=ToolRouteKey(namespace="mcp.github", name="search_code"),
                kind=ToolExposureKind.DYNAMIC,
                source=ToolRouteSource.PROVIDER,
                spec=ToolSpec(name="search_code", description="Search remote code"),
            ),
        ),
    )

    assert exposure.callable_tool_names() == (
        "list_directory",
        "edit_file",
        "mcp.github.search_code",
    )

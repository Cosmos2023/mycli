from datetime import UTC, datetime
from pathlib import Path

import pytest

from mycli.domain.runtime import (
    ActivityEvent,
    AgentConfig,
    CompactionRehydrationContext,
    DecisionAction,
    DecisionKind,
    FileRehydrationCandidate,
    PendingDecision,
    RUNTIME_EVENT_ENVELOPE_VERSION,
    RiskLevel,
    RehydratedFile,
    RehydratedSkill,
    RehydrationBudget,
    RuntimeEventEnvelope,
    SessionCommandAllowance,
    ShellKind,
    StopReason,
    TurnItem,
    TurnItemType,
    TurnRecord,
    TurnResponse,
    TurnStatus,
    InstructionFragmentKind,
    InvokedSkillSnapshot,
    ViewMode,
    TurnContextSectionType,
)
from mycli.domain.tooling.exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolExposureKind,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolSpec


def test_agent_config_defaults_are_stable(tmp_path: Path) -> None:
    config = AgentConfig(workspace_root=tmp_path)
    assert config.session_id == "default"
    assert config.auto_approve_medium is True


def test_agent_config_exposes_recovery_defaults(tmp_path: Path) -> None:
    config = AgentConfig(workspace_root=tmp_path)

    assert config.fallback_model is None
    assert config.request_max_retries == 4
    assert config.stream_max_retries == 5
    assert config.transport_retry_limit is None
    assert config.heartbeat_enabled is True
    assert config.heartbeat_interval_seconds == 30.0


def test_agent_config_caps_stream_retry_budget(tmp_path: Path) -> None:
    assert AgentConfig(workspace_root=tmp_path, stream_max_retries=-1).effective_stream_max_retries == 0
    assert AgentConfig(workspace_root=tmp_path, stream_max_retries=500).effective_stream_max_retries == 100
    assert AgentConfig(
        workspace_root=tmp_path,
        stream_max_retries=9,
        transport_retry_limit=2,
    ).effective_stream_max_retries == 2


def test_agent_config_exposes_cli_view_defaults(tmp_path: Path) -> None:
    config = AgentConfig(workspace_root=tmp_path)

    assert config.view_mode is ViewMode.DEFAULT
    assert config.statusline_enabled is True


def test_agent_config_exposes_tui_startup_mark_default(tmp_path: Path) -> None:
    config = AgentConfig(workspace_root=tmp_path)

    assert config.tui_startup_mark == "default"


def test_agent_config_has_compaction_rehydration_defaults(tmp_path: Path) -> None:
    config = AgentConfig(workspace_root=tmp_path)

    assert config.compaction_rehydration_file_max_total_tokens == 50_000
    assert config.compaction_rehydration_file_max_item_tokens == 5_000
    assert config.compaction_rehydration_skill_max_total_tokens == 25_000
    assert config.compaction_rehydration_skill_max_item_tokens == 5_000
    assert config.compaction_rehydration_max_files == 5
    assert config.compaction_rehydration_max_skills == 5


def test_compaction_rehydration_types_are_exported() -> None:
    invoked = InvokedSkillSnapshot(
        name="code-review",
        description="Review code",
        source_path="/skills/code-review/SKILL.md",
        body_digest="abc123",
        cached_body_excerpt=None,
        invoked_at=datetime(2026, 5, 27, tzinfo=UTC),
        last_turn_id="turn_1",
    )
    context = CompactionRehydrationContext(
        files=(
            RehydratedFile(
                path="src/app.py",
                content="print('ok')",
                token_count=3,
                truncated=False,
            ),
        ),
        invoked_skills=(
            RehydratedSkill(
                name=invoked.name,
                description=invoked.description,
                source_path=invoked.source_path,
                body="Use focused review.",
                token_count=4,
                truncated=False,
            ),
        ),
    )

    assert context.files[0].path == "src/app.py"
    assert context.invoked_skills[0].name == "code-review"
    assert RehydrationBudget(max_total_tokens=10, max_item_tokens=5).max_item_tokens == 5
    assert FileRehydrationCandidate(path="src/app.py", tool_name="Edit", sequence=1).kind == "edit"
    assert TurnContextSectionType.COLLABORATION_MODE == "collaboration_mode"
    assert TurnContextSectionType.COMPACTION_REHYDRATION == "compaction_rehydration"
    assert InstructionFragmentKind.COLLABORATION_MODE == "collaboration_mode"
    assert InstructionFragmentKind.COMPACTION_REHYDRATION == "compaction_rehydration"


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


def test_runtime_stream_event_defaults_are_empty() -> None:
    from mycli.domain.runtime import RuntimeStreamEvent

    event = RuntimeStreamEvent(kind="text_delta", text="hello")

    assert event.kind == "text_delta"
    assert event.text == "hello"
    assert event.tool_name is None
    assert event.metadata == {}


def test_runtime_event_envelope_serializes_stable_contract_shape() -> None:
    payload = {"client_turn_id": "client_1", "text": "hello"}

    envelope = RuntimeEventEnvelope(
        sequence=3,
        event_type="message.delta",
        payload=payload,
        timestamp=1_779_999_999.25,
    )

    assert envelope.to_dict() == {
        "version": RUNTIME_EVENT_ENVELOPE_VERSION,
        "sequence": 3,
        "type": "message.delta",
        "payload": payload,
        "timestamp": 1_779_999_999.25,
    }


def test_runtime_event_envelope_rejects_invalid_metadata() -> None:
    with pytest.raises(ValueError, match="sequence"):
        RuntimeEventEnvelope(sequence=0, event_type="status.update", payload={}, timestamp=1.0)

    with pytest.raises(ValueError, match="event_type"):
        RuntimeEventEnvelope(sequence=1, event_type=" ", payload={}, timestamp=1.0)

    with pytest.raises(ValueError, match="timestamp"):
        RuntimeEventEnvelope(sequence=1, event_type="status.update", payload={}, timestamp=-1.0)


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


def test_pending_decision_requires_validated_pattern_for_always_allow() -> None:
    with pytest.raises(ValueError, match="proposed_execpolicy_pattern"):
        PendingDecision(
            tool_call=ToolCall(
                name="Shell",
                arguments={"command": "python -m pytest"},
                reason="test",
            ),
            kind=DecisionKind.NEEDS_CHOICE,
            reason="unknown command",
            preview="python -m pytest",
            options=(DecisionAction.APPROVE_ONCE, DecisionAction.ALWAYS_ALLOW),
        )


def test_pending_decision_accepts_validated_always_allow_pattern() -> None:
    decision = PendingDecision(
        tool_call=ToolCall(
            name="Shell",
            arguments={"command": "python -m pytest"},
            reason="test",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="unknown command",
        preview="python -m pytest",
        options=(
            DecisionAction.APPROVE_ONCE,
            DecisionAction.REJECT,
            DecisionAction.ALWAYS_ALLOW,
        ),
        proposed_execpolicy_pattern=("python", "-m", "pytest"),
    )

    assert decision.options[-1] is DecisionAction.ALWAYS_ALLOW
    assert decision.proposed_execpolicy_pattern == ("python", "-m", "pytest")


def test_session_command_allowance_requires_non_blank_pattern() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        SessionCommandAllowance(command_pattern="   ")


def test_legacy_session_command_allowance_defaults_to_bash() -> None:
    allowance = SessionCommandAllowance(command_pattern="git status")

    assert allowance.shell_kind is ShellKind.BASH


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
        contributed=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("mcp_github_search_code"),
                kind=ToolExposureKind.CONTRIBUTED,
                source=ToolRouteSource.PROVIDER,
                spec=ToolSpec(name="search_code", description="Search remote code"),
            ),
        ),
    )

    assert exposure.callable_tool_names() == (
        "list_directory",
        "edit_file",
        "mcp_github_search_code",
    )


def test_tool_exposure_kind_keeps_legacy_tool_value_readable() -> None:
    assert ToolExposureKind("tool") is ToolExposureKind.TOOL
    assert ToolExposureKind.DIRECT.value == "direct"
    assert ToolExposureKind.DEFERRED.value == "deferred"


def test_runtime_exports_request_shape_types() -> None:
    from mycli.domain.runtime import (
        FragmentStability,
        ProviderMessageShape,
        ProviderRuntimeItemShape,
        RequestFragment,
        RequestFragmentKind,
        RequestShape,
        RuntimeBlock,
    )

    fragment = RequestFragment(
        id="intent:current",
        kind=RequestFragmentKind.INTENT,
        content="hello",
        stability=FragmentStability.VOLATILE,
    )
    shape = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="system",
        fragments=(fragment,),
        provider_messages=(ProviderMessageShape(role="user", content="hello"),),
        provider_runtime_items=(
            ProviderRuntimeItemShape(
                role="user",
                blocks=(RuntimeBlock(type="text", text="hello"),),
            ),
        ),
    )

    assert shape.fragment_hashes()["intent:current"] == fragment.content_hash
    assert shape.provider_runtime_item_hashes()

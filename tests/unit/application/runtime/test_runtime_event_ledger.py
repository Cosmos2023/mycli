from __future__ import annotations

from mycli.application.runtime.ledger.runtime_event_ledger import RuntimeEventLedger
from mycli.domain.runtime import (
    BaselineFragment,
    HistoryItem,
    HistoryItemType,
    InstructionContract,
    InstructionFragment,
    RuntimeTraceEvent,
    TurnItem,
    TurnItemType,
    TurnRecord,
    TurnRollout,
    TurnStatus,
)
from mycli.services.transcript_projection import project_history_items_for_snapshot
from mycli.state.session_service import SessionService


class _NoopSessionService(SessionService):
    def __init__(self) -> None:
        pass

    def load_context_baseline(self, session_id: str):  # type: ignore[no-untyped-def]
        del session_id

    def load_history_items(self, session_id: str) -> tuple[HistoryItem, ...]:
        del session_id
        return ()

    def load_turn_rollouts(self, session_id: str) -> tuple[TurnRollout, ...]:
        del session_id
        return ()


class _RecordingSessionService(_NoopSessionService):
    def __init__(self) -> None:
        self.appended: list[HistoryItem] = []

    def append_history_items(
        self,
        session_id: str,
        items: tuple[HistoryItem, ...],
    ) -> None:
        assert session_id == "demo"
        self.appended.extend(items)


class _NoopTraceService:
    def append(self, session_id: str, event: RuntimeTraceEvent) -> None:
        del session_id, event

    def load_for_turn(self, session_id: str, turn_id: str) -> tuple[RuntimeTraceEvent, ...]:
        del session_id, turn_id
        return ()


def _ledger() -> RuntimeEventLedger:
    return RuntimeEventLedger(
        session_id="demo",
        session_service=_NoopSessionService(),
        trace_service=_NoopTraceService(),  # type: ignore[arg-type]
        continuation_state_provider=lambda: None,
    )


def test_runtime_event_ledger_incrementally_commits_completed_items_once() -> None:
    service = _RecordingSessionService()
    ledger = RuntimeEventLedger(
        session_id="demo",
        session_service=service,
        trace_service=_NoopTraceService(),  # type: ignore[arg-type]
        continuation_state_provider=lambda: None,
    )
    turn_items = [
        TurnItem(
            type=TurnItemType.USER_MESSAGE,
            text="start",
            metadata={"history_committed": True},
        ),
        TurnItem(type=TurnItemType.ASSISTANT_MESSAGE, text="first answer"),
    ]

    committed = ledger.persist_completed_turn_items(
        turn_id="turn-1",
        turn_items=turn_items,
    )

    assert [item.id for item in committed] == ["turn-1:item:2"]
    assert [item.text for item in service.appended] == ["first answer"]
    assert turn_items[1].metadata["history_committed"] is True
    assert ledger.persist_completed_turn_items(
        turn_id="turn-1",
        turn_items=turn_items,
    ) == ()
    turn = TurnRecord(
        thread_id="demo",
        turn_id="turn-1",
        status=TurnStatus.COMPLETED,
        started_at="2026-07-21T00:00:00Z",
        items=tuple(turn_items),
    )
    assert ledger.history_items_from_turn(turn) == ()


def test_tool_display_survives_ledger_history_and_snapshot_projection() -> None:
    turn = TurnRecord(
        thread_id="demo",
        turn_id="turn-1",
        status=TurnStatus.COMPLETED,
        started_at="2026-07-15T10:00:00Z",
        items=(
            TurnItem(
                type=TurnItemType.TOOL_CALL,
                text="Read",
                tool_name="Read",
                call_id="call-1",
                metadata={
                    "display": {
                        "target": "src/app.py",
                        "status": "running",
                        "summary": "Reading",
                        "presentation": "context",
                    }
                },
            ),
            TurnItem(
                type=TurnItemType.TOOL_RESULT,
                text="Read complete",
                tool_name="Read",
                call_id="call-1",
                metadata={
                    "display": {
                        "status": "success",
                        "summary": "Read 20 lines",
                        "detail": "1\tline",
                        "presentation": "context",
                    },
                    "raw_payload": {"content": "private duplicate"},
                },
            ),
        ),
    )

    history = _ledger().provider_history_items_from_turn(turn)
    snapshot = project_history_items_for_snapshot(history)

    assert history[1].metadata["display"]["status"] == "success"
    assert len(snapshot) == 1
    display = snapshot[0].metadata["display"]
    assert display["target"] == "src/app.py"
    assert display["status"] == "success"
    assert display["detail"] == "1\tline"
    assert "raw_payload" not in str(snapshot[0].to_dict())


def test_runtime_event_ledger_persists_plan_update_but_excludes_it_from_provider_history() -> None:
    turn = TurnRecord(
        thread_id="demo",
        turn_id="turn-1",
        status=TurnStatus.COMPLETED,
        started_at="2026-07-18T10:00:00Z",
        items=(
            TurnItem(
                type=TurnItemType.TOOL_CALL,
                text="Update plan",
                tool_name="Plan",
                call_id="call-plan-1",
            ),
            TurnItem(
                type=TurnItemType.PLAN_UPDATE,
                text="Updated Plan",
                metadata={
                    "source": "Plan",
                    "completed": 0,
                    "total": 1,
                    "items": [
                        {
                            "id": "inspect",
                            "text": "Inspect runtime",
                            "status": "in_progress",
                        }
                    ],
                    "model_visible": False,
                },
            ),
            TurnItem(
                type=TurnItemType.TOOL_RESULT,
                text="Plan updated",
                tool_name="Plan",
                call_id="call-plan-1",
            ),
        ),
    )

    durable = _ledger().history_items_from_turn(turn)
    provider = _ledger().provider_history_items_from_turn(turn)

    assert [item.type for item in durable] == [
        HistoryItemType.TOOL_CALL,
        HistoryItemType.PLAN_UPDATE,
        HistoryItemType.TOOL_RESULT,
    ]
    assert [item.type for item in provider] == [
        HistoryItemType.TOOL_CALL,
        HistoryItemType.TOOL_RESULT,
    ]


def test_runtime_event_ledger_persists_clarification_response_for_transcript_only() -> None:
    turn = TurnRecord(
        thread_id="demo",
        turn_id="turn-1",
        status=TurnStatus.COMPLETED,
        started_at="2026-07-24T10:00:00Z",
        items=(
            TurnItem(
                type=TurnItemType.CLARIFICATION_RESPONSE,
                text="Runtime",
                call_id="call-question-1",
            ),
        ),
    )

    durable = _ledger().history_items_from_turn(turn)
    provider = _ledger().provider_history_items_from_turn(turn)

    assert [item.type for item in durable] == [HistoryItemType.CLARIFICATION_RESPONSE]
    assert provider == ()


def test_runtime_event_ledger_baseline_keeps_replayable_memory_and_plan() -> None:
    baseline = _ledger().context_baseline_from_contract(
        InstructionContract(
            base_instructions="Base",
            contextual_user_sections=(
                InstructionFragment(
                    kind="memory",
                    title="Memory",
                    content="Remember selected context.",
                    source="memory",
                    metadata={
                        "durability": "persistent",
                        "scope": "transcript",
                        "model_visible": True,
                        "replayable": True,
                        "provider_state": {"codex_reasoning_items": ("opaque",)},
                        "prompt_cache_key": "raw-key",
                        "cache_control": {"type": "ephemeral"},
                    },
                ),
                InstructionFragment(
                    kind="plan",
                    title="Plan",
                    content="Current: finish P5.",
                    source="plan",
                    metadata={
                        "durability": "persistent",
                        "scope": "transcript",
                        "model_visible": True,
                        "replayable": True,
                    },
                ),
                InstructionFragment(
                    kind="environment_context",
                    title="Environment",
                    content="Workspace root: /tmp/workspace",
                    source="runtime",
                    metadata={
                        "durability": "persistent",
                        "scope": "turn",
                        "model_visible": True,
                        "replayable": False,
                    },
                ),
                InstructionFragment(
                    kind="conversation_context",
                    title="Conversation",
                    content="Recent conversation is handled by history.",
                    source="conversation",
                    metadata={
                        "durability": "persistent",
                        "scope": "transcript",
                        "model_visible": True,
                        "replayable": True,
                    },
                ),
            ),
        )
    )

    assert baseline is not None
    assert [fragment.kind for fragment in baseline.fragments] == [
        "memory",
        "plan",
        "environment_context",
    ]
    memory = baseline.fragments[0]
    assert isinstance(memory, BaselineFragment)
    assert memory.content == "Remember selected context."
    assert memory.metadata["durability"] == "persistent"
    assert memory.metadata["scope"] == "transcript"
    assert "provider_state" not in memory.metadata
    assert "prompt_cache_key" not in memory.metadata
    assert "cache_control" not in memory.metadata


def test_runtime_event_ledger_baseline_skips_api_only_fragments() -> None:
    baseline = _ledger().context_baseline_from_contract(
        InstructionContract(
            base_instructions="Base",
            developer_sections=(
                InstructionFragment(
                    kind="transport_retry_notice",
                    title="Retry notice",
                    content="request id req_123",
                    source="transport",
                    metadata={
                        "durability": "api_only",
                        "scope": "request",
                        "model_visible": False,
                        "replayable": False,
                    },
                ),
            ),
        )
    )

    assert baseline is None

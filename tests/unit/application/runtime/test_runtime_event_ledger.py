from __future__ import annotations

from mycli.application.runtime.ledger.runtime_event_ledger import RuntimeEventLedger
from mycli.domain.runtime import (
    BaselineFragment,
    HistoryItem,
    InstructionContract,
    InstructionFragment,
    RuntimeTraceEvent,
    TurnRollout,
)
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
    assert [fragment.kind for fragment in baseline.fragments] == ["memory", "plan"]
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

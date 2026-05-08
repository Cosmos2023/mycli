from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace

from mycli.domain.runtime import (
    AgentConfig,
    ContextBaseline,
    StopReason,
    TurnItem,
    TurnRecord,
    TurnResponse,
    TurnStatus,
)
from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.application.runtime.ledger import RuntimeEventLedger
from mycli.state.session_service import SessionService


class RuntimeResponseFinalizer:
    def __init__(
        self,
        *,
        config: AgentConfig,
        contributed_tool_registry: ToolContributionRegistry,
        session_service: SessionService,
        event_ledger: RuntimeEventLedger,
        append_lifecycle_events: Callable[..., None],
    ) -> None:
        self._config = config
        self._contributed_tool_registry = contributed_tool_registry
        self._session_service = session_service
        self._event_ledger = event_ledger
        self._append_lifecycle_events = append_lifecycle_events

    def set_config(self, config: AgentConfig) -> None:
        self._config = config

    def finalize_response(
        self,
        *,
        response: TurnResponse,
        turn_id: str,
        user_message: str,
        started_at: str,
        status: TurnStatus,
        stop_reason: StopReason | None,
        turn_items: list[TurnItem],
        context_baseline: ContextBaseline | None = None,
    ) -> TurnResponse:
        activity_events = list(response.activity_events)
        if status is not TurnStatus.WAITING_APPROVAL:
            expired_events = self._contributed_tool_registry.expire_turn_scoped()
            if expired_events:
                self._append_lifecycle_events(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    activity_events=activity_events,
                    lifecycle_events=expired_events,
                )
        self._session_service.save_contributed_tool_state(
            self._config.session_id,
            self._contributed_tool_registry.snapshot(),
        )
        turn = self.persist_turn_record(
            turn_id=turn_id,
            user_message=user_message,
            started_at=started_at,
            status=status,
            stop_reason=stop_reason,
            turn_items=turn_items,
        )
        self.persist_structured_runtime_state(
            turn=turn,
            started_at=started_at,
            context_baseline=context_baseline,
        )
        return replace(response, turn=turn, activity_events=tuple(activity_events))

    def persist_turn_record(
        self,
        *,
        turn_id: str,
        user_message: str,
        started_at: str,
        status: TurnStatus,
        stop_reason: StopReason | None,
        turn_items: list[TurnItem],
    ) -> TurnRecord:
        return self._event_ledger.persist_turn_record(
            turn_id=turn_id,
            user_message=user_message,
            status=status,
            started_at=started_at,
            stop_reason=stop_reason,
            turn_items=turn_items,
        )

    def persist_structured_runtime_state(
        self,
        *,
        turn: TurnRecord,
        started_at: str,
        context_baseline: ContextBaseline | None,
    ) -> None:
        self._event_ledger.persist_structured_runtime_state(
            turn=turn,
            started_at=started_at,
            context_baseline=context_baseline,
        )

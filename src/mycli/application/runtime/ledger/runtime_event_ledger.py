from __future__ import annotations

from datetime import UTC, datetime
from typing import Callable

from mycli.domain.runtime import (
    BaselineFragment,
    ContextBaseline,
    HistoryItem,
    HistoryItemType,
    InstructionContract,
    InstructionFragment,
    InstructionFragmentKind,
    RuntimeTraceEvent,
    StopReason,
    TurnItem,
    TurnItemType,
    TurnRecord,
    TurnRollout,
    TurnRolloutEvent,
    TurnStatus,
    stable_hash,
)
from mycli.schemas.responses_protocol import ResponsesContinuationState
from mycli.state.session_service import SessionService
from mycli.services.tracing import TraceService


class RuntimeEventLedger:
    """Persists runtime events separately from provider transcript replay."""

    _BASELINE_HISTORY_KINDS = {"conversation_context", "user_request"}
    _PROVIDER_TRANSCRIPT_TURN_ITEM_TYPES = {
        TurnItemType.USER_MESSAGE,
        TurnItemType.ASSISTANT_MESSAGE,
        TurnItemType.SKILL_INSTRUCTIONS,
        TurnItemType.TOOL_CALL,
        TurnItemType.TOOL_RESULT,
    }
    _WIRE_ONLY_METADATA_KEYS = {"provider_state", "prompt_cache_key", "cache_control"}

    def __init__(
        self,
        *,
        session_id: str,
        session_service: SessionService,
        trace_service: TraceService,
        continuation_state_provider: Callable[[], object | None],
    ) -> None:
        self._session_id = session_id
        self._session_service = session_service
        self._trace_service = trace_service
        self._continuation_state_provider = continuation_state_provider

    def timestamp(self) -> str:
        return datetime.now(UTC).isoformat()

    def append_turn_item(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        item: TurnItem,
    ) -> None:
        turn_items.append(item)
        self._trace_service.append(
            self._session_id,
            RuntimeTraceEvent(
                kind="turn_item",
                turn_id=turn_id,
                payload=item.to_dict(),
            ),
        )

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
        turn = TurnRecord(
            thread_id=self._session_id,
            turn_id=turn_id,
            status=status,
            started_at=started_at,
            completed_at=self.timestamp() if status is not TurnStatus.IN_PROGRESS else None,
            stop_reason=stop_reason,
            user_message=user_message,
            items=tuple(turn_items),
        )
        self._session_service.save_turn_record(self._session_id, turn)
        self._trace_service.append(
            self._session_id,
            RuntimeTraceEvent(
                kind="turn_state",
                turn_id=turn_id,
                payload={
                    "status": status.value,
                    "stop_reason": None if stop_reason is None else stop_reason.value,
                },
            ),
        )
        return turn

    def provider_history_items_from_turn(
        self,
        turn: TurnRecord,
    ) -> tuple[HistoryItem, ...]:
        history_items: list[HistoryItem] = []
        for index, item in enumerate(turn.items, start=1):
            history_item_type = self._provider_transcript_type_for_turn_item(item)
            if history_item_type is None:
                continue
            history_items.append(
                HistoryItem(
                    id=f"{turn.turn_id}:item:{index}",
                    thread_id=turn.thread_id,
                    turn_id=turn.turn_id,
                    type=history_item_type,
                    text=item.text,
                    tool_name=item.tool_name,
                    call_id=item.call_id,
                    metadata=dict(item.metadata),
                )
            )
        return tuple(history_items)

    def context_baseline_from_contract(
        self,
        contract: InstructionContract | None,
    ) -> ContextBaseline | None:
        if contract is None:
            return None

        fragments: list[BaselineFragment] = []
        for index, section in enumerate(contract.developer_sections, start=1):
            if not self._baseline_fragment_replayable(section):
                continue
            fragments.append(
                BaselineFragment(
                    id=f"developer:{index}",
                    kind=str(section.kind),
                    title=section.title,
                    content=section.content,
                    source=section.source,
                    metadata=self._baseline_metadata(section.metadata),
                )
            )
        contextual_index = 0
        for section in contract.contextual_user_sections:
            if not self._baseline_fragment_replayable(section):
                continue
            contextual_index += 1
            fragments.append(
                BaselineFragment(
                    id=f"contextual:{contextual_index}",
                    kind=str(section.kind),
                    title=section.title,
                    content=section.content,
                    source=section.source,
                    metadata=self._baseline_metadata(section.metadata),
                )
            )
        if not fragments:
            return None
        return ContextBaseline(
            thread_id=self._session_id,
            fragments=tuple(fragments),
        )

    def persist_structured_runtime_state(
        self,
        *,
        turn: TurnRecord,
        started_at: str,
        context_baseline: ContextBaseline | None,
    ) -> None:
        history_items = (
            *self._runtime_environment_history_items(
                turn,
                context_baseline=context_baseline,
            ),
            *self.provider_history_items_from_turn(turn),
        )
        if history_items:
            self._session_service.append_history_items(
                self._session_id,
                history_items,
            )

        previous_baseline = self._session_service.load_context_baseline(self._session_id)
        if context_baseline is not None and context_baseline != previous_baseline:
            self._session_service.save_context_baseline(
                self._session_id,
                context_baseline,
            )

        rollout_trace_events = self._trace_service.load_for_turn(
            self._session_id,
            turn.turn_id,
        )
        rollout = TurnRollout(
            thread_id=turn.thread_id,
            turn_id=turn.turn_id,
            status=turn.status,
            started_at=started_at,
            completed_at=turn.completed_at,
            stop_reason=turn.stop_reason,
            events=tuple(
                TurnRolloutEvent(
                    event_id=f"{turn.turn_id}:trace:{index}",
                    kind=event.kind,
                    created_at=turn.completed_at or started_at,
                    payload=event.payload,
                )
                for index, event in enumerate(rollout_trace_events, start=1)
            ),
            continuation_state=self._continuation_state_payload(),
        )
        self._session_service.append_turn_rollout(self._session_id, rollout)
        self._session_service.sync_conversation_view_from_history(self._session_id)

    def _runtime_environment_history_items(
        self,
        turn: TurnRecord,
        *,
        context_baseline: ContextBaseline | None,
    ) -> tuple[HistoryItem, ...]:
        environment = self._environment_fragment_from_baseline(context_baseline)
        if environment is None:
            return ()
        content = environment.content.strip()
        if not content:
            return ()
        content_hash = stable_hash(content)
        raw_content_hash = environment.metadata.get("runtime_environment_raw_hash")
        if not isinstance(raw_content_hash, str) or not raw_content_hash:
            raw_content_hash = content_hash
        previous = self._session_service.load_runtime_environment_context_state(
            self._session_id
        )
        self._session_service.save_runtime_environment_context_state(
            self._session_id,
            content_hash=raw_content_hash,
            turn_id=turn.turn_id,
        )
        if previous is not None and previous.get("content_hash") == raw_content_hash:
            return ()
        metadata = self._baseline_metadata(environment.metadata)
        metadata.update(
            {
                "context_kind": InstructionFragmentKind.ENVIRONMENT_CONTEXT.value,
                "cache_class": metadata.get("cache_class", "dynamic"),
                "source": environment.source or "runtime",
                "model_visible": True,
                "replayable": True,
                "runtime_environment_hash": content_hash,
                "runtime_environment_raw_hash": raw_content_hash,
            }
        )
        return (
            HistoryItem(
                id=f"{turn.turn_id}:environment_context",
                thread_id=turn.thread_id,
                turn_id=turn.turn_id,
                type=HistoryItemType.CONTEXT_BASELINE_UPDATE,
                text=content,
                metadata=metadata,
            ),
        )

    def _environment_fragment_from_baseline(
        self,
        baseline: ContextBaseline | None,
    ) -> BaselineFragment | None:
        if baseline is None:
            return None
        for fragment in baseline.fragments:
            if fragment.kind == InstructionFragmentKind.ENVIRONMENT_CONTEXT.value:
                return fragment
        return None

    def _baseline_fragment_replayable(self, section: InstructionFragment) -> bool:
        kind = str(section.kind)
        if kind == InstructionFragmentKind.ENVIRONMENT_CONTEXT.value:
            return True
        if kind in self._BASELINE_HISTORY_KINDS:
            return False
        metadata = section.metadata
        if not isinstance(metadata, dict):
            return True
        if metadata.get("model_visible") is False:
            return False
        if metadata.get("replayable") is True:
            return True
        durability = str(metadata.get("durability", "persistent"))
        scope = str(metadata.get("scope", "turn"))
        return durability == "persistent" and scope in {"transcript", "session"}

    def _baseline_metadata(self, metadata: dict[str, object]) -> dict[str, object]:
        return {
            str(key): value
            for key, value in metadata.items()
            if str(key) not in self._WIRE_ONLY_METADATA_KEYS
        }

    def _provider_transcript_type_for_turn_item(
        self,
        item: TurnItem,
    ) -> HistoryItemType | None:
        if item.type not in self._PROVIDER_TRANSCRIPT_TURN_ITEM_TYPES:
            return None
        if item.type is TurnItemType.SKILL_INSTRUCTIONS:
            return HistoryItemType.SKILL_INSTRUCTIONS
        return HistoryItemType(item.type.value)

    def _continuation_state_payload(self) -> dict[str, object]:
        state = self._continuation_state_provider()
        if isinstance(state, ResponsesContinuationState):
            return state.to_dict()
        return {}

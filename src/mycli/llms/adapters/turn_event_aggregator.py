from __future__ import annotations

from collections.abc import Iterable

from mycli.domain.model_events import ModelEvent, ModelEventType
from mycli.domain.runtime.blocks import ModelTurnResult, RuntimeBlock, RuntimeItem
from mycli.llms.clients.openai_chat import ModelResponseError


class TurnEventAggregator:
    def collect(self, events: Iterable[ModelEvent]) -> ModelTurnResult:
        blocks: list[RuntimeBlock] = []
        response_id: str | None = None
        usage: dict[str, object] | None = None
        done = True

        for event in events:
            if event.type is ModelEventType.REASONING_DELTA:
                blocks.append(
                    RuntimeBlock(
                        type="reasoning",
                        text=event.text,
                        provider_id=event.provider_id,
                        metadata=dict(event.metadata),
                    )
                )
                continue
            if event.type is ModelEventType.MESSAGE_DELTA:
                blocks.append(
                    RuntimeBlock(
                        type="text",
                        text=event.text,
                        provider_id=event.provider_id,
                        metadata=dict(event.metadata),
                    )
                )
                continue
            if event.type is ModelEventType.TOOL_CALL_REQUESTED:
                blocks.append(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name=event.tool_name,
                        tool_arguments=event.tool_arguments or {},
                        call_id=event.call_id,
                        provider_id=event.provider_id,
                        source=event.source.value if event.source is not None else None,
                        metadata=dict(event.metadata),
                    )
                )
                done = False
                continue
            if event.type is ModelEventType.TURN_COMPLETED:
                response_id = event.response_id
                usage = event.usage
                continue
            if event.type is ModelEventType.TURN_FAILED:
                raise ModelResponseError(event.error_message or "Model turn failed.")

        items = (RuntimeItem(role="assistant", blocks=tuple(blocks)),) if blocks else ()
        return ModelTurnResult(
            items=items,
            done=done,
            response_id=response_id,
            metadata={"usage": usage} if usage is not None else {},
        )

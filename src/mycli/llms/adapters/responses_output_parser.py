from __future__ import annotations

import json
from collections.abc import Callable

from mycli.domain.runtime.blocks import ModelTurnResult, RuntimeBlock, RuntimeItem
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.schemas.responses_protocol import (
    ResponsesFunctionCallOutputItem,
    ResponsesMcpCallOutputItem,
    ResponsesMessageOutputItem,
    ResponsesReasoningOutputItem,
    parse_responses_output_item,
)


class ResponsesOutputParser:
    def __init__(
        self,
        *,
        warn_unsupported_item: Callable[
            [str, str | None, int],
            None,
        ],
    ) -> None:
        self._warn_unsupported_item = warn_unsupported_item

    def to_model_turn_result(self, payload: dict[str, object]) -> ModelTurnResult:
        if not isinstance(payload, dict):
            raise ModelResponseError("Responses payload must be a JSON object.")

        raw_output = payload.get("output", [])
        if not isinstance(raw_output, list):
            raise ModelResponseError("Responses payload field 'output' must be a list.")

        blocks: list[RuntimeBlock] = []
        has_tool_call = False
        for index, item in enumerate(raw_output):
            if not isinstance(item, dict):
                raise ModelResponseError(
                    f"Responses output item at index {index} must be an object."
                )

            item_type = item.get("type")
            if not isinstance(item_type, str) or not item_type:
                raise ModelResponseError(
                    f"Responses output item at index {index} is missing required 'type'."
                )
            parsed_item = parse_responses_output_item(item)
            if isinstance(parsed_item, ResponsesReasoningOutputItem):
                blocks.extend(self._reasoning_blocks(parsed_item))
                continue
            if isinstance(parsed_item, ResponsesFunctionCallOutputItem):
                blocks.append(self._function_call_block(parsed_item, index=index))
                has_tool_call = True
                continue
            if isinstance(parsed_item, ResponsesMessageOutputItem):
                message_blocks = self._message_blocks(parsed_item, item_type=item_type)
                blocks.extend(message_blocks)
                continue
            if isinstance(parsed_item, ResponsesMcpCallOutputItem):
                blocks.append(self._mcp_call_block(parsed_item, index=index))
                continue

            self._warn_unsupported_item(
                item_type,
                None if item.get("id") is None else str(item["id"]),
                index,
            )

        runtime_items: tuple[RuntimeItem, ...]
        if blocks:
            runtime_items = (RuntimeItem(role="assistant", blocks=tuple(blocks)),)
        else:
            runtime_items = ()

        response_id = None if payload.get("id") is None else str(payload["id"])
        return ModelTurnResult(
            items=runtime_items,
            done=not has_tool_call,
            response_id=response_id,
            metadata={
                "response_status": payload.get("status"),
                "usage": payload.get("usage"),
            },
        )

    def parse_function_call_arguments(
        self,
        *,
        item: dict[str, object],
        index: int,
    ) -> dict[str, object]:
        raw_arguments = item.get("arguments", {})
        if isinstance(raw_arguments, dict):
            return raw_arguments
        if isinstance(raw_arguments, str):
            try:
                loaded_arguments = json.loads(raw_arguments)
            except json.JSONDecodeError as exc:
                raise ModelResponseError(
                    f"Responses function_call item at index {index} has invalid JSON arguments."
                ) from exc
            if not isinstance(loaded_arguments, dict):
                raise ModelResponseError(
                    f"Responses function_call item at index {index} must have object arguments."
                )
            return loaded_arguments
        raise ModelResponseError(
            f"Responses function_call item at index {index} has malformed 'arguments'."
        )

    def parse_optional_arguments(
        self,
        *,
        item: dict[str, object],
        index: int,
    ) -> dict[str, object]:
        if "arguments" not in item or item.get("arguments") in ("", None):
            return {}
        return self.parse_function_call_arguments(item=item, index=index)

    def render_mcp_call_summary(self, *, name: str, output: str | None) -> str:
        if output and output.strip():
            return f"Provider MCP call {name} completed: {output}"
        return f"Provider MCP call {name} completed."

    def _reasoning_blocks(
        self,
        parsed_item: ResponsesReasoningOutputItem,
    ) -> list[RuntimeBlock]:
        return [
            RuntimeBlock(
                type="reasoning",
                text=summary_text,
                provider_id=parsed_item.provider_id,
                metadata={
                    "provider_item_type": "reasoning",
                    "status": parsed_item.status,
                },
            )
            for summary_text in parsed_item.summaries
        ]

    def _function_call_block(
        self,
        parsed_item: ResponsesFunctionCallOutputItem,
        *,
        index: int,
    ) -> RuntimeBlock:
        if not parsed_item.name:
            raise ModelResponseError(
                f"Responses function_call item at index {index} is missing required 'name'."
            )
        if not parsed_item.call_id:
            raise ModelResponseError(
                f"Responses function_call item at index {index} is missing required 'call_id'."
            )
        arguments = self.parse_function_call_arguments(
            item={"arguments": parsed_item.arguments},
            index=index,
        )
        return RuntimeBlock(
            type="tool_call",
            tool_name=parsed_item.name,
            tool_arguments=arguments,
            call_id=parsed_item.call_id,
            provider_id=parsed_item.provider_id,
            metadata={
                "provider_item_type": "function_call",
                "status": parsed_item.status,
            },
        )

    def _message_blocks(
        self,
        parsed_item: ResponsesMessageOutputItem,
        *,
        item_type: str,
    ) -> list[RuntimeBlock]:
        message_blocks = [
            RuntimeBlock(
                type="text",
                text=raw_text,
                provider_id=parsed_item.provider_id,
                metadata={
                    "provider_item_type": "message.output_text",
                    "status": parsed_item.status,
                },
            )
            for raw_text in parsed_item.texts
        ]
        if not message_blocks and item_type == "message":
            raise ModelResponseError(
                "Responses message item did not contain supported output_text content."
            )
        return message_blocks

    def _mcp_call_block(
        self,
        parsed_item: ResponsesMcpCallOutputItem,
        *,
        index: int,
    ) -> RuntimeBlock:
        return RuntimeBlock(
            type="reasoning",
            text=self.render_mcp_call_summary(
                name=parsed_item.name,
                output=parsed_item.output,
            ),
            provider_id=parsed_item.provider_id,
            metadata={
                "provider_item_type": "mcp_call",
                "status": parsed_item.status,
                "name": parsed_item.name,
                "arguments": (
                    self.parse_optional_arguments(
                        item={"arguments": parsed_item.arguments},
                        index=index,
                    )
                    if parsed_item.arguments not in (None, "")
                    else {}
                ),
            },
        )

from __future__ import annotations

import json

from mycli.domain.runtime.blocks import RuntimeBlock, RuntimeItem
from mycli.domain.runtime.images import image_block_to_responses_content
from mycli.llms.adapters.base import ModelToolDefinition
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.schemas.responses_protocol import ResponsesFunctionCallOutputPayload
from mycli.utils.provider_replay import responses_replay_items


class ResponsesInputSerializer:
    def serialize_items(self, items: list[RuntimeItem]) -> list[dict[str, object]]:
        serialized_items: list[dict[str, object]] = []
        serialized_tool_call_ids: set[str] = set()
        for item in items:
            provider_state = item.metadata.get("provider_state")
            serialized_items.extend(responses_replay_items(provider_state))
            content: list[dict[str, object]] = []

            def flush_message_content() -> None:
                nonlocal content
                if not content:
                    return
                if item.role not in ("system", "developer", "user", "assistant"):
                    raise ModelResponseError(
                        "Responses input_text blocks only support system/developer/user/assistant roles."
                    )
                serialized_items.append(
                    {
                        "role": item.role,
                        "content": content,
                    }
                )
                content = []

            for block in item.blocks:
                if block.type in ("text", "reasoning"):
                    if block.text is None:
                        continue
                    content.append(
                        {
                            "type": "input_text",
                            "text": block.text,
                        }
                    )
                    continue
                if block.type == "image":
                    content.append(image_block_to_responses_content(block))
                    continue

                flush_message_content()

                if block.type == "tool_call":
                    tool_call_item = self._tool_call_item(block)
                    call_id = str(tool_call_item["call_id"])
                    if call_id in serialized_tool_call_ids:
                        continue
                    serialized_tool_call_ids.add(call_id)
                    serialized_items.append(tool_call_item)
                    continue
                if block.type == "tool_result":
                    serialized_items.append(self._tool_result_item(block))
                    continue
                raise ModelResponseError(
                    f"Unsupported runtime block type for Responses input: {block.type}."
                )

            flush_message_content()
        return serialized_items

    def serialize_tools(self, tools: list[ModelToolDefinition]) -> list[dict[str, object]]:
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "parameters": [
                    (
                        {
                            "name": parameter.name,
                            "type": parameter.type,
                            "required": parameter.required,
                            "description": parameter.description,
                        }
                        if parameter.items_schema is None
                        else {
                            "name": parameter.name,
                            "type": parameter.type,
                            "required": parameter.required,
                            "description": parameter.description,
                            "items_schema": dict(parameter.items_schema),
                        }
                    )
                    for parameter in tool.parameters
                ],
            }
            for tool in tools
        ]

    def function_call_output_payload_for_block(
        self,
        *,
        block: RuntimeBlock,
    ) -> ResponsesFunctionCallOutputPayload:
        raw_payload = block.metadata.get("function_call_output_payload")
        if isinstance(raw_payload, dict):
            return ResponsesFunctionCallOutputPayload.from_dict(raw_payload)
        success = block.metadata.get("success")
        success_flag = success if isinstance(success, bool) else None
        return ResponsesFunctionCallOutputPayload.from_text(
            "" if block.text is None else block.text,
            success=success_flag,
        )

    def _tool_call_item(self, block: RuntimeBlock) -> dict[str, object]:
        if not block.call_id:
            raise ModelResponseError(
                "Runtime tool_call block requires call_id for Responses input."
            )
        raw_name = block.tool_name
        if not isinstance(raw_name, str) or not raw_name:
            raise ModelResponseError(
                "Runtime tool_call block requires tool_name for Responses input."
            )
        raw_arguments = block.tool_arguments
        arguments = raw_arguments if isinstance(raw_arguments, dict) else {}
        return {
            "type": "function_call",
            "name": raw_name,
            "arguments": json.dumps(arguments, ensure_ascii=False),
            "call_id": block.call_id,
        }

    def _tool_result_item(self, block: RuntimeBlock) -> dict[str, object]:
        if not block.call_id:
            raise ModelResponseError(
                "Runtime tool_result block requires call_id for Responses input."
            )
        payload = self.function_call_output_payload_for_block(block=block)
        return {
            "type": "function_call_output",
            "call_id": block.call_id,
            "output": payload.to_wire_output(),
        }

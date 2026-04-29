from __future__ import annotations

import json
from typing import Any

from mycli.domain.conversation import Message
from mycli.domain.runtime import (
    AgentConfig,
    FragmentStability,
    InstructionContract,
    ProviderMessageShape,
    RequestFragment,
    RequestFragmentKind,
    RequestShape,
    stable_hash,
)
from mycli.infrastructure.models.base import ModelToolDefinition


class RequestShapeBuilder:
    def build(
        self,
        *,
        config: AgentConfig,
        contract: InstructionContract,
        tools: tuple[ModelToolDefinition, ...] | list[ModelToolDefinition],
    ) -> RequestShape:
        normalized_tools = self._normalized_tools(tools)
        tool_schema = self._tool_schema_content(normalized_tools)
        tool_order = "\n".join(tool["name"] for tool in normalized_tools)
        volatile_context = self._render_volatile_context(contract)
        intent_content = f"Current user request: {contract.current_user_request}"

        fragments = (
            RequestFragment(
                id="stable:system",
                kind=RequestFragmentKind.STABLE,
                content=contract.base_instructions,
                stability=FragmentStability.STABLE,
            ),
            RequestFragment(
                id="stable:tool_schema",
                kind=RequestFragmentKind.STABLE,
                content=tool_schema,
                stability=FragmentStability.STABLE,
            ),
            RequestFragment(
                id="replay:conversation",
                kind=RequestFragmentKind.REPLAY,
                content=self._render_replay(
                    self._replay_messages(contract),
                ),
                stability=FragmentStability.REPLAY,
            ),
            RequestFragment(
                id="intent:current",
                kind=RequestFragmentKind.INTENT,
                content=intent_content,
                stability=FragmentStability.VOLATILE,
            ),
            RequestFragment(
                id="volatile:context",
                kind=RequestFragmentKind.VOLATILE,
                content=volatile_context,
                stability=FragmentStability.VOLATILE,
            ),
        )
        return RequestShape(
            provider=str(config.provider),
            protocol=str(config.protocol),
            model=config.model,
            stable_system=contract.base_instructions,
            tool_schema_hash=stable_hash(tool_schema),
            tool_order_hash=stable_hash(tool_order),
            fragments=fragments,
            provider_messages=self._provider_messages(
                contract=contract,
                intent_content=intent_content,
                volatile_context=volatile_context,
            ),
        )

    def _provider_messages(
        self,
        *,
        contract: InstructionContract,
        intent_content: str,
        volatile_context: str,
    ) -> tuple[ProviderMessageShape, ...]:
        messages: list[ProviderMessageShape] = [
            ProviderMessageShape(role="system", content=contract.base_instructions),
        ]
        developer_content = self._join_content(
            section.content for section in contract.developer_sections
        )
        if developer_content:
            messages.append(ProviderMessageShape(role="developer", content=developer_content))
        for message in self._replay_messages(contract):
            provider_message = self._provider_message_from_replay_message(message)
            if provider_message is not None:
                messages.append(provider_message)
        if intent_content:
            messages.append(ProviderMessageShape(role="user", content=intent_content))
        if volatile_context:
            messages.append(ProviderMessageShape(role="user", content=volatile_context))
        return tuple(messages)

    def _render_replay(self, messages: tuple[Message, ...]) -> str:
        return self._join_content(
            f"{message.role}: {self._message_content(message)}"
            for message in messages
            if self._message_content(message)
        )

    def _replay_messages(self, contract: InstructionContract) -> tuple[Message, ...]:
        return tuple(
            message
            for message in contract.conversation_messages
            if not (
                message.role == "user"
                and message.content == contract.current_user_request
            )
        )

    def _render_volatile_context(self, contract: InstructionContract) -> str:
        return self._join_content(
            section.content for section in contract.contextual_user_sections
        )

    def _message_content(self, message: Message) -> str:
        if message.content:
            return message.content
        if message.tool_calls:
            return json.dumps(
                [
                    {
                        "name": call.name,
                        "arguments": call.arguments,
                        "call_id": call.call_id,
                    }
                    for call in message.tool_calls
                ],
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            )
        return ""

    def _provider_message_from_replay_message(
        self,
        message: Message,
    ) -> ProviderMessageShape | None:
        content = self._message_content(message)
        if not content:
            return None
        metadata: dict[str, Any] = {
            "legacy_content": message.content,
            "model_metadata": self._message_metadata_from_blocks(message),
        }
        if message.tool_call_id:
            metadata["tool_call_id"] = message.tool_call_id
        if message.tool_calls:
            metadata["tool_calls"] = message.tool_calls
        return ProviderMessageShape(
            role=message.role,
            content=content,
            metadata=metadata,
        )

    def _message_metadata_from_blocks(self, message: Message) -> dict[str, object]:
        metadata: dict[str, object] = {}
        for block in message.blocks:
            for key, value in block.metadata.items():
                existing = metadata.get(key)
                if isinstance(existing, dict) and isinstance(value, dict):
                    nested = dict(existing)
                    nested.update(value)
                    metadata[key] = nested
                    continue
                metadata[key] = value
        return metadata

    def _normalized_tools(
        self,
        tools: tuple[ModelToolDefinition, ...] | list[ModelToolDefinition],
    ) -> tuple[dict[str, Any], ...]:
        normalized = [
            {
                "name": tool.name,
                "description": tool.description,
                "parameters": [
                    {
                        "name": parameter.name,
                        "type": parameter.type,
                        "required": parameter.required,
                        "description": parameter.description,
                        "items_schema": parameter.items_schema,
                    }
                    for parameter in sorted(tool.parameters, key=lambda item: item.name)
                ],
            }
            for tool in tools
        ]
        return tuple(sorted(normalized, key=lambda item: str(item["name"])))

    def _tool_schema_content(self, tools: tuple[dict[str, Any], ...]) -> str:
        return json.dumps(
            tools,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )

    def _join_content(self, values: object) -> str:
        if not hasattr(values, "__iter__"):
            return ""
        return "\n".join(str(value) for value in values if str(value).strip())

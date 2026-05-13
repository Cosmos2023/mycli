from __future__ import annotations

import json
from typing import Any

from mycli.domain.conversation import Message
from mycli.domain.runtime import (
    AgentConfig,
    FragmentStability,
    InstructionContract,
    InstructionFragment,
    ProviderMessageShape,
    ProviderRuntimeItemShape,
    RequestFragment,
    RequestFragmentKind,
    RequestShape,
    RuntimeBlock,
    stable_hash,
)
from mycli.application.runtime.request.message_projection import RequestMessageProjector
from mycli.llms.adapters.base import ModelToolDefinition


class RequestShapeBuilder:
    def __init__(self) -> None:
        self._messages = RequestMessageProjector()

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
                content=self._messages.render_replay(
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
            *self._contextual_fragments(contract),
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
                config=config,
                contract=contract,
                intent_content=intent_content,
                volatile_context=volatile_context,
            ),
            provider_runtime_items=self._provider_runtime_items(
                config=config,
                contract=contract,
                intent_content=intent_content,
                volatile_context=volatile_context,
            ),
        )

    def _provider_messages(
        self,
        *,
        config: AgentConfig,
        contract: InstructionContract,
        intent_content: str,
        volatile_context: str,
    ) -> tuple[ProviderMessageShape, ...]:
        if self._uses_transcript_only_messages(config):
            return self._transcript_provider_messages(contract)
        if self._uses_responses_delta_input(config):
            return self._responses_provider_messages(contract)

        messages: list[ProviderMessageShape] = [
            ProviderMessageShape(role="system", content=contract.base_instructions),
        ]
        developer_content = self._join_content(
            self._developer_section_content(section)
            for section in contract.developer_sections
        )
        if developer_content:
            messages.append(ProviderMessageShape(role="developer", content=developer_content))
        for message in self._replay_messages(contract):
            provider_message = self._messages.provider_message_from_replay_message(message)
            if provider_message is not None:
                messages.append(provider_message)
        if intent_content and not self._replay_contains_current_user_request(contract):
            messages.append(ProviderMessageShape(role="user", content=intent_content))
        if volatile_context:
            messages.append(ProviderMessageShape(role="user", content=volatile_context))
        return tuple(messages)

    def _uses_transcript_only_messages(self, config: AgentConfig) -> bool:
        return str(config.protocol) == "chat_completions"

    def _uses_responses_delta_input(self, config: AgentConfig) -> bool:
        return str(config.protocol) == "responses"

    def _responses_provider_messages(
        self,
        contract: InstructionContract,
    ) -> tuple[ProviderMessageShape, ...]:
        delta_context = self._render_responses_delta_context(contract)
        messages: list[ProviderMessageShape] = [
            ProviderMessageShape(role="system", content=contract.base_instructions),
        ]
        developer_content = self._join_content(
            self._developer_section_content(section)
            for section in contract.developer_sections
        )
        if developer_content:
            messages.append(ProviderMessageShape(role="developer", content=developer_content))
        for message in self._replay_messages(contract):
            provider_message = self._messages.provider_message_from_replay_message(message)
            if provider_message is not None:
                messages.append(provider_message)
        if contract.current_user_request and not self._replay_contains_current_user_request(
            contract
        ):
            messages.append(
                ProviderMessageShape(
                    role="user",
                    content=contract.current_user_request,
                )
            )
        if delta_context:
            messages.append(ProviderMessageShape(role="user", content=delta_context))
        return tuple(messages)

    def _transcript_provider_messages(
        self,
        contract: InstructionContract,
    ) -> tuple[ProviderMessageShape, ...]:
        messages: list[ProviderMessageShape] = [
            ProviderMessageShape(role="system", content=contract.base_instructions),
        ]
        for message in self._chat_completions_replay_messages(contract):
            provider_message = self._messages.provider_message_from_replay_message(message)
            if provider_message is not None:
                messages.append(provider_message)
        if contract.current_user_request and not self._replay_contains_current_user_request(
            contract
        ):
            messages.append(
                ProviderMessageShape(
                    role="user",
                    content=contract.current_user_request,
                )
            )
        return tuple(messages)

    def _provider_runtime_items(
        self,
        *,
        config: AgentConfig,
        contract: InstructionContract,
        intent_content: str,
        volatile_context: str,
    ) -> tuple[ProviderRuntimeItemShape, ...]:
        if self._uses_transcript_only_messages(config):
            return self._transcript_provider_runtime_items(contract)
        if self._uses_responses_delta_input(config):
            return self._responses_provider_runtime_items(contract)

        items: list[ProviderRuntimeItemShape] = [
            ProviderRuntimeItemShape(
                role="system",
                blocks=(RuntimeBlock(type="text", text=contract.base_instructions),),
            )
        ]
        developer_content = self._join_content(
            self._developer_section_content(section)
            for section in contract.developer_sections
        )
        if developer_content:
            items.append(
                ProviderRuntimeItemShape(
                    role="developer",
                    blocks=(RuntimeBlock(type="text", text=developer_content),),
                )
            )
        for message in self._chat_completions_replay_messages(contract):
            blocks = self._messages.runtime_blocks_from_message(message)
            if blocks:
                items.append(ProviderRuntimeItemShape(role=message.role, blocks=blocks))
        if intent_content and not self._replay_contains_current_user_request(contract):
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=intent_content),),
                )
            )
        if volatile_context:
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=volatile_context),),
                )
        )
        return tuple(items)

    def _responses_provider_runtime_items(
        self,
        contract: InstructionContract,
    ) -> tuple[ProviderRuntimeItemShape, ...]:
        delta_context = self._render_responses_delta_context(contract)
        items: list[ProviderRuntimeItemShape] = [
            ProviderRuntimeItemShape(
                role="system",
                blocks=(RuntimeBlock(type="text", text=contract.base_instructions),),
            )
        ]
        developer_content = self._join_content(
            self._developer_section_content(section)
            for section in contract.developer_sections
        )
        if developer_content:
            items.append(
                ProviderRuntimeItemShape(
                    role="developer",
                    blocks=(RuntimeBlock(type="text", text=developer_content),),
                )
            )
        for message in self._replay_messages(contract):
            blocks = self._messages.runtime_blocks_from_message(message)
            if blocks:
                items.append(ProviderRuntimeItemShape(role=message.role, blocks=blocks))
        if contract.current_user_request and not self._replay_contains_current_user_request(
            contract
        ):
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=contract.current_user_request),),
                )
            )
        if delta_context:
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=delta_context),),
                )
            )
        return tuple(items)

    def _transcript_provider_runtime_items(
        self,
        contract: InstructionContract,
    ) -> tuple[ProviderRuntimeItemShape, ...]:
        items: list[ProviderRuntimeItemShape] = [
            ProviderRuntimeItemShape(
                role="system",
                blocks=(RuntimeBlock(type="text", text=contract.base_instructions),),
            )
        ]
        for message in self._replay_messages(contract):
            blocks = self._messages.runtime_blocks_from_message(message)
            if blocks:
                items.append(ProviderRuntimeItemShape(role=message.role, blocks=blocks))
        if contract.current_user_request and not self._replay_contains_current_user_request(
            contract
        ):
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=contract.current_user_request),),
                )
            )
        return tuple(items)

    def _replay_messages(self, contract: InstructionContract) -> tuple[Message, ...]:
        return contract.conversation_messages

    def _chat_completions_replay_messages(
        self,
        contract: InstructionContract,
    ) -> tuple[Message, ...]:
        pending_tool_call_ids: set[str] = set()
        filtered: list[Message] = []
        for message in self._replay_messages(contract):
            if message.role == "tool":
                if message.tool_call_id and message.tool_call_id in pending_tool_call_ids:
                    filtered.append(message)
                    pending_tool_call_ids.remove(message.tool_call_id)
                continue
            filtered.append(message)
            if message.role == "assistant":
                pending_tool_call_ids = {
                    call.call_id
                    for call in self._messages.tool_calls_from_message(message)
                    if call.call_id
                }
            else:
                pending_tool_call_ids.clear()
        return tuple(filtered)

    def _replay_contains_current_user_request(
        self,
        contract: InstructionContract,
    ) -> bool:
        return any(
            message.role == "user"
            and message.content == contract.current_user_request
            for message in contract.conversation_messages
        )

    def _render_volatile_context(self, contract: InstructionContract) -> str:
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in contract.contextual_user_sections
        )

    def _developer_section_content(self, section: InstructionFragment) -> str:
        if str(section.kind) != "tool_exposure":
            return section.content.strip()
        return (
            "Use the tool schema attached to this request as the authoritative, "
            "equal toolset. Tool execution safety is enforced by the runtime."
        )

    def _render_responses_delta_context(self, contract: InstructionContract) -> str:
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in contract.contextual_user_sections
            if self._responses_contextual_section_is_model_visible(section)
        )

    def _responses_contextual_section_is_model_visible(
        self,
        section: InstructionFragment,
    ) -> bool:
        return str(section.kind) in {
            "capability_body",
            "memory",
            "runtime_policy",
            "workspace_instructions",
        }

    def _contextual_fragments(
        self,
        contract: InstructionContract,
    ) -> tuple[RequestFragment, ...]:
        fragments: list[RequestFragment] = []
        seen: dict[str, int] = {}
        for section in contract.contextual_user_sections:
            content = self._contextual_section_content(section, contract).strip()
            if not content:
                continue
            base_id, kind = self._fragment_identity(str(section.kind))
            index = seen.get(base_id, 0)
            seen[base_id] = index + 1
            fragment_id = base_id if index == 0 else f"{base_id}:{index + 1}"
            fragments.append(
                RequestFragment(
                    id=fragment_id,
                    kind=kind,
                    content=content,
                    stability=FragmentStability.VOLATILE,
                    metadata={
                        "title": section.title,
                        "source": section.source,
                        "instruction_fragment_kind": str(section.kind),
                    },
                )
            )
        return tuple(fragments)

    def _contextual_section_content(
        self,
        section: InstructionFragment,
        contract: InstructionContract,
    ) -> str:
        content = section.content.strip()
        if str(section.kind) != "conversation_context":
            return content
        return self._deduplicated_conversation_context(content, contract)

    def _deduplicated_conversation_context(
        self,
        content: str,
        contract: InstructionContract,
    ) -> str:
        replay_lines = {
            f"{message.role}: {self._messages.message_content(message)}"
            for message in self._replay_messages(contract)
            if self._messages.message_content(message)
        }
        if not replay_lines:
            return content

        lines: list[str] = []
        for raw_line in content.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            if line in replay_lines:
                continue
            lines.append(line)
        return "\n".join(lines)

    def _fragment_identity(
        self,
        section_kind: str,
    ) -> tuple[str, RequestFragmentKind]:
        normalized = section_kind.strip().lower().replace(" ", "_")
        if normalized == "memory":
            return "retrieved_memory", RequestFragmentKind.RETRIEVED_MEMORY
        if normalized == "tool_exposure":
            return "stable:tool_exposure", RequestFragmentKind.STABLE
        return f"volatile:{normalized}", RequestFragmentKind.VOLATILE

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

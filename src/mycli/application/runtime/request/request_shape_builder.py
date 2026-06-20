from __future__ import annotations

import json
from typing import Any

from mycli.domain.conversation import Message
from mycli.domain.runtime import (
    AgentConfig,
    FragmentStability,
    InstructionContract,
    InstructionFragment,
    ProviderCachePolicyCapability,
    ProviderMessageShape,
    ProviderProjectionLane,
    ProviderProjectionShape,
    ProviderRequestPolicyShape,
    ProviderRuntimeItemShape,
    RequestFragment,
    RequestFragmentKind,
    RequestShape,
    RuntimeBlock,
    stable_hash,
)
from mycli.application.runtime.request.message_projection import RequestMessageProjector
from mycli.llms.adapters.base import ModelToolDefinition

TOOL_RUNTIME_REMINDER_TAG = "tool_runtime_reminder"
POST_TOOL_ADDITIONAL_CONTEXTS_METADATA_KEY = "post_tool_additional_contexts"


class RequestShapeBuilder:
    def __init__(self) -> None:
        self._messages = RequestMessageProjector()

    def build(
        self,
        *,
        config: AgentConfig,
        contract: InstructionContract,
        tools: tuple[ModelToolDefinition, ...] | list[ModelToolDefinition],
        cache_policy_capability: ProviderCachePolicyCapability | None = None,
    ) -> RequestShape:
        normalized_tools = self._normalized_tools(tools)
        tool_schema = self._tool_schema_content(normalized_tools)
        tool_order = "\n".join(tool["name"] for tool in normalized_tools)
        contextual_fragments = self._contextual_fragments(contract)
        intent_content = contract.current_user_request
        replay_content = self._messages.render_replay(
            self._replay_messages(contract),
        )
        stable_system = self._stable_system_for_shape(config, contract)

        fragments = (
            RequestFragment(
                id="stable:system",
                kind=RequestFragmentKind.STABLE,
                content=contract.base_instructions,
                stability=FragmentStability.STABLE,
                metadata={
                    "source": "system_prompt",
                    "cache_class": "static",
                    "section_hash": stable_hash(contract.base_instructions),
                },
            ),
            RequestFragment(
                id="stable:tool_schema",
                kind=RequestFragmentKind.STABLE,
                content=tool_schema,
                stability=FragmentStability.STABLE,
                metadata={
                    "source": "tool_schema",
                    "cache_class": "static",
                    "section_hash": stable_hash(tool_schema),
                },
            ),
            *self._stable_contextual_fragments(contextual_fragments),
            RequestFragment(
                id="replay:conversation",
                kind=RequestFragmentKind.REPLAY,
                content=replay_content,
                stability=FragmentStability.REPLAY,
                metadata={
                    "source": "conversation_replay",
                    "cache_class": "dynamic",
                    "section_hash": stable_hash(replay_content),
                },
            ),
            *self._dynamic_contextual_fragments(contextual_fragments),
            *self._ephemeral_contextual_fragments(contextual_fragments),
            RequestFragment(
                id="intent:current",
                kind=RequestFragmentKind.INTENT,
                content=intent_content,
                stability=FragmentStability.VOLATILE,
                metadata={
                    "source": "user_message",
                    "cache_class": "ephemeral",
                    "section_hash": stable_hash(intent_content),
                },
            ),
        )
        provider_messages = self._provider_messages(
            config=config,
            contract=contract,
            intent_content=intent_content,
        )
        provider_runtime_items = self._provider_runtime_items(
            config=config,
            contract=contract,
            intent_content=intent_content,
        )
        provider_projection = self._provider_projection(
            config=config,
            fragments=fragments,
            provider_messages=provider_messages,
            provider_runtime_items=provider_runtime_items,
        )
        provider_request_policy = ProviderRequestPolicyShape.for_request_shape(
            provider=str(config.provider),
            protocol=str(config.protocol),
            model=config.model,
            system_hash=stable_hash(contract.base_instructions),
            tool_schema_hash=stable_hash(tool_schema),
            cacheable_prefix_hash=self._cacheable_prefix_hash(fragments),
            lane=provider_projection.lane,
            capability=cache_policy_capability,
        )
        provider_messages = self._attach_provider_request_policy_to_messages(
            provider_messages,
            policy=provider_request_policy,
        )
        provider_runtime_items = self._attach_provider_request_policy_to_runtime_items(
            provider_runtime_items,
            policy=provider_request_policy,
        )
        return RequestShape(
            provider=str(config.provider),
            protocol=str(config.protocol),
            model=config.model,
            stable_system=stable_system,
            wire_instructions=stable_system if self._uses_responses_delta_input(config) else None,
            tool_schema_hash=stable_hash(tool_schema),
            tool_order_hash=stable_hash(tool_order),
            fragments=fragments,
            provider_messages=provider_messages,
            provider_runtime_items=provider_runtime_items,
            provider_projection=provider_projection,
            provider_request_policy=provider_request_policy,
        )

    def _cacheable_prefix_hash(
        self,
        fragments: tuple[RequestFragment, ...],
    ) -> str:
        hashes: list[str] = []
        for fragment in fragments:
            if fragment.stability is not FragmentStability.STABLE:
                break
            hashes.append(fragment.content_hash)
        return stable_hash("\n".join(hashes))

    def _attach_provider_request_policy_to_messages(
        self,
        messages: tuple[ProviderMessageShape, ...],
        *,
        policy: ProviderRequestPolicyShape,
    ) -> tuple[ProviderMessageShape, ...]:
        if not messages:
            return messages
        policy_payload = policy.to_wire_dict()
        attached: list[ProviderMessageShape] = []
        for index, message in enumerate(messages):
            metadata = dict(message.metadata)
            if index == 0:
                metadata["provider_request_policy"] = policy_payload
            self._mark_qwen_cache_control_message_metadata(
                metadata,
                role=message.role,
                attached=attached,
                policy=policy,
            )
            attached.append(
                ProviderMessageShape(
                    role=message.role,
                    content=message.content,
                    metadata=metadata,
                )
            )
        return tuple(attached)

    def _attach_provider_request_policy_to_runtime_items(
        self,
        items: tuple[ProviderRuntimeItemShape, ...],
        *,
        policy: ProviderRequestPolicyShape,
    ) -> tuple[ProviderRuntimeItemShape, ...]:
        if not items:
            return items
        attached: list[ProviderRuntimeItemShape] = []
        policy_payload = policy.to_wire_dict()
        for index, item in enumerate(items):
            metadata = dict(item.metadata)
            if index == 0:
                metadata["provider_request_policy"] = policy_payload
            qwen_breakpoint = self._qwen_cache_control_breakpoint(
                metadata,
                role=item.role,
                attached_cache_breakpoints=tuple(
                    str(existing.metadata.get("qwen_cache_control_breakpoint"))
                    for existing in attached
                    if existing.metadata.get("qwen_cache_control_breakpoint")
                ),
                policy=policy,
            )
            if qwen_breakpoint:
                metadata["qwen_cache_control_breakpoint"] = qwen_breakpoint
                blocks = self._mark_qwen_cache_control_blocks(
                    item.blocks,
                    breakpoint=qwen_breakpoint,
                )
            else:
                blocks = item.blocks
            if (
                policy.lane is ProviderProjectionLane.ANTHROPIC_MESSAGES
                and "system_static" in policy.anthropic_cache_control_breakpoints
                and item.role in {"system", "developer"}
            ):
                metadata["anthropic_cache_control_breakpoint"] = "system_static"
            elif (
                policy.lane is ProviderProjectionLane.ANTHROPIC_MESSAGES
                and "dynamic_boundary" in policy.anthropic_cache_control_breakpoints
                and item.role == "user"
                and item.metadata.get("cache_class") == "dynamic"
                and not any(
                    existing.metadata.get("anthropic_cache_control_breakpoint")
                    == "dynamic_boundary"
                    for existing in attached
                )
            ):
                metadata["anthropic_cache_control_breakpoint"] = "dynamic_boundary"
            attached.append(
                ProviderRuntimeItemShape(
                    role=item.role,
                    blocks=blocks,
                    metadata=metadata,
                )
            )
        return tuple(attached)

    def _mark_qwen_cache_control_message_metadata(
        self,
        metadata: dict[str, Any],
        *,
        role: str,
        attached: list[ProviderMessageShape],
        policy: ProviderRequestPolicyShape,
    ) -> None:
        breakpoint = self._qwen_cache_control_breakpoint(
            metadata,
            role=role,
            attached_cache_breakpoints=tuple(
                str(existing.metadata.get("qwen_cache_control_breakpoint"))
                for existing in attached
                if existing.metadata.get("qwen_cache_control_breakpoint")
            ),
            policy=policy,
        )
        if breakpoint:
            metadata["qwen_cache_control_breakpoint"] = breakpoint

    def _qwen_cache_control_breakpoint(
        self,
        metadata: dict[str, Any],
        *,
        role: str,
        attached_cache_breakpoints: tuple[str, ...],
        policy: ProviderRequestPolicyShape,
    ) -> str | None:
        if policy.provider_family != "qwen":
            return None
        if policy.cache_strategy != "cache_control":
            return None
        breakpoints = policy.cache_control_breakpoints
        if "system_static" in breakpoints and not attached_cache_breakpoints and role in {
            "system",
            "developer",
        }:
            return "system_static"
        if (
            "dynamic_boundary" in breakpoints
            and metadata.get("cache_class") == "dynamic"
            and "dynamic_boundary" not in attached_cache_breakpoints
        ):
            return "dynamic_boundary"
        return None

    def _mark_qwen_cache_control_blocks(
        self,
        blocks: tuple[RuntimeBlock, ...],
        *,
        breakpoint: str,
    ) -> tuple[RuntimeBlock, ...]:
        marked: list[RuntimeBlock] = []
        for block in blocks:
            if block.type != "text":
                marked.append(block)
                continue
            metadata = dict(block.metadata)
            metadata["qwen_cache_control_breakpoint"] = breakpoint
            marked.append(
                RuntimeBlock(
                    type=block.type,
                    text=block.text,
                    tool_name=block.tool_name,
                    tool_arguments=block.tool_arguments,
                    call_id=block.call_id,
                    provider_id=block.provider_id,
                    source=block.source,
                    metadata=metadata,
                )
            )
        return tuple(marked)

    def _provider_messages(
        self,
        *,
        config: AgentConfig,
        contract: InstructionContract,
        intent_content: str,
    ) -> tuple[ProviderMessageShape, ...]:
        if self._uses_transcript_only_messages(config):
            return self._transcript_provider_messages(contract)
        if self._uses_responses_delta_input(config):
            return self._responses_provider_messages(contract)

        stable_context = self._render_context_by_cache_class(
            contract,
            cache_classes={"static"},
        )
        dynamic_context = self._render_context_by_cache_class(
            contract,
            cache_classes={"dynamic"},
        )
        ephemeral_context = self._render_non_reminder_context_by_cache_class(
            contract,
            cache_classes={"ephemeral"},
        )

        messages: list[ProviderMessageShape] = [
            ProviderMessageShape(role="system", content=contract.base_instructions),
        ]
        developer_content = self._join_content(
            self._developer_section_content(section)
            for section in contract.developer_sections
        )
        if developer_content:
            messages.append(ProviderMessageShape(role="developer", content=developer_content))
        if stable_context:
            messages.append(
                ProviderMessageShape(
                    role="user",
                    content=stable_context,
                    metadata={
                        "cache_class": "static",
                        "source": "provider_context_projection",
                    },
                )
            )
        for message in self._replay_messages(contract):
            provider_message = self._messages.provider_message_from_replay_message(message)
            if provider_message is not None:
                messages.append(provider_message)
        messages = self._with_chat_post_tool_context_messages(messages)
        if dynamic_context:
            messages.append(
                ProviderMessageShape(
                    role="user",
                    content=dynamic_context,
                    metadata={
                        "cache_class": "dynamic",
                        "source": "provider_context_projection",
                    },
                )
            )
        if ephemeral_context:
            messages.append(
                ProviderMessageShape(
                    role="user",
                    content=ephemeral_context,
                    metadata={
                        "cache_class": "ephemeral",
                        "source": "provider_context_projection",
                    },
                )
            )
        if intent_content and not self._replay_contains_current_user_request(contract):
            messages.append(ProviderMessageShape(role="user", content=intent_content))
        return tuple(messages)

    def _uses_transcript_only_messages(self, config: AgentConfig) -> bool:
        return str(config.protocol) == "chat_completions"

    def _uses_responses_delta_input(self, config: AgentConfig) -> bool:
        return str(config.protocol) == "responses"

    def _responses_provider_messages(
        self,
        contract: InstructionContract,
    ) -> tuple[ProviderMessageShape, ...]:
        static_context = self._render_responses_delta_context(
            contract,
            cache_classes={"static"},
        )
        dynamic_context = self._render_responses_delta_context(
            contract,
            cache_classes={"dynamic"},
        )
        ephemeral_context = self._render_responses_non_reminder_delta_context(contract)
        messages: list[ProviderMessageShape] = []
        developer_content = self._join_content(
            self._developer_section_content(section)
            for section in contract.developer_sections
        )
        if developer_content:
            messages.append(ProviderMessageShape(role="developer", content=developer_content))
        if static_context:
            messages.append(
                ProviderMessageShape(
                    role="user",
                    content=static_context,
                    metadata={
                        "cache_class": "static",
                        "source": "provider_context_projection",
                    },
                )
            )
        replay_before_current, replayed_current_user, replay_after_current = (
            self._split_replayed_current_user_turn(contract)
        )
        for message in replay_before_current:
            provider_message = self._messages.provider_message_from_replay_message(message)
            if provider_message is not None:
                messages.append(provider_message)
        if dynamic_context:
            messages.append(
                ProviderMessageShape(
                    role="user",
                    content=dynamic_context,
                    metadata={
                        "cache_class": "dynamic",
                        "source": "provider_context_projection",
                    },
                )
            )
        if ephemeral_context:
            messages.append(
                ProviderMessageShape(
                    role="user",
                    content=ephemeral_context,
                    metadata={
                        "cache_class": "ephemeral",
                        "source": "provider_context_projection",
                    },
                )
            )
        if replayed_current_user is not None:
            messages.append(
                ProviderMessageShape(
                    role="user",
                    content=replayed_current_user.content,
                )
            )
        elif contract.current_user_request and not self._replay_contains_current_user_request(
            contract
        ):
            messages.append(
                ProviderMessageShape(
                    role="user",
                    content=contract.current_user_request,
                )
            )
        for message in replay_after_current:
            provider_message = self._messages.provider_message_from_replay_message(message)
            if provider_message is not None:
                messages.append(provider_message)
        messages = self._with_chat_post_tool_context_messages(messages)
        return tuple(messages)

    def _transcript_provider_messages(
        self,
        contract: InstructionContract,
    ) -> tuple[ProviderMessageShape, ...]:
        messages: list[ProviderMessageShape] = [
            ProviderMessageShape(
                role="system",
                content=self._transcript_stable_system_content(contract),
            ),
        ]
        dynamic_context = self._transcript_dynamic_context(contract)
        if dynamic_context:
            messages.append(
                ProviderMessageShape(
                    role="user",
                    content=dynamic_context,
                    metadata={
                        "cache_class": "dynamic",
                        "source": "provider_transcript_projection",
                    },
                )
            )
        for message in self._chat_completions_replay_messages(contract):
            provider_message = self._messages.provider_message_from_replay_message(message)
            if provider_message is not None:
                messages.append(provider_message)
        messages = self._with_chat_post_tool_context_messages(messages)
        ephemeral_context = self._transcript_ephemeral_context(contract)
        if ephemeral_context:
            messages.append(
                ProviderMessageShape(
                    role="user",
                    content=ephemeral_context,
                    metadata={
                        "cache_class": "ephemeral",
                        "source": "provider_transcript_projection",
                    },
                )
            )
        compaction_rehydration = self._transcript_compaction_rehydration_context(contract)
        if compaction_rehydration:
            messages.append(
                ProviderMessageShape(
                    role="assistant",
                    content=compaction_rehydration,
                    metadata={
                        "ephemeral_context": {
                            "kind": "compaction_rehydration",
                            "source": "provider_transcript_projection",
                        }
                    },
                )
            )
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
    ) -> tuple[ProviderRuntimeItemShape, ...]:
        if self._uses_transcript_only_messages(config):
            return self._transcript_provider_runtime_items(contract)
        if self._uses_responses_delta_input(config):
            return self._responses_provider_runtime_items(contract)

        stable_context = self._render_context_by_cache_class(
            contract,
            cache_classes={"static"},
        )
        dynamic_context = self._render_context_by_cache_class(
            contract,
            cache_classes={"dynamic"},
        )
        ephemeral_context = self._render_non_reminder_context_by_cache_class(
            contract,
            cache_classes={"ephemeral"},
        )

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
        if stable_context:
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=stable_context),),
                    metadata={
                        "cache_class": "static",
                        "source": "provider_context_projection",
                    },
                )
            )
        for message in self._chat_completions_replay_messages(contract):
            blocks = self._messages.runtime_blocks_from_message(message)
            if blocks:
                items.append(ProviderRuntimeItemShape(role=message.role, blocks=blocks))
        items = self._with_chat_post_tool_context_items(items)
        if dynamic_context:
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=dynamic_context),),
                    metadata={
                        "cache_class": "dynamic",
                        "source": "provider_context_projection",
                    },
                )
            )
        if ephemeral_context:
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=ephemeral_context),),
                    metadata={
                        "cache_class": "ephemeral",
                        "source": "provider_context_projection",
                    },
                )
        )
        if intent_content and not self._replay_contains_current_user_request(contract):
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=intent_content),),
                )
            )
        return tuple(items)

    def _provider_projection(
        self,
        *,
        config: AgentConfig,
        fragments: tuple[RequestFragment, ...],
        provider_messages: tuple[ProviderMessageShape, ...],
        provider_runtime_items: tuple[ProviderRuntimeItemShape, ...],
    ) -> ProviderProjectionShape:
        lane = self._provider_projection_lane(config)
        first_dynamic_index = self._first_fragment_index_for_cache_class(
            fragments=fragments,
            cache_class="dynamic",
        )
        first_ephemeral_index = self._first_fragment_index_for_cache_class(
            fragments=fragments,
            cache_class="ephemeral",
        )
        return ProviderProjectionShape(
            lane=lane,
            message_count=len(provider_messages),
            runtime_item_count=len(provider_runtime_items),
            cacheable_prefix_fragment_count=sum(
                1
                for fragment in fragments
                if fragment.stability is FragmentStability.STABLE
            ),
            first_dynamic_fragment_index=first_dynamic_index,
            first_ephemeral_fragment_index=first_ephemeral_index,
            cache_hint=self._provider_cache_hint(lane),
            wire_only_hints=self._provider_wire_only_hints(lane),
        )

    def _provider_projection_lane(self, config: AgentConfig) -> ProviderProjectionLane:
        protocol = str(config.protocol)
        if protocol == "responses":
            return ProviderProjectionLane.RESPONSES
        if protocol == "anthropic_messages":
            return ProviderProjectionLane.ANTHROPIC_MESSAGES
        return ProviderProjectionLane.CHAT_COMPLETIONS

    def _first_fragment_index_for_cache_class(
        self,
        *,
        fragments: tuple[RequestFragment, ...],
        cache_class: str,
    ) -> int | None:
        for index, fragment in enumerate(fragments):
            if fragment.metadata.get("cache_class") == cache_class:
                return index
        return None

    def _provider_cache_hint(self, lane: ProviderProjectionLane) -> str | None:
        if lane is ProviderProjectionLane.RESPONSES:
            return "prompt_cache_key_candidate"
        if lane is ProviderProjectionLane.ANTHROPIC_MESSAGES:
            return "cache_control_breakpoint_candidates"
        if lane is ProviderProjectionLane.CHAT_COMPLETIONS:
            return "stable_transcript_prefix"
        return None

    def _provider_wire_only_hints(
        self,
        lane: ProviderProjectionLane,
    ) -> tuple[str, ...]:
        if lane is ProviderProjectionLane.RESPONSES:
            return ("prompt_cache_key",)
        if lane is ProviderProjectionLane.ANTHROPIC_MESSAGES:
            return ("cache_control",)
        return ()

    def _responses_provider_runtime_items(
        self,
        contract: InstructionContract,
    ) -> tuple[ProviderRuntimeItemShape, ...]:
        static_context = self._render_responses_delta_context(
            contract,
            cache_classes={"static"},
        )
        dynamic_context = self._render_responses_delta_context(
            contract,
            cache_classes={"dynamic"},
        )
        ephemeral_context = self._render_responses_non_reminder_delta_context(contract)
        items: list[ProviderRuntimeItemShape] = []
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
        if static_context:
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=static_context),),
                    metadata={
                        "cache_class": "static",
                        "source": "provider_context_projection",
                    },
                )
            )
        replay_before_current, replayed_current_user, replay_after_current = (
            self._split_replayed_current_user_turn(contract)
        )
        for message in replay_before_current:
            blocks = self._messages.runtime_blocks_from_message(message)
            if blocks:
                items.append(ProviderRuntimeItemShape(role=message.role, blocks=blocks))
        if dynamic_context:
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=dynamic_context),),
                    metadata={
                        "cache_class": "dynamic",
                        "source": "provider_context_projection",
                    },
                )
            )
        if ephemeral_context:
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=ephemeral_context),),
                    metadata={
                        "cache_class": "ephemeral",
                        "source": "provider_context_projection",
                    },
                )
            )
        if replayed_current_user is not None:
            blocks = self._messages.runtime_blocks_from_message(replayed_current_user)
            if blocks:
                items.append(
                    ProviderRuntimeItemShape(
                        role="user",
                        blocks=blocks,
                    )
                )
        elif contract.current_user_request and not self._replay_contains_current_user_request(
            contract
        ):
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=contract.current_user_request),),
                )
            )
        for message in replay_after_current:
            blocks = self._messages.runtime_blocks_from_message(message)
            if blocks:
                items.append(ProviderRuntimeItemShape(role=message.role, blocks=blocks))
        items = self._with_chat_post_tool_context_items(items)
        return tuple(items)

    def _transcript_provider_runtime_items(
        self,
        contract: InstructionContract,
    ) -> tuple[ProviderRuntimeItemShape, ...]:
        items: list[ProviderRuntimeItemShape] = [
            ProviderRuntimeItemShape(
                role="system",
                blocks=(
                    RuntimeBlock(
                        type="text",
                        text=self._transcript_stable_system_content(contract),
                    ),
                ),
            )
        ]
        dynamic_context = self._transcript_dynamic_context(contract)
        if dynamic_context:
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=dynamic_context),),
                    metadata={
                        "cache_class": "dynamic",
                        "source": "provider_transcript_projection",
                    },
                )
            )
        for message in self._chat_completions_replay_messages(contract):
            blocks = self._messages.runtime_blocks_from_message(message)
            if blocks:
                items.append(ProviderRuntimeItemShape(role=message.role, blocks=blocks))
        items = self._with_chat_post_tool_context_items(items)
        ephemeral_context = self._transcript_ephemeral_context(contract)
        if ephemeral_context:
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text=ephemeral_context),),
                    metadata={
                        "cache_class": "ephemeral",
                        "source": "provider_transcript_projection",
                    },
                )
            )
        compaction_rehydration = self._transcript_compaction_rehydration_context(contract)
        if compaction_rehydration:
            items.append(
                ProviderRuntimeItemShape(
                    role="assistant",
                    blocks=(
                        RuntimeBlock(
                            type="text",
                            text=compaction_rehydration,
                            metadata={
                                "ephemeral_context": {
                                    "kind": "compaction_rehydration",
                                    "source": "provider_transcript_projection",
                                }
                            },
                        ),
                    ),
                )
            )
        if contract.current_user_request and not self._replay_contains_current_user_request(
            contract
        ):
            items.append(
                ProviderRuntimeItemShape(
                    role="user",
                    blocks=(
                        RuntimeBlock(
                            type="text",
                            text=contract.current_user_request,
                        ),
                    ),
                )
            )
        return tuple(items)

    def _replay_messages(self, contract: InstructionContract) -> tuple[Message, ...]:
        return contract.conversation_messages

    def _chat_completions_replay_messages(
        self,
        contract: InstructionContract,
    ) -> tuple[Message, ...]:
        filtered: list[Message] = []
        pending_assistant: Message | None = None
        pending_tool_call_ids: set[str] = set()
        pending_tool_messages: list[Message] = []
        deferred_messages: list[Message] = []

        def flush_pending() -> None:
            nonlocal pending_assistant, pending_tool_call_ids
            nonlocal pending_tool_messages, deferred_messages
            if pending_assistant is None:
                return
            if not pending_tool_call_ids:
                filtered.append(pending_assistant)
                filtered.extend(pending_tool_messages)
            filtered.extend(deferred_messages)
            pending_assistant = None
            pending_tool_call_ids = set()
            pending_tool_messages = []
            deferred_messages = []

        def discard_pending_keep_deferred() -> None:
            nonlocal pending_assistant, pending_tool_call_ids
            nonlocal pending_tool_messages, deferred_messages
            filtered.extend(deferred_messages)
            pending_assistant = None
            pending_tool_call_ids = set()
            pending_tool_messages = []
            deferred_messages = []

        for message in self._replay_messages(contract):
            if pending_assistant is not None:
                if message.role == "tool":
                    if message.tool_call_id and message.tool_call_id in pending_tool_call_ids:
                        pending_tool_messages.append(message)
                        pending_tool_call_ids.remove(message.tool_call_id)
                        flush_pending()
                    continue
                if message.role == "assistant":
                    tool_call_ids = self._chat_tool_call_ids(message)
                    if tool_call_ids and tool_call_ids == pending_tool_call_ids:
                        continue
                    discard_pending_keep_deferred()
                    if tool_call_ids:
                        pending_assistant = message
                        pending_tool_call_ids = tool_call_ids
                    else:
                        filtered.append(message)
                    continue
                deferred_messages.append(message)
                continue
            if message.role == "tool":
                continue
            if message.role == "assistant":
                tool_call_ids = self._chat_tool_call_ids(message)
                if tool_call_ids:
                    pending_assistant = message
                    pending_tool_call_ids = tool_call_ids
                else:
                    filtered.append(message)
                continue
            filtered.append(message)
        discard_pending_keep_deferred()
        return tuple(filtered)

    def _chat_tool_call_ids(self, message: Message) -> set[str]:
        return {
            call.call_id
            for call in self._messages.tool_calls_from_message(message)
            if call.call_id
        }

    def _replay_contains_current_user_request(
        self,
        contract: InstructionContract,
    ) -> bool:
        return any(
            message.role == "user"
            and message.content == contract.current_user_request
            for message in contract.conversation_messages
        )

    def _split_replayed_current_user_turn(
        self,
        contract: InstructionContract,
    ) -> tuple[tuple[Message, ...], Message | None, tuple[Message, ...]]:
        messages = tuple(contract.conversation_messages)
        if not messages:
            return (), None, ()
        for index in range(len(messages) - 1, -1, -1):
            message = messages[index]
            if (
                message.role == "user"
                and message.content == contract.current_user_request
            ):
                return messages[:index], message, messages[index + 1 :]
        return messages, None, ()

    def _stable_system_for_shape(
        self,
        config: AgentConfig,
        contract: InstructionContract,
    ) -> str:
        if self._uses_transcript_only_messages(config):
            return self._transcript_stable_system_content(contract)
        return contract.base_instructions

    def _transcript_stable_system_content(
        self,
        contract: InstructionContract,
    ) -> str:
        developer_content = self._join_content(
            self._developer_section_content(section)
            for section in contract.developer_sections
        )
        return self._join_content(
            (
                contract.base_instructions,
                developer_content,
                self._render_transcript_system_context(contract),
            )
        )

    def _render_transcript_system_context(
        self,
        contract: InstructionContract,
    ) -> str:
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in self._provider_visible_contextual_sections(contract)
            if self._transcript_system_section_is_model_visible(section)
        )

    def _transcript_system_section_is_model_visible(
        self,
        section: InstructionFragment,
    ) -> bool:
        if self._cache_class(section) != "static":
            return False
        return str(section.kind) in {
            "skill_catalog",
            "workspace_instructions",
        }

    def _transcript_dynamic_context(
        self,
        contract: InstructionContract,
    ) -> str:
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in self._provider_visible_contextual_sections(contract)
            if self._cache_class(section) == "dynamic"
            if str(section.kind) != "compaction_rehydration"
            if self._transcript_dynamic_section_is_model_visible(section)
        )

    def _transcript_dynamic_section_is_model_visible(
        self,
        section: InstructionFragment,
    ) -> bool:
        return str(section.kind) in {
            "environment_context",
            "memory",
            "plan",
        }

    def _transcript_ephemeral_context(
        self,
        contract: InstructionContract,
    ) -> str:
        if self._post_tool_additional_context(contract):
            return ""
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in self._provider_visible_contextual_sections(contract)
            if self._cache_class(section) == "ephemeral"
            if str(section.kind) != "runtime_reminders"
            if self._transcript_contextual_section_is_model_visible(section)
        )

    def _runtime_reminders_context(self, contract: InstructionContract) -> str:
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in self._provider_visible_contextual_sections(contract)
            if self._cache_class(section) == "ephemeral"
            if str(section.kind) == "runtime_reminders"
        )

    def _runtime_reminders_context_metadata(self) -> dict[str, object]:
        return {
            "ephemeral_context": {
                "kind": "runtime_reminders",
                "source": "provider_transcript_projection",
            },
            "cache_class": "ephemeral",
        }

    def _post_tool_additional_context(self, contract: InstructionContract) -> str:
        return self._join_content(
            context
            for message in self._chat_completions_replay_messages(contract)
            for context in self._post_tool_additional_contexts_from_message(message)
        )

    def _post_tool_context_metadata(self) -> dict[str, object]:
        return {
            "ephemeral_context": {
                "kind": "post_tool_context",
                "source": "post_tool_use_hook",
            },
            "cache_class": "ephemeral",
        }

    def _with_chat_post_tool_context_messages(
        self,
        messages: list[ProviderMessageShape],
    ) -> list[ProviderMessageShape]:
        for index in range(len(messages) - 1, -1, -1):
            message = messages[index]
            if message.role != "tool":
                continue
            post_tool_context = self._post_tool_additional_contexts_from_provider_metadata(
                message.metadata
            )
            if not post_tool_context:
                continue
            metadata = dict(message.metadata)
            metadata["tool_runtime_reminder"] = True
            messages[index] = ProviderMessageShape(
                role=message.role,
                content=self._append_tool_runtime_reminder(
                    message.content,
                    self._join_content(post_tool_context),
                ),
                metadata=metadata,
            )
            return messages
        return messages

    def _with_chat_post_tool_context_items(
        self,
        items: list[ProviderRuntimeItemShape],
    ) -> list[ProviderRuntimeItemShape]:
        for item_index in range(len(items) - 1, -1, -1):
            item = items[item_index]
            if item.role != "tool":
                continue
            for block_index in range(len(item.blocks) - 1, -1, -1):
                block = item.blocks[block_index]
                if block.type != "tool_result":
                    continue
                post_tool_context = self._post_tool_additional_contexts_from_provider_metadata(
                    block.metadata
                )
                if not post_tool_context:
                    continue
                blocks = list(item.blocks)
                blocks[block_index] = RuntimeBlock(
                    type=block.type,
                    text=self._append_tool_runtime_reminder(
                        block.text or "",
                        self._join_content(post_tool_context),
                    ),
                    tool_name=block.tool_name,
                    tool_arguments=block.tool_arguments,
                    call_id=block.call_id,
                    provider_id=block.provider_id,
                    source=block.source,
                    metadata=block.metadata,
                )
                item_metadata = dict(item.metadata)
                item_metadata["tool_runtime_reminder"] = True
                items[item_index] = ProviderRuntimeItemShape(
                    role=item.role,
                    blocks=tuple(blocks),
                    metadata=item_metadata,
                )
                return items
        return items

    def _post_tool_additional_contexts_from_message(
        self,
        message: Message,
    ) -> tuple[str, ...]:
        contexts = self._post_tool_additional_contexts_from_provider_metadata(
            message.metadata
        )
        if contexts:
            return contexts
        for block in message.blocks:
            contexts = self._post_tool_additional_contexts_from_provider_metadata(
                block.metadata
            )
            if contexts:
                return contexts
        return ()

    def _post_tool_additional_contexts_from_provider_metadata(
        self,
        metadata: dict[str, Any],
    ) -> tuple[str, ...]:
        value = metadata.get(POST_TOOL_ADDITIONAL_CONTEXTS_METADATA_KEY)
        if isinstance(value, str):
            return (value,) if value.strip() else ()
        if isinstance(value, tuple):
            return tuple(item for item in value if isinstance(item, str) and item.strip())
        if isinstance(value, list):
            return tuple(item for item in value if isinstance(item, str) and item.strip())
        model_metadata = metadata.get("model_metadata")
        if isinstance(model_metadata, dict):
            nested = model_metadata.get(POST_TOOL_ADDITIONAL_CONTEXTS_METADATA_KEY)
            if isinstance(nested, tuple):
                return tuple(item for item in nested if isinstance(item, str) and item.strip())
            if isinstance(nested, list):
                return tuple(item for item in nested if isinstance(item, str) and item.strip())
            if isinstance(nested, str) and nested.strip():
                return (nested,)
        return ()

    def _append_tool_runtime_reminder(self, output: str, reminder: str) -> str:
        reminder_block = "\n".join(
            (
                f"<{TOOL_RUNTIME_REMINDER_TAG}>",
                reminder,
                f"</{TOOL_RUNTIME_REMINDER_TAG}>",
            )
        )
        if not output:
            return reminder_block
        return f"{output.rstrip()}\n\n{reminder_block}"

    def _transcript_compaction_rehydration_context(
        self,
        contract: InstructionContract,
    ) -> str:
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in self._provider_visible_contextual_sections(contract)
            if str(section.kind) == "compaction_rehydration"
        )

    def _render_context_by_cache_class(
        self,
        contract: InstructionContract,
        *,
        cache_classes: set[str],
    ) -> str:
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in self._provider_visible_contextual_sections(contract)
            if self._cache_class(section) in cache_classes
        )

    def _render_non_reminder_context_by_cache_class(
        self,
        contract: InstructionContract,
        *,
        cache_classes: set[str],
    ) -> str:
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in self._provider_visible_contextual_sections(contract)
            if self._cache_class(section) in cache_classes
            if str(section.kind) != "runtime_reminders"
        )

    def _developer_section_content(self, section: InstructionFragment) -> str:
        if str(section.kind) != "tool_exposure":
            return section.content.strip()
        return (
            "Use the tool schema attached to this request as the authoritative, "
            "equal toolset. Tool execution safety is enforced by the runtime."
        )

    def _render_responses_delta_context(
        self,
        contract: InstructionContract,
        *,
        cache_classes: set[str],
    ) -> str:
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in self._provider_visible_contextual_sections(contract)
            if self._cache_class(section) in cache_classes
            if self._responses_contextual_section_is_model_visible(section)
        )

    def _render_responses_non_reminder_delta_context(
        self,
        contract: InstructionContract,
    ) -> str:
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in self._provider_visible_contextual_sections(contract)
            if self._cache_class(section) == "ephemeral"
            if str(section.kind) != "runtime_reminders"
            if self._responses_contextual_section_is_model_visible(section)
        )

    def _render_transcript_delta_context(
        self,
        contract: InstructionContract,
        *,
        cache_classes: set[str],
    ) -> str:
        return self._join_content(
            self._contextual_section_content(section, contract)
            for section in self._provider_visible_contextual_sections(contract)
            if self._cache_class(section) in cache_classes
            if self._transcript_contextual_section_is_model_visible(section)
        )

    def _responses_contextual_section_is_model_visible(
        self,
        section: InstructionFragment,
    ) -> bool:
        return str(section.kind) in {
            "compaction_rehydration",
            "environment_context",
            "hook_context",
            "memory",
            "plan",
            "skill_catalog",
            "workspace_instructions",
        }

    def _transcript_contextual_section_is_model_visible(
        self,
        section: InstructionFragment,
    ) -> bool:
        return self._responses_contextual_section_is_model_visible(section)

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
            cache_class = self._cache_class(section)
            base_id, kind = self._fragment_identity(
                str(section.kind),
                cache_class=cache_class,
            )
            index = seen.get(base_id, 0)
            seen[base_id] = index + 1
            fragment_id = base_id if index == 0 else f"{base_id}:{index + 1}"
            stability = self._fragment_stability(cache_class)
            fragments.append(
                RequestFragment(
                    id=fragment_id,
                    kind=kind,
                    content=content,
                    stability=stability,
                    metadata=self._fragment_metadata(
                        section=section,
                        cache_class=cache_class,
                        content=content,
                    ),
                )
            )
        return tuple(fragments)

    def _fragment_metadata(
        self,
        *,
        section: InstructionFragment,
        cache_class: str,
        content: str,
    ) -> dict[str, object]:
        section_metadata = dict(section.metadata)
        provider_state = section_metadata.pop("provider_state", None)
        metadata: dict[str, object] = {
            "title": section.title,
            "source": section.source,
            "cache_class": cache_class,
            "instruction_fragment_kind": str(section.kind),
            "section_hash": stable_hash(content),
            **section_metadata,
        }
        durability = str(metadata.get("durability", "persistent"))
        scope = str(metadata.get("scope", "turn"))
        metadata.setdefault("model_visible", durability != "api_only")
        metadata.setdefault(
            "replayable",
            durability == "persistent" and scope == "transcript",
        )
        if isinstance(provider_state, dict) and provider_state:
            metadata["provider_state_keys"] = tuple(sorted(provider_state))
        return metadata

    def _stable_contextual_fragments(
        self,
        fragments: tuple[RequestFragment, ...],
    ) -> tuple[RequestFragment, ...]:
        return tuple(
            fragment for fragment in fragments if fragment.stability is FragmentStability.STABLE
        )

    def _dynamic_contextual_fragments(
        self,
        fragments: tuple[RequestFragment, ...],
    ) -> tuple[RequestFragment, ...]:
        return tuple(
            fragment for fragment in fragments if fragment.stability is FragmentStability.REPLAY
        )

    def _ephemeral_contextual_fragments(
        self,
        fragments: tuple[RequestFragment, ...],
    ) -> tuple[RequestFragment, ...]:
        return tuple(
            fragment for fragment in fragments if fragment.stability is FragmentStability.VOLATILE
        )

    def _provider_visible_contextual_sections(
        self,
        contract: InstructionContract,
    ) -> tuple[InstructionFragment, ...]:
        return tuple(
            sorted(
                contract.contextual_user_sections,
                key=lambda section: (
                    self._cache_class_order(self._cache_class(section)),
                    self._section_kind_order(str(section.kind)),
                ),
            )
        )

    def _cache_class(self, section: InstructionFragment) -> str:
        value = section.metadata.get("cache_class")
        if value in {"static", "dynamic", "ephemeral"}:
            return str(value)
        section_kind = str(section.kind)
        if section_kind in {"tool_exposure", "workspace_instructions", "skill_catalog"}:
            return "static"
        if section_kind in {"hook_context", "runtime_reminders", "user_request"}:
            return "ephemeral"
        return "dynamic"

    def _cache_class_order(self, cache_class: str) -> int:
        return {"static": 0, "dynamic": 1, "ephemeral": 2}.get(cache_class, 1)

    def _section_kind_order(self, section_kind: str) -> int:
        order = {
            "tool_exposure": 0,
            "workspace_instructions": 1,
            "skill_catalog": 2,
            "environment_context": 10,
            "conversation_context": 11,
            "compaction_rehydration": 12,
            "memory": 13,
            "plan": 14,
            "hook_context": 19,
            "runtime_reminders": 20,
            "user_request": 21,
        }
        return order.get(section_kind, 50)

    def _fragment_stability(self, cache_class: str) -> FragmentStability:
        if cache_class == "static":
            return FragmentStability.STABLE
        if cache_class == "dynamic":
            return FragmentStability.REPLAY
        return FragmentStability.VOLATILE

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
        *,
        cache_class: str = "dynamic",
    ) -> tuple[str, RequestFragmentKind]:
        normalized = section_kind.strip().lower().replace(" ", "_")
        if normalized == "memory":
            return "replay:retrieved_memory", RequestFragmentKind.RETRIEVED_MEMORY
        if normalized == "tool_exposure":
            return "stable:tool_exposure", RequestFragmentKind.STABLE
        if normalized in {"workspace_instructions", "skill_catalog"}:
            return f"stable:{normalized}", RequestFragmentKind.STABLE
        prefix = "volatile" if cache_class == "ephemeral" else "replay"
        return f"{prefix}:{normalized}", RequestFragmentKind.VOLATILE

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

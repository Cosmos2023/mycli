from __future__ import annotations

from dataclasses import replace
from typing import cast

from mycli.domain.providers import ProtocolId
from mycli.domain.runtime import AgentConfig
from mycli.infrastructure.providers import chat_adapter_for_provider
from mycli.llms.adapters.anthropic_messages_adapter import AnthropicMessagesModelAdapter
from mycli.llms.adapters.base import ModelAdapter
from mycli.llms.adapters.native_tool_adapter import NativeToolModelAdapter
from mycli.llms.adapters.responses_adapter import ResponsesModelAdapter
from mycli.llms.clients.anthropic_messages import AnthropicMessagesClient
from mycli.llms.clients.openai_chat import OpenAIChatClient
from mycli.llms.clients.openai_responses import OpenAIResponsesClient
from mycli.schemas.responses_protocol import ResponsesCapabilityProfile
from mycli.utils.workspace_logger import WorkspaceLogService


def build_model_adapter(
    config: AgentConfig,
    *,
    log_service: WorkspaceLogService,
) -> ModelAdapter:
    if not config.api_key:
        raise ValueError(f"No API key configured for provider '{config.provider.value}'.")
    if config.protocol is ProtocolId.ANTHROPIC_MESSAGES:
        anthropic_client = AnthropicMessagesClient(
            api_key=config.api_key,
            base_url=config.api_base_url,
            model=config.model,
            log_service=log_service,
            request_max_retries=config.request_max_retries,
        )
        return cast(ModelAdapter, AnthropicMessagesModelAdapter(client=anthropic_client))
    if config.protocol is ProtocolId.CHAT_COMPLETIONS:
        provider_adapter = chat_adapter_for_provider(config.provider)
        chat_client = OpenAIChatClient(
            api_key=config.api_key,
            base_url=config.api_base_url,
            model=config.model,
            log_service=log_service,
            provider_adapter=provider_adapter,
            request_max_retries=config.request_max_retries,
        )
        return cast(
            ModelAdapter,
            NativeToolModelAdapter(client=chat_client, provider_adapter=provider_adapter),
        )
    responses_profile = replace(
        ResponsesCapabilityProfile.for_provider(
            provider=config.provider,
            base_url=config.api_base_url,
        ),
        stream_max_retries=0,
        supports_stream_fallback_to_create=False,
    )
    responses_client = OpenAIResponsesClient(
        api_key=config.api_key,
        base_url=config.api_base_url,
        model=config.model,
        capability_profile=responses_profile,
        log_service=log_service,
        request_max_retries=config.request_max_retries,
    )
    return cast(
        ModelAdapter,
        ResponsesModelAdapter(client=responses_client, log_service=log_service),
    )


__all__ = ["build_model_adapter"]

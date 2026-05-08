from mycli.llms.adapters.base import (
    BlockType,
    ModelAction,
    ModelAdapter,
    ModelMessage,
    ModelToolDefinition,
    ModelToolParameter,
    ModelTurnResult,
    RuntimeBlock,
    RuntimeItem,
    RuntimeRole,
)
from mycli.llms.adapters.anthropic_messages_adapter import (
    AnthropicMessagesModelAdapter,
)
from mycli.llms.adapters.compat_chat_adapter import (
    CompatChatModelAdapter as LegacyCompatChatModelAdapter,
)
from mycli.llms.adapters.native_tool_adapter import (
    NativeToolModelAdapter as LegacyNativeToolModelAdapter,
)

# Backward-compatible names for legacy fallback adapters.
CompatChatModelAdapter = LegacyCompatChatModelAdapter
NativeToolModelAdapter = LegacyNativeToolModelAdapter

__all__ = [
    "BlockType",
    "AnthropicMessagesModelAdapter",
    # Legacy fallback surfaces. Prefer the Responses adapter for new integrations.
    "LegacyCompatChatModelAdapter",
    "LegacyNativeToolModelAdapter",
    # Backward-compatible legacy names.
    "CompatChatModelAdapter",
    "ModelAction",
    "ModelAdapter",
    "ModelMessage",
    "ModelToolDefinition",
    "ModelToolParameter",
    "ModelTurnResult",
    "NativeToolModelAdapter",
    "RuntimeBlock",
    "RuntimeItem",
    "RuntimeRole",
]

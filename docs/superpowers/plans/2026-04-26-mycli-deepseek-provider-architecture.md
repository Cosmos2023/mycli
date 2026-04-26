# MyCLI DeepSeek Provider Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DeepSeek a first-class `mycli` provider with a formal `chat_completions` protocol, provider-owned request/message adaptation, and full DeepSeek thinking tool-loop support through `reasoning_content` preservation.

**Architecture:** Add a small provider/profile layer that resolves `provider` and `protocol` before runtime construction, then move provider-specific chat-completions behavior into infrastructure provider adapters. Keep the internal runtime protocol provider-agnostic by carrying DeepSeek-only `reasoning_content` inside block/message metadata, not as user-visible assistant text. Continue reusing the OpenAI-compatible chat transport for DeepSeek, but stop embedding DeepSeek checks directly in `OpenAIChatClient`.

**Tech Stack:** Python 3.13, standard library `dataclasses`, `enum`, `urllib.parse`, existing OpenAI SDK wrapper, `pytest`, `ruff`, `mypy`

---

## Scope Check

This is one subsystem plan: provider-aware chat-completions support. It touches config resolution, chat request/message adaptation, chat response metadata preservation, runtime transcript metadata, tests, and docs. It does not add Anthropic transport, MCP support, or a new SDK abstraction beyond the minimal provider adapter hooks needed for DeepSeek.

## File Structure

- Create: `src/mycli/domain/providers.py`
  Responsibility: define `ProviderId`, `ProtocolId`, provider profiles, provider inference from base URL, and provider/protocol validation helpers.
- Modify: `src/mycli/domain/runtime/__init__.py`
  Responsibility: add typed `provider` and `protocol` fields to `AgentConfig`.
- Modify: `src/mycli/services/config_service.py`
  Responsibility: parse `provider`, infer it from `api_base_url`, normalize protocol names, reject unsupported provider/protocol combinations, and remove `legacy_chat` as a supported protocol.
- Create: `src/mycli/infrastructure/providers/__init__.py`
  Responsibility: export provider adapter types and factory helpers.
- Create: `src/mycli/infrastructure/providers/chat.py`
  Responsibility: define the provider adapter protocol and no-op default adapter for OpenAI-compatible chat providers.
- Create: `src/mycli/infrastructure/providers/deepseek.py`
  Responsibility: implement DeepSeek chat-completions request adaptation, role adaptation, response metadata extraction, and `reasoning_content` replay.
- Modify: `src/mycli/infrastructure/openai_client.py`
  Responsibility: accept a chat provider adapter, delegate provider-specific request/message/response behavior, log protocol as `chat_completions`, and remove inline DeepSeek base-url checks.
- Modify: `src/mycli/infrastructure/models/base.py`
  Responsibility: allow `ModelMessage` to carry metadata needed for provider-state replay.
- Modify: `src/mycli/infrastructure/models/turn_event_aggregator.py`
  Responsibility: preserve event metadata on runtime blocks so provider adapters can replay provider-private state.
- Modify: `src/mycli/infrastructure/models/native_tool_adapter.py`
  Responsibility: rename legacy framing in docs/comments, serialize message metadata through the provider-aware client path, and stop hardcoding `developer -> system`.
- Modify: `src/mycli/application/runtime/agent_runtime.py`
  Responsibility: preserve provider metadata when recording assistant tool-call blocks into conversation history and when turning conversation history back into model messages.
- Modify: `src/mycli/application/turn_service.py`
  Responsibility: ensure persisted session history keeps provider metadata across tool-loop turns.
- Modify: `src/mycli/cli/main.py`
  Responsibility: select transports using `ProtocolId.CHAT_COMPLETIONS` / `ProtocolId.RESPONSES`, construct the correct provider chat adapter, and remove `legacy_chat`.
- Modify: `src/mycli/infrastructure/openai_responses_client.py`
  Responsibility: use provider/profile labels in logs and unsupported-protocol messaging when applicable.
- Modify: `README.md`
  Responsibility: document `provider`, `protocol = "chat_completions"`, DeepSeek examples, thinking mode, and `reasoning_content` behavior.
- Modify: `tests/unit/services/test_config_service.py`
  Responsibility: verify provider inference, defaults, protocol validation, and DeepSeek unsupported combinations.
- Modify: `tests/unit/infrastructure/test_openai_client.py`
  Responsibility: verify provider adapter integration, DeepSeek request adaptation, and `reasoning_content` extraction.
- Modify: `tests/unit/infrastructure/models/test_turn_event_aggregator.py`
  Responsibility: verify provider metadata survives event aggregation.
- Modify: `tests/unit/infrastructure/models/test_native_tool_adapter.py`
  Responsibility: verify provider-aware role/message adaptation replaces hardcoded legacy behavior.
- Create: `tests/unit/application/test_agent_runtime_provider_metadata.py`
  Responsibility: verify assistant tool-call metadata is replayed into the next model message.
- Modify: `tests/integration/test_cli_repl.py`
  Responsibility: verify DeepSeek resolves to the chat-completions runtime path.

## Task 1: Formalize Provider and Protocol Resolution

**Files:**
- Create: `src/mycli/domain/providers.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/services/config_service.py`
- Test: `tests/unit/services/test_config_service.py`

- [ ] **Step 1: Write failing provider config tests**

Add these tests to `tests/unit/services/test_config_service.py`:

```python
from pathlib import Path

import pytest

from mycli.domain.providers import ProtocolId, ProviderId
from mycli.services.config_service import resolve_config


def test_resolve_config_infers_deepseek_provider_and_defaults_to_chat_completions(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_BASE_URL": "https://api.deepseek.com",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.DEEPSEEK
    assert config.protocol is ProtocolId.CHAT_COMPLETIONS
    assert config.api_base_url == "https://api.deepseek.com"


def test_resolve_config_prefers_explicit_provider_over_base_url_inference(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "openai",
            "MYCLI_BASE_URL": "https://api.deepseek.com",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.OPENAI
    assert config.protocol is ProtocolId.RESPONSES


def test_resolve_config_accepts_chat_completions_protocol(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROTOCOL": "chat_completions",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.protocol is ProtocolId.CHAT_COMPLETIONS


def test_resolve_config_rejects_legacy_chat_protocol(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(ValueError, match="Use 'chat_completions' instead"):
        resolve_config(
            cli_args={"session": "demo"},
            env={
                "MYCLI_API_KEY": "test-key",
                "MYCLI_PROTOCOL": "legacy_chat",
            },
            cwd=workspace,
            home=home_dir,
        )


def test_resolve_config_rejects_deepseek_with_responses_protocol(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(
        ValueError,
        match="Provider 'deepseek' does not support protocol 'responses'",
    ):
        resolve_config(
            cli_args={"session": "demo"},
            env={
                "MYCLI_API_KEY": "test-key",
                "MYCLI_PROVIDER": "deepseek",
                "MYCLI_PROTOCOL": "responses",
            },
            cwd=workspace,
            home=home_dir,
        )
```

- [ ] **Step 2: Run the provider config tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py -v
```

Expected: fail because `mycli.domain.providers` does not exist and `legacy_chat` is still accepted.

- [ ] **Step 3: Create the provider domain model**

Create `src/mycli/domain/providers.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from urllib.parse import urlparse


class ProviderId(StrEnum):
    OPENAI = "openai"
    DEEPSEEK = "deepseek"
    COMPATIBLE = "compatible"


class ProtocolId(StrEnum):
    RESPONSES = "responses"
    CHAT_COMPLETIONS = "chat_completions"


@dataclass(slots=True, frozen=True)
class ProviderProfile:
    provider: ProviderId
    default_protocol: ProtocolId
    supports_responses: bool
    supports_chat_completions: bool
    default_base_url: str
    default_model: str | None = None
    unsupported_responses_hint: str | None = None


def infer_provider_from_base_url(base_url: str) -> ProviderId:
    hostname = urlparse(base_url).hostname or ""
    normalized = hostname.lower()
    if normalized == "api.deepseek.com" or normalized.endswith(".deepseek.com"):
        return ProviderId.DEEPSEEK
    if normalized == "api.openai.com" or normalized.endswith(".openai.com"):
        return ProviderId.OPENAI
    return ProviderId.COMPATIBLE


def profile_for_provider(provider: ProviderId) -> ProviderProfile:
    if provider is ProviderId.DEEPSEEK:
        return ProviderProfile(
            provider=ProviderId.DEEPSEEK,
            default_protocol=ProtocolId.CHAT_COMPLETIONS,
            supports_responses=False,
            supports_chat_completions=True,
            default_base_url="https://api.deepseek.com",
            default_model="deepseek-chat",
            unsupported_responses_hint="Use protocol='chat_completions' for DeepSeek.",
        )
    if provider is ProviderId.OPENAI:
        return ProviderProfile(
            provider=ProviderId.OPENAI,
            default_protocol=ProtocolId.RESPONSES,
            supports_responses=True,
            supports_chat_completions=True,
            default_base_url="https://api.openai.com/v1",
            default_model="gpt-5",
        )
    return ProviderProfile(
        provider=ProviderId.COMPATIBLE,
        default_protocol=ProtocolId.CHAT_COMPLETIONS,
        supports_responses=True,
        supports_chat_completions=True,
        default_base_url="https://api.openai.com/v1",
        default_model=None,
    )


def parse_provider(value: object) -> ProviderId:
    try:
        return ProviderId(str(value))
    except ValueError as exc:
        allowed = ", ".join(item.value for item in ProviderId)
        raise ValueError(
            f"Unsupported provider '{value}'. Supported values: {allowed}."
        ) from exc


def parse_protocol(value: object) -> ProtocolId:
    raw = str(value)
    if raw == "legacy_chat":
        raise ValueError(
            "Unsupported protocol 'legacy_chat'. Use 'chat_completions' instead."
        )
    try:
        return ProtocolId(raw)
    except ValueError as exc:
        allowed = ", ".join(item.value for item in ProtocolId)
        raise ValueError(
            f"Unsupported protocol '{value}'. Supported values: {allowed}."
        ) from exc


def validate_provider_protocol(
    *,
    provider: ProviderId,
    protocol: ProtocolId,
) -> None:
    profile = profile_for_provider(provider)
    if protocol is ProtocolId.RESPONSES and not profile.supports_responses:
        hint = f" {profile.unsupported_responses_hint}" if profile.unsupported_responses_hint else ""
        raise ValueError(
            f"Provider '{provider.value}' does not support protocol "
            f"'{protocol.value}'.{hint}"
        )
    if protocol is ProtocolId.CHAT_COMPLETIONS and not profile.supports_chat_completions:
        raise ValueError(
            f"Provider '{provider.value}' does not support protocol "
            f"'{protocol.value}'."
        )


__all__ = [
    "ProviderId",
    "ProviderProfile",
    "ProtocolId",
    "infer_provider_from_base_url",
    "parse_provider",
    "parse_protocol",
    "profile_for_provider",
    "validate_provider_protocol",
]
```

- [ ] **Step 4: Add provider and protocol fields to `AgentConfig`**

In `src/mycli/domain/runtime/__init__.py`, import the provider types:

```python
from mycli.domain.providers import ProviderId, ProtocolId
```

Update the `AgentConfig` dataclass so the provider/protocol portion is:

```python
@dataclass(slots=True, frozen=True)
class AgentConfig:
    workspace_root: Path
    provider: ProviderId = ProviderId.OPENAI
    model: str = "gpt-5"
    protocol: ProtocolId = ProtocolId.RESPONSES
    api_base_url: str = "https://api.openai.com/v1"
    api_key: str | None = None
```

Keep all existing fields after `api_key` unchanged.

- [ ] **Step 5: Update config resolution to use provider profiles**

In `src/mycli/services/config_service.py`, replace `_SUPPORTED_PROTOCOLS` and `_validate_protocol()` with imports from `mycli.domain.providers`:

```python
from mycli.domain.providers import (
    ProtocolId,
    infer_provider_from_base_url,
    parse_protocol,
    parse_provider,
    profile_for_provider,
    validate_provider_protocol,
)
```

Inside `resolve_config()`, replace the existing `model`, `protocol`, and `api_base_url` resolution block with:

```python
    raw_api_base_url = (
        env.get("MYCLI_BASE_URL")
        or project_config.get("api_base_url")
        or user_config.get("api_base_url")
        or "https://api.openai.com/v1"
    )
    api_base_url = str(raw_api_base_url).rstrip("/")
    raw_provider = (
        env.get("MYCLI_PROVIDER")
        or project_config.get("provider")
        or user_config.get("provider")
    )
    provider = (
        parse_provider(raw_provider)
        if raw_provider is not None
        else infer_provider_from_base_url(api_base_url)
    )
    profile = profile_for_provider(provider)
    protocol = parse_protocol(
        env.get("MYCLI_PROTOCOL")
        or project_config.get("protocol")
        or user_config.get("protocol")
        or profile.default_protocol.value
    )
    validate_provider_protocol(provider=provider, protocol=protocol)
    model = str(
        cli_args.get("model")
        or env.get("MYCLI_MODEL")
        or project_config.get("model")
        or user_config.get("model")
        or profile.default_model
        or "gpt-5"
    )
```

Update the `AgentConfig(...)` constructor:

```python
        provider=provider,
        model=model,
        protocol=protocol,
        api_base_url=api_base_url,
```

- [ ] **Step 6: Run provider config tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py -v
```

Expected: all config service tests pass.

- [ ] **Step 7: Commit provider config resolution**

Run:

```bash
git add src/mycli/domain/providers.py src/mycli/domain/runtime/__init__.py src/mycli/services/config_service.py tests/unit/services/test_config_service.py
git commit -m "Promote model provider resolution into runtime config" \
  -m "Provider and protocol are now resolved before runtime construction so DeepSeek can default to chat_completions while OpenAI keeps responses as its default." \
  -m "Constraint: legacy_chat is intentionally removed as a supported public protocol name" \
  -m "Rejected: Keep base-url checks in OpenAIChatClient | hides provider behavior in the transport layer" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/unit/services/test_config_service.py -v"
```

## Task 2: Add Chat Provider Adapters

**Files:**
- Create: `src/mycli/infrastructure/providers/__init__.py`
- Create: `src/mycli/infrastructure/providers/chat.py`
- Create: `src/mycli/infrastructure/providers/deepseek.py`
- Modify: `src/mycli/infrastructure/openai_client.py`
- Test: `tests/unit/infrastructure/test_openai_client.py`

- [ ] **Step 1: Write failing provider adapter tests**

Add these tests to `tests/unit/infrastructure/test_openai_client.py`:

```python
from mycli.infrastructure.providers.deepseek import DeepSeekChatProviderAdapter


def test_openai_chat_client_uses_provider_adapter_for_request_body(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        max_output_tokens=2048,
        provider_adapter=DeepSeekChatProviderAdapter(),
    )
    client.set_thinking_config(enabled=False, effort=None)

    client.complete([{"role": "user", "content": "inspect the repo"}])

    assert sdk_client.chat_completions.calls[-1]["extra_body"] == {
        "thinking": {"type": "disabled"}
    }


def test_openai_chat_client_uses_provider_adapter_for_message_roles(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        max_output_tokens=2048,
        provider_adapter=DeepSeekChatProviderAdapter(),
    )

    client.complete(
        [{"role": "developer", "content": "Follow repository instructions."}]
    )

    assert sdk_client.chat_completions.calls[-1]["messages"] == [
        {"role": "system", "content": "Follow repository instructions."}
    ]
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_openai_client.py::test_openai_chat_client_uses_provider_adapter_for_request_body tests/unit/infrastructure/test_openai_client.py::test_openai_chat_client_uses_provider_adapter_for_message_roles -v
```

Expected: fail because `provider_adapter` and `DeepSeekChatProviderAdapter` do not exist.

- [ ] **Step 3: Define the chat provider adapter protocol**

Create `src/mycli/infrastructure/providers/chat.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from mycli.domain.providers import ProviderId


@dataclass(slots=True, frozen=True)
class ChatProviderSettings:
    thinking_enabled: bool
    thinking_effort: str | None


class ChatProviderAdapter(Protocol):
    provider: ProviderId

    def adapt_messages(
        self,
        messages: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        ...

    def adapt_request_body(
        self,
        payload_body: dict[str, object],
        *,
        settings: ChatProviderSettings,
    ) -> dict[str, object]:
        ...

    def extract_message_metadata(
        self,
        message: dict[str, object],
    ) -> dict[str, object]:
        ...


class DefaultChatProviderAdapter:
    provider = ProviderId.COMPATIBLE

    def adapt_messages(
        self,
        messages: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        return [dict(message) for message in messages]

    def adapt_request_body(
        self,
        payload_body: dict[str, object],
        *,
        settings: ChatProviderSettings,
    ) -> dict[str, object]:
        return dict(payload_body)

    def extract_message_metadata(
        self,
        message: dict[str, object],
    ) -> dict[str, object]:
        return {}


__all__ = [
    "ChatProviderAdapter",
    "ChatProviderSettings",
    "DefaultChatProviderAdapter",
]
```

- [ ] **Step 4: Implement the DeepSeek chat provider adapter**

Create `src/mycli/infrastructure/providers/deepseek.py`:

```python
from __future__ import annotations

from mycli.domain.providers import ProviderId
from mycli.infrastructure.providers.chat import ChatProviderSettings


DEEPSEEK_METADATA_KEY = "deepseek"


class DeepSeekChatProviderAdapter:
    provider = ProviderId.DEEPSEEK

    def adapt_messages(
        self,
        messages: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        adapted: list[dict[str, object]] = []
        for message in messages:
            next_message = dict(message)
            if next_message.get("role") == "developer":
                next_message["role"] = "system"
            adapted.append(next_message)
        return adapted

    def adapt_request_body(
        self,
        payload_body: dict[str, object],
        *,
        settings: ChatProviderSettings,
    ) -> dict[str, object]:
        adapted = dict(payload_body)
        if not settings.thinking_enabled:
            adapted["extra_body"] = {"thinking": {"type": "disabled"}}
        return adapted

    def extract_message_metadata(
        self,
        message: dict[str, object],
    ) -> dict[str, object]:
        reasoning_content = message.get("reasoning_content")
        if not isinstance(reasoning_content, str) or not reasoning_content:
            return {}
        return {
            DEEPSEEK_METADATA_KEY: {
                "reasoning_content": reasoning_content,
            }
        }


__all__ = [
    "DEEPSEEK_METADATA_KEY",
    "DeepSeekChatProviderAdapter",
]
```

Create `src/mycli/infrastructure/providers/__init__.py`:

```python
from mycli.domain.providers import ProviderId
from mycli.infrastructure.providers.chat import (
    ChatProviderAdapter,
    ChatProviderSettings,
    DefaultChatProviderAdapter,
)
from mycli.infrastructure.providers.deepseek import DeepSeekChatProviderAdapter


def chat_adapter_for_provider(provider: ProviderId) -> ChatProviderAdapter:
    if provider is ProviderId.DEEPSEEK:
        return DeepSeekChatProviderAdapter()
    return DefaultChatProviderAdapter()


__all__ = [
    "ChatProviderAdapter",
    "ChatProviderSettings",
    "DeepSeekChatProviderAdapter",
    "DefaultChatProviderAdapter",
    "chat_adapter_for_provider",
]
```

- [ ] **Step 5: Wire the adapter into `OpenAIChatClient`**

In `src/mycli/infrastructure/openai_client.py`, import:

```python
from mycli.infrastructure.providers import (
    ChatProviderAdapter,
    ChatProviderSettings,
    DefaultChatProviderAdapter,
)
```

Update `OpenAIChatClient.__init__()`:

```python
        provider_adapter: ChatProviderAdapter | None = None,
```

Inside `__init__()`, add:

```python
        self._provider_adapter = provider_adapter or DefaultChatProviderAdapter()
```

At the start of `complete()`, adapt messages and request body:

```python
        adapted_messages = self._provider_adapter.adapt_messages(messages)
        payload_body: dict[str, object] = {
            "model": self._model,
            "messages": adapted_messages,
            "max_tokens": self._max_output_tokens,
            "temperature": 0,
        }
        payload_body = self._provider_adapter.adapt_request_body(
            payload_body,
            settings=ChatProviderSettings(
                thinking_enabled=self._thinking_enabled,
                thinking_effort=self._thinking_effort,
            ),
        )
```

Remove the inline `_uses_deepseek_api()` method and its call.

Change `ModelLogEvent(protocol=...)` from:

```python
                protocol="legacy_chat",
```

to:

```python
                protocol="chat_completions",
```

- [ ] **Step 6: Run the provider adapter tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_openai_client.py -v
```

Expected: all OpenAI chat client tests pass.

- [ ] **Step 7: Commit chat provider adapter extraction**

Run:

```bash
git add src/mycli/infrastructure/providers src/mycli/infrastructure/openai_client.py tests/unit/infrastructure/test_openai_client.py
git commit -m "Extract chat provider adaptation from OpenAI transport" \
  -m "DeepSeek request and role compatibility now live behind a provider adapter, keeping OpenAIChatClient focused on OpenAI-compatible chat transport mechanics." \
  -m "Constraint: DeepSeek still uses the OpenAI SDK compatible chat-completions surface" \
  -m "Rejected: Duplicate OpenAIChatClient into a DeepSeek-specific client | would copy logging and error handling before the boundary is justified" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/unit/infrastructure/test_openai_client.py -v"
```

## Task 3: Preserve DeepSeek `reasoning_content` Through Model Events

**Files:**
- Modify: `src/mycli/domain/model_events.py`
- Modify: `src/mycli/infrastructure/openai_client.py`
- Modify: `src/mycli/infrastructure/models/turn_event_aggregator.py`
- Test: `tests/unit/infrastructure/test_openai_client.py`
- Test: `tests/unit/infrastructure/models/test_turn_event_aggregator.py`

- [ ] **Step 1: Write failing response metadata tests**

Add this test to `tests/unit/infrastructure/test_openai_client.py`:

```python
def test_openai_chat_client_preserves_deepseek_reasoning_content_on_tool_call(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "content": None,
                        "reasoning_content": "I need to inspect the requested file.",
                        "tool_calls": [
                            {
                                "id": "call_read_file_1",
                                "type": "function",
                                "function": {
                                    "name": "read_file",
                                    "arguments": '{"path":"mission.txt"}',
                                },
                            }
                        ],
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        max_output_tokens=2048,
        provider_adapter=DeepSeekChatProviderAdapter(),
    )

    events = client.create_events(
        input_items=[{"role": "user", "content": "read mission.txt"}],
        tools=[
            {
                "name": "read_file",
                "description": "Read a file",
                "parameters": [{"name": "path", "type": "string"}],
            }
        ],
    )

    tool_event = next(event for event in events if event.tool_name == "read_file")
    assert tool_event.metadata["deepseek"] == {
        "reasoning_content": "I need to inspect the requested file."
    }
```

Add this test to `tests/unit/infrastructure/models/test_turn_event_aggregator.py`:

```python
def test_turn_event_aggregator_preserves_tool_call_metadata() -> None:
    aggregator = TurnEventAggregator()

    result = aggregator.collect(
        [
            ModelEvent.tool_call_requested(
                tool_name="read_file",
                tool_arguments={"path": "mission.txt"},
                call_id="call_read_file_1",
                source=ToolExecutionSource.NATIVE,
                metadata={
                    "deepseek": {
                        "reasoning_content": "I need to inspect the requested file."
                    }
                },
            )
        ]
    )

    tool_block = result.items[0].blocks[0]
    assert tool_block.metadata["deepseek"] == {
        "reasoning_content": "I need to inspect the requested file."
    }
```

- [ ] **Step 2: Run metadata tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_openai_client.py::test_openai_chat_client_preserves_deepseek_reasoning_content_on_tool_call tests/unit/infrastructure/models/test_turn_event_aggregator.py::test_turn_event_aggregator_preserves_tool_call_metadata -v
```

Expected: fail because event metadata is not copied onto tool-call events or runtime blocks.

- [ ] **Step 3: Allow `ModelEvent.tool_call_requested()` to accept metadata**

In `src/mycli/domain/model_events.py`, update the classmethod signature:

```python
    def tool_call_requested(
        cls,
        *,
        tool_name: str,
        tool_arguments: dict[str, object],
        call_id: str,
        source: ToolExecutionSource,
        provider_id: str | None = None,
        metadata: dict[str, object] | None = None,
    ) -> ModelEvent:
        return cls(
            type=ModelEventType.TOOL_CALL_REQUESTED,
            tool_name=tool_name,
            tool_arguments=tool_arguments,
            call_id=call_id,
            source=source,
            provider_id=provider_id,
            metadata={} if metadata is None else dict(metadata),
        )
```

- [ ] **Step 4: Attach provider metadata to chat tool-call payloads**

In `src/mycli/infrastructure/openai_client.py`, after `message = raw_message`, add:

```python
        provider_metadata = self._provider_adapter.extract_message_metadata(message)
```

In the native tool-call return payload, add metadata:

```python
                    "metadata": provider_metadata,
```

In `create_events()`, update the `ModelEvent.tool_call_requested(...)` call:

```python
                    metadata=(
                        raw_tool_call.get("metadata")
                        if isinstance(raw_tool_call.get("metadata"), dict)
                        else {}
                    ),
```

- [ ] **Step 5: Preserve event metadata in the turn aggregator**

In `src/mycli/infrastructure/models/turn_event_aggregator.py`, update the `RuntimeBlock(type="tool_call", ...)` construction:

```python
                    RuntimeBlock(
                        type="tool_call",
                        tool_name=event.tool_name,
                        tool_arguments=event.tool_arguments or {},
                        call_id=event.call_id,
                        provider_id=event.provider_id,
                        source=event.source.value if event.source is not None else None,
                        metadata=dict(event.metadata),
                    )
```

Also update reasoning and text blocks so future provider metadata survives consistently:

```python
                        metadata=dict(event.metadata),
```

- [ ] **Step 6: Run metadata tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_openai_client.py::test_openai_chat_client_preserves_deepseek_reasoning_content_on_tool_call tests/unit/infrastructure/models/test_turn_event_aggregator.py::test_turn_event_aggregator_preserves_tool_call_metadata -v
```

Expected: both tests pass.

- [ ] **Step 7: Commit provider metadata preservation**

Run:

```bash
git add src/mycli/domain/model_events.py src/mycli/infrastructure/openai_client.py src/mycli/infrastructure/models/turn_event_aggregator.py tests/unit/infrastructure/test_openai_client.py tests/unit/infrastructure/models/test_turn_event_aggregator.py
git commit -m "Preserve provider-private metadata through model events" \
  -m "DeepSeek reasoning_content is carried as provider metadata on tool-call events and runtime blocks so it can be replayed without becoming user-visible assistant text." \
  -m "Constraint: reasoning_content is provider-private state, not transcript content" \
  -m "Rejected: Store reasoning_content as a reasoning block | would expose provider internals to UI and summarization paths" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/unit/infrastructure/test_openai_client.py::test_openai_chat_client_preserves_deepseek_reasoning_content_on_tool_call tests/unit/infrastructure/models/test_turn_event_aggregator.py::test_turn_event_aggregator_preserves_tool_call_metadata -v"
```

## Task 4: Replay DeepSeek `reasoning_content` on Follow-Up Tool Requests

**Files:**
- Modify: `src/mycli/infrastructure/models/base.py`
- Modify: `src/mycli/infrastructure/providers/deepseek.py`
- Modify: `src/mycli/infrastructure/models/native_tool_adapter.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Test: `tests/unit/infrastructure/models/test_native_tool_adapter.py`
- Test: `tests/unit/application/test_agent_runtime_provider_metadata.py`

- [x] **Step 1: Write failing DeepSeek replay tests**

Add this test to `tests/unit/infrastructure/models/test_native_tool_adapter.py`:

```python
from mycli.infrastructure.providers.deepseek import DeepSeekChatProviderAdapter


def test_native_tool_adapter_replays_deepseek_reasoning_content() -> None:
    client = FakeNativeClient()
    adapter = NativeToolModelAdapter(
        client=client,
        provider_adapter=DeepSeekChatProviderAdapter(),
    )

    adapter.next_action(
        messages=[
            ModelMessage(
                role="assistant",
                content="",
                tool_calls=(
                    ToolCall(
                        name="read_file",
                        arguments={"path": "mission.txt"},
                        reason="inspect mission",
                        call_id="call_read_file_1",
                    ),
                ),
                metadata={
                    "deepseek": {
                        "reasoning_content": "I need to inspect the requested file."
                    }
                },
            ),
            ModelMessage(
                role="tool",
                content="Tool read_file: mission accomplished",
                tool_call_id="call_read_file_1",
            ),
        ],
        tools=[],
    )

    assert client.captured_messages[0]["reasoning_content"] == (
        "I need to inspect the requested file."
    )
```

Add this adapter class to `tests/unit/application/test_agent_runtime_provider_metadata.py`:

```python
class MetadataToolThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_items: list[list[RuntimeItem]] = []

    def next_turn(self, *, items, tools):
        del tools
        self.seen_items.append(items)
        self.calls += 1
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="read_file",
                                tool_arguments={"path": "mission.txt"},
                                call_id="call_read_file_1",
                                metadata={
                                    "deepseek": {
                                        "reasoning_content": (
                                            "I need to inspect the requested file."
                                        )
                                    }
                                },
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Read complete"),),
                ),
            ),
            done=True,
        )
```

Add this test to `tests/unit/application/test_agent_runtime_provider_metadata.py`:

```python
def test_agent_runtime_preserves_tool_call_metadata_for_next_turn(
    tmp_path: Path,
) -> None:
    (tmp_path / "mission.txt").write_text("mission accomplished\n", encoding="utf-8")
    adapter = MetadataToolThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("read mission.txt")

    assert response.assistant_message == "Read complete"
    assistant_item = next(
        item
        for item in adapter.seen_items[1]
        if item.role == "assistant"
        and any(block.type == "tool_call" for block in item.blocks)
    )
    tool_block = next(block for block in assistant_item.blocks if block.type == "tool_call")
    assert tool_block.metadata["deepseek"] == {
        "reasoning_content": "I need to inspect the requested file."
    }
```

- [x] **Step 2: Run replay tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/infrastructure/models/test_native_tool_adapter.py::test_native_tool_adapter_replays_deepseek_reasoning_content tests/unit/application/test_agent_runtime_provider_metadata.py::test_agent_runtime_preserves_tool_call_metadata_for_next_turn -v
```

Expected: fail because `ModelMessage` does not carry metadata, `NativeToolModelAdapter` has no provider adapter, and runtime does not preserve tool-call block metadata when it records assistant tool calls into conversation history.

- [x] **Step 3: Add metadata to `ModelMessage`**

In `src/mycli/infrastructure/models/base.py`, update `ModelMessage`:

```python
@dataclass(slots=True, frozen=True)
class ModelMessage:
    role: str
    content: str
    tool_call_id: str | None = None
    tool_calls: tuple[ToolCall, ...] = ()
    metadata: dict[str, object] = field(default_factory=dict)
```

Add `field` to the dataclass import:

```python
from dataclasses import dataclass, field
```

- [x] **Step 4: Add DeepSeek replay behavior to the provider adapter**

In `src/mycli/infrastructure/providers/deepseek.py`, update `adapt_messages()`:

```python
    def adapt_messages(
        self,
        messages: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        adapted: list[dict[str, object]] = []
        for message in messages:
            next_message = dict(message)
            metadata = next_message.pop("metadata", None)
            if next_message.get("role") == "developer":
                next_message["role"] = "system"
            deepseek_metadata = (
                metadata.get(DEEPSEEK_METADATA_KEY)
                if isinstance(metadata, dict)
                else None
            )
            reasoning_content = (
                deepseek_metadata.get("reasoning_content")
                if isinstance(deepseek_metadata, dict)
                else None
            )
            if isinstance(reasoning_content, str) and reasoning_content:
                next_message["reasoning_content"] = reasoning_content
            adapted.append(next_message)
        return adapted
```

- [x] **Step 5: Make `NativeToolModelAdapter` provider-aware and metadata-preserving**

In `src/mycli/infrastructure/models/native_tool_adapter.py`, import:

```python
from mycli.infrastructure.providers import (
    ChatProviderAdapter,
    DefaultChatProviderAdapter,
)
```

Update `NativeToolModelAdapter.__init__()`:

```python
    def __init__(
        self,
        client: NativeToolClient,
        provider_adapter: ChatProviderAdapter | None = None,
    ) -> None:
        self._client = client
        self._provider_adapter = provider_adapter or DefaultChatProviderAdapter()
        self._aggregator = TurnEventAggregator()
```

Remove `_chat_role()` and replace the first part of `_serialize_messages()` with provider-neutral records:

```python
    def _serialize_messages(
        self,
        messages: list[ModelMessage],
    ) -> list[dict[str, object]]:
        serialized = [
            {
                key: value
                for key, value in {
                    "role": message.role,
                    "content": message.content,
                    "tool_call_id": message.tool_call_id,
                    "metadata": message.metadata if message.metadata else None,
                    "tool_calls": (
                        [
                            {
                                "id": call.call_id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": json.dumps(call.arguments, ensure_ascii=False),
                                },
                            }
                            for call in message.tool_calls
                        ]
                        if message.tool_calls
                        else None
                    ),
                }.items()
                if value is not None
            }
            for message in messages
        ]
        return self._provider_adapter.adapt_messages(serialized)
```

Update the module/class docstrings so they say `chat_completions` instead of `legacy_chat`.

Add a `next_turn()` method before `next_action()` so event-capable chat clients preserve `RuntimeBlock.metadata` instead of flattening tool calls into `ModelAction`:

```python
    def next_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> ModelTurnResult:
        serialized_messages = self._serialize_runtime_items(items)
        serialized_tools = self._serialize_tools(tools)
        create_events = getattr(self._client, "create_events", None)
        if callable(create_events):
            return self._aggregator.collect(
                create_events(input_items=serialized_messages, tools=serialized_tools)
            )
        action = self.next_action(messages=self._messages_from_runtime_items(items), tools=tools)
        return self._legacy_action_to_turn_result(action)
```

Add these helpers below `_model_action_from_turn_result()`:

```python
    def _legacy_action_to_turn_result(self, action: ModelAction) -> ModelTurnResult:
        blocks: list[RuntimeBlock] = []
        if action.progress_message:
            blocks.append(RuntimeBlock(type="reasoning", text=action.progress_message))
        if action.assistant_message:
            blocks.append(RuntimeBlock(type="text", text=action.assistant_message))
        if action.tool_call is not None:
            blocks.append(
                RuntimeBlock(
                    type="tool_call",
                    tool_name=action.tool_call.name,
                    tool_arguments=action.tool_call.arguments,
                    call_id=action.tool_call.call_id or "tool_call",
                    source="native",
                )
            )
        return ModelTurnResult(
            items=(RuntimeItem(role="assistant", blocks=tuple(blocks)),) if blocks else (),
            done=action.done,
        )
```

Add these serialization helpers below `_legacy_action_to_turn_result()`:

```python
    def _serialize_runtime_items(
        self,
        items: list[RuntimeItem],
    ) -> list[dict[str, object]]:
        messages: list[ModelMessage] = []
        for item in items:
            text = "".join(block.text or "" for block in item.blocks if block.type == "text")
            tool_calls = tuple(
                ToolCall(
                    name=str(block.tool_name),
                    arguments=block.tool_arguments or {},
                    reason="model requested tool",
                    call_id=block.call_id,
                )
                for block in item.blocks
                if block.type == "tool_call"
            )
            tool_result = next(
                (block for block in item.blocks if block.type == "tool_result"),
                None,
            )
            metadata = self._merge_block_metadata(item.blocks)
            messages.append(
                ModelMessage(
                    role=item.role,
                    content=(tool_result.text or "") if tool_result is not None else text,
                    tool_call_id=tool_result.call_id if tool_result is not None else None,
                    tool_calls=tool_calls,
                    metadata=metadata,
                )
            )
        return self._serialize_messages(messages)

    def _messages_from_runtime_items(
        self,
        items: list[RuntimeItem],
    ) -> list[ModelMessage]:
        messages: list[ModelMessage] = []
        for item in items:
            text = "".join(block.text or "" for block in item.blocks if block.type == "text")
            messages.append(
                ModelMessage(
                    role=item.role,
                    content=text,
                    metadata=self._merge_block_metadata(item.blocks),
                )
            )
        return messages

    def _merge_block_metadata(
        self,
        blocks: tuple[RuntimeBlock, ...],
    ) -> dict[str, object]:
        merged: dict[str, object] = {}
        for block in blocks:
            merged.update(block.metadata)
        return merged
```

Add imports for `RuntimeBlock`, `RuntimeItem`, and `ModelTurnResult` from `mycli.infrastructure.models.base`.

- [x] **Step 6: Preserve assistant tool-call metadata in runtime conversation history**

In `src/mycli/application/runtime/agent_runtime.py`, update `_record_assistant_tool_call()` so it accepts metadata:

```python
    def _record_assistant_tool_call(
        self,
        conversation: Conversation,
        *,
        tool_call: ToolCall,
        provider_id: str | None = None,
        response_id: str | None = None,
        metadata: dict[str, object] | None = None,
    ) -> None:
        normalized_call = self._normalize_tool_call(tool_call)
        block_metadata = {} if metadata is None else dict(metadata)
        conversation.append(
            Message(
                role="assistant",
                content="",
                tool_calls=(normalized_call,),
                blocks=(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name=normalized_call.name,
                        tool_arguments=normalized_call.arguments,
                        call_id=normalized_call.call_id or "",
                        provider_id=provider_id,
                        metadata=block_metadata,
                    ),
                ),
                response_id=response_id,
            )
        )
```

Update `_execute_tool_call()` so it accepts and forwards metadata:

```python
        metadata: dict[str, object] | None = None,
```

and:

```python
        self._record_assistant_tool_call(
            conversation,
            tool_call=normalized_call,
            provider_id=provider_id,
            response_id=response_id,
            metadata=metadata,
        )
```

Update every `_execute_tool_call(...)` call inside `_consume_assistant_blocks()` to pass:

```python
                        metadata=dict(block.metadata),
```

- [x] **Step 7: Run replay tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/infrastructure/models/test_native_tool_adapter.py tests/unit/application/test_agent_runtime_provider_metadata.py::test_agent_runtime_preserves_tool_call_metadata_for_next_turn -v
```

Expected: all selected tests pass.

- [x] **Step 8: Commit reasoning replay**

Run:

```bash
git add docs/superpowers/plans/2026-04-26-mycli-deepseek-provider-architecture.md src/mycli/infrastructure/models/base.py src/mycli/infrastructure/providers/chat.py src/mycli/infrastructure/providers/deepseek.py src/mycli/infrastructure/models/native_tool_adapter.py src/mycli/application/runtime/agent_runtime.py tests/unit/infrastructure/models/test_native_tool_adapter.py tests/unit/application/test_agent_runtime_provider_metadata.py
git commit -m "Replay DeepSeek reasoning state through tool loops" \
  -m "Assistant tool-call metadata now carries DeepSeek reasoning_content back into the next chat-completions request, satisfying DeepSeek thinking-mode tool-loop requirements without exposing provider-private state as transcript text." \
  -m "Constraint: DeepSeek requires reasoning_content to be passed back after thinking-mode tool calls" \
  -m "Rejected: Disable thinking for all DeepSeek tool loops | works around the issue but blocks supported reasoning behavior" \
  -m "Confidence: medium" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/unit/infrastructure/models/test_native_tool_adapter.py tests/unit/application/test_agent_runtime_provider_metadata.py::test_agent_runtime_preserves_tool_call_metadata_for_next_turn -v"
```

## Task 5: Wire Provider Profiles Into CLI Runtime Construction

**Files:**
- Modify: `src/mycli/cli/main.py`
- Modify: `src/mycli/infrastructure/openai_responses_client.py`
- Test: `tests/integration/test_cli_repl.py`
- Test: `tests/unit/infrastructure/test_openai_responses_client.py`

- [x] **Step 1: Write failing CLI runtime selection tests**

Add this integration test to `tests/integration/test_cli_repl.py`:

```python
from mycli.domain.providers import ProtocolId, ProviderId
from mycli.infrastructure.models.native_tool_adapter import NativeToolModelAdapter
from mycli.cli.main import build_turn_service


def test_build_turn_service_uses_chat_completions_for_deepseek(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    home.mkdir()

    service = build_turn_service(
        {"session": "deepseek-demo"},
        cwd=workspace,
        home=home,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "deepseek",
            "MYCLI_MODEL": "deepseek-v4-flash",
        },
    )

    assert service._config.provider is ProviderId.DEEPSEEK
    assert service._config.protocol is ProtocolId.CHAT_COMPLETIONS
    assert isinstance(service._runtime._model_adapter, NativeToolModelAdapter)
```

- [x] **Step 2: Run the CLI runtime selection test and verify it fails**

Run:

```bash
uv run pytest tests/integration/test_cli_repl.py::test_build_turn_service_uses_chat_completions_for_deepseek -v
```

Expected: fail because runtime still branches on `"legacy_chat"` and does not construct provider adapters.

- [x] **Step 3: Update CLI runtime construction**

In `src/mycli/cli/main.py`, import:

```python
from mycli.domain.providers import ProtocolId
from mycli.infrastructure.providers import chat_adapter_for_provider
```

Update the transport selection:

```python
    provider_adapter = chat_adapter_for_provider(config.provider)
    if config.protocol is ProtocolId.CHAT_COMPLETIONS:
        chat_client = OpenAIChatClient(
            api_key=config.api_key,
            base_url=config.api_base_url,
            model=config.model,
            max_output_tokens=config.max_output_tokens,
            log_service=workspace_log_service,
            provider_adapter=provider_adapter,
        )
        model_adapter = cast(
            ModelAdapter,
            NativeToolModelAdapter(
                client=chat_client,
                provider_adapter=provider_adapter,
            ),
        )
    else:
        responses_client = OpenAIResponsesClient(
            api_key=config.api_key,
            base_url=config.api_base_url,
            model=config.model,
            max_output_tokens=config.max_output_tokens,
            log_service=workspace_log_service,
        )
        model_adapter = cast(
            ModelAdapter,
            ResponsesModelAdapter(
                client=responses_client,
                log_service=workspace_log_service,
            ),
        )
```

Remove the old `if config.protocol == "legacy_chat"` branch.

- [x] **Step 4: Update responses guidance away from legacy chat**

In `src/mycli/infrastructure/openai_responses_client.py`, replace user-facing references to `legacy_chat` with `chat_completions`. The exact replacement text for unsupported Responses guidance must be:

```text
Use protocol='chat_completions' for providers that do not support the Responses API.
```

Update or add a unit test in `tests/unit/infrastructure/test_openai_responses_client.py` that asserts this text appears in the error message when Responses is unsupported.

- [x] **Step 5: Run CLI and Responses tests**

Run:

```bash
uv run pytest tests/integration/test_cli_repl.py tests/unit/infrastructure/test_openai_responses_client.py -v
```

Expected: all selected tests pass.

- [x] **Step 6: Commit runtime provider wiring**

Run:

```bash
git add src/mycli/cli/main.py src/mycli/infrastructure/openai_responses_client.py tests/integration/test_cli_repl.py tests/unit/infrastructure/test_openai_responses_client.py
git commit -m "Route runtime construction through provider protocols" \
  -m "CLI runtime construction now chooses responses or chat_completions using the resolved provider profile, allowing DeepSeek to enter through the formal chat-completions path." \
  -m "Constraint: DeepSeek does not support OpenAI Responses API" \
  -m "Rejected: Keep legacy_chat as an alias | prolongs ambiguous protocol naming" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: uv run pytest tests/integration/test_cli_repl.py tests/unit/infrastructure/test_openai_responses_client.py -v"
```

## Task 6: Document and Verify DeepSeek Thinking Tool Loops

**Files:**
- Modify: `README.md`
- Test: `tests/unit/services/test_config_service.py`
- Test: `tests/unit/infrastructure/test_openai_client.py`
- Test: `tests/unit/infrastructure/models/test_native_tool_adapter.py`
- Test: `tests/integration/test_cli_repl.py`

- [x] **Step 1: Update README provider documentation**

Add this section to `README.md`:

````markdown
## Model Providers

`mycli` resolves model access through a provider and protocol pair.

```toml
provider = "openai"
protocol = "responses"
```

Supported provider values:

- `openai`
- `deepseek`
- `compatible`

Supported protocol values:

- `responses`
- `chat_completions`

`legacy_chat` is not a supported protocol name. Use `chat_completions`.

### DeepSeek

DeepSeek uses the OpenAI-compatible chat completions protocol:

```toml
provider = "deepseek"
protocol = "chat_completions"
model = "deepseek-v4-flash"
api_base_url = "https://api.deepseek.com"
thinking_enabled = true
```

When DeepSeek thinking mode calls tools, the API returns provider-private
`reasoning_content`. `mycli` preserves that value as provider metadata and passes
it back on the follow-up tool-result request. It is not displayed as assistant
text and is not treated as user-visible transcript content.

For providers that do not support thinking metadata, set:

```toml
thinking_enabled = false
```
````

- [x] **Step 2: Run the focused test suite**

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py tests/unit/infrastructure/test_openai_client.py tests/unit/infrastructure/models/test_turn_event_aggregator.py tests/unit/infrastructure/models/test_native_tool_adapter.py tests/integration/test_cli_repl.py -v
```

Expected: all selected tests pass.

- [x] **Step 3: Run lint**

Run:

```bash
uv run ruff check src tests
```

Expected: `All checks passed!`

- [x] **Step 4: Run full tests**

Run:

```bash
uv run pytest
```

Expected: all tests pass.

- [x] **Step 5: Run mypy and record existing baseline if it fails**

Run:

```bash
uv run mypy src
```

Expected: either success, or failure only in existing baseline areas unrelated to this plan. If it fails, record the exact files in the final report and do not claim mypy is clean.

- [x] **Step 6: Run a live DeepSeek thinking tool-loop check**

Use a temporary workspace and do not print the API key:

```bash
tmp_home=$(mktemp -d)
tmp_workspace=$(mktemp -d)
printf '%s\n' 'runtime task result: deepseek used mycli tools successfully' > "$tmp_workspace/mission.txt"
cd "$tmp_workspace"
printf '%s\n%s\n' '请使用工具读取 mission.txt，然后只用一行中文总结文件内容。' '/quit' | env \
MYCLI_API_KEY="$DEEPSEEK_API_KEY" \
MYCLI_BASE_URL='https://api.deepseek.com' \
MYCLI_PROVIDER='deepseek' \
MYCLI_MODEL='deepseek-v4-flash' \
MYCLI_PROTOCOL='chat_completions' \
MYCLI_MAX_OUTPUT_TOKENS='256' \
MYCLI_THINKING_ENABLED='true' \
HOME="$tmp_home" \
uv run --project /Users/cosmos/Desktop/mycli mycli --session deepseek-thinking-tool-live-test
```

Expected output includes:

```text
[activity] Reading: mission.txt
[activity] Done reading: mission.txt
```

Expected final assistant message is a one-line Chinese summary of `mission.txt`.

- [x] **Step 7: Commit docs and verification updates**

Run:

```bash
git add README.md
git commit -m "Document provider protocols and DeepSeek thinking loops" \
  -m "The README now describes provider/protocol configuration, chat_completions naming, and how DeepSeek reasoning_content is preserved for thinking-mode tool loops." \
  -m "Constraint: reasoning_content must remain provider-private metadata" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest" \
  -m "Tested: uv run ruff check src tests" \
  -m "Tested: live DeepSeek thinking tool-loop check"
```

## Final Verification Checklist

- [x] `uv run pytest tests/unit/services/test_config_service.py tests/unit/infrastructure/test_openai_client.py tests/unit/infrastructure/models/test_turn_event_aggregator.py tests/unit/infrastructure/models/test_native_tool_adapter.py tests/integration/test_cli_repl.py -v`
- [x] `uv run ruff check src tests`
- [x] `uv run pytest`
- [x] `uv run mypy src` (ran; existing baseline failures remain in `responses_protocol.py`, `runtime_policy.py`, `evaluation/runner.py`, `tool_exposure_planner.py`, and `turn_executor.py`)
- [x] Live DeepSeek `thinking_enabled=true` tool-loop check with `protocol=chat_completions`
- [x] `git status --short` reviewed so only intended tracked files are modified or committed

## Self-Review Notes

- Spec coverage: provider resolution is covered by Task 1; DeepSeek module extraction is covered by Task 2; `reasoning_content` capture is covered by Task 3; replay is covered by Task 4; runtime wiring and `legacy_chat` removal are covered by Task 5; docs and live verification are covered by Task 6.
- Placeholder scan: no unresolved placeholders or vague implementation-only steps remain.
- Type consistency: `ProviderId`, `ProtocolId`, `ChatProviderAdapter`, `ChatProviderSettings`, `ModelMessage.metadata`, `ModelEvent.metadata`, and `RuntimeBlock.metadata` are introduced before later tasks use them.

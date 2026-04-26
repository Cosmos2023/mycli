# Anthropic Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class Anthropic provider using the native Anthropic Messages API, including text, tool calls, tool results, thinking output, config selection, logging, and tests.

**Architecture:** Introduce `ProviderId.ANTHROPIC` and `ProtocolId.ANTHROPIC_MESSAGES`, then keep Anthropic-specific wire behavior isolated in a new Anthropic Messages client and model adapter. The existing `AgentRuntime -> ModelAdapter -> ModelTurnResult -> RuntimeBlock` loop remains the boundary, so runtime code only chooses the adapter by protocol and consumes normal runtime blocks.

**Tech Stack:** Python 3.13, `anthropic` Python SDK, existing mycli provider registry, existing `ModelTurnResult` runtime contract, `pytest`, `mypy`, `ruff`, `uv`.

---

## Source Context

Read these before implementation:

- Spec: `docs/superpowers/specs/2026-04-26-mycli-anthropic-provider-design.md`
- Provider types: `src/mycli/domain/providers.py`
- Provider registry: `src/mycli/infrastructure/providers/registry.py`
- CLI runtime construction: `src/mycli/cli/main.py`
- Model adapter contract: `src/mycli/infrastructure/models/base.py`
- Native tool adapter pattern: `src/mycli/infrastructure/models/native_tool_adapter.py`
- Responses adapter mapping pattern: `src/mycli/infrastructure/models/responses_adapter.py`
- Runtime block contract: `src/mycli/domain/runtime/blocks.py`

Official docs used by this plan:

- Anthropic Python SDK: `https://platform.claude.com/docs/en/api/client-sdks`
- Anthropic Messages examples: `https://docs.anthropic.com/en/api/messages-examples`
- Anthropic tool use: `https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use`
- Anthropic extended thinking: `https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking`
- Anthropic models overview: `https://platform.claude.com/docs/en/about-claude/models/overview`

## File Structure

- Modify: `pyproject.toml`
  - Add the official `anthropic` SDK dependency.
- Modify: `uv.lock`
  - Update via `uv add anthropic`.
- Modify: `src/mycli/domain/providers.py`
  - Add Anthropic provider and protocol IDs.
  - Add `supports_anthropic_messages` to provider profiles.
- Create: `src/mycli/infrastructure/providers/anthropic.py`
  - Define `ANTHROPIC_PROFILE`.
- Modify: `src/mycli/infrastructure/providers/registry.py`
  - Register Anthropic profile, infer Anthropic base URLs, validate Anthropic protocol support.
- Modify: `src/mycli/infrastructure/providers/__init__.py`
  - Export Anthropic profile if direct imports are needed by tests and callers.
- Create: `src/mycli/infrastructure/anthropic_messages_client.py`
  - Wrap the Anthropic SDK, request construction, thinking budget mapping, SDK error translation, and raw request/response logging.
- Create: `src/mycli/infrastructure/models/anthropic_messages_adapter.py`
  - Convert mycli runtime items and tool definitions to Anthropic Messages payloads and map Anthropic responses back to `ModelTurnResult`.
- Modify: `src/mycli/infrastructure/models/__init__.py`
  - Export `AnthropicMessagesModelAdapter`.
- Modify: `src/mycli/cli/main.py`
  - Construct Anthropic client and adapter when `config.protocol is ProtocolId.ANTHROPIC_MESSAGES`.
- Modify: `tests/unit/services/test_config_service.py`
  - Cover Anthropic config defaults and invalid protocol combinations.
- Modify: `tests/unit/infrastructure/test_provider_adapters.py`
  - Cover Anthropic profile lookup and base URL inference.
- Create: `tests/unit/infrastructure/models/test_anthropic_messages_adapter.py`
  - Cover serialization and response mapping without live API calls.
- Create: `tests/unit/infrastructure/test_anthropic_messages_client.py`
  - Cover SDK wrapper request construction, thinking budget behavior, and error mapping with fake SDK clients.
- Modify: `tests/integration/test_cli_repl.py`
  - Cover runtime adapter selection for Anthropic.

---

### Task 1: Add Anthropic Dependency

**Files:**
- Modify: `pyproject.toml`
- Modify: `uv.lock`

- [ ] **Step 1: Add the SDK dependency**

Run:

```bash
uv add anthropic
```

Expected:

```text
pyproject.toml updated with anthropic
uv.lock updated
```

- [ ] **Step 2: Verify the dependency imports**

Run:

```bash
uv run python -c "import anthropic; print(anthropic.__name__)"
```

Expected:

```text
anthropic
```

- [ ] **Step 3: Commit dependency addition**

Run:

```bash
git add pyproject.toml uv.lock
git commit -m "Add the Anthropic SDK dependency" -m "Anthropic Messages uses provider-specific request, tool, thinking, and error semantics, so the official SDK is used instead of building a hand-rolled HTTP client."
```

---

### Task 2: Add Provider And Protocol Registry Support

**Files:**
- Modify: `src/mycli/domain/providers.py`
- Create: `src/mycli/infrastructure/providers/anthropic.py`
- Modify: `src/mycli/infrastructure/providers/registry.py`
- Modify: `src/mycli/infrastructure/providers/__init__.py`
- Modify: `tests/unit/services/test_config_service.py`
- Modify: `tests/unit/infrastructure/test_provider_adapters.py`

- [ ] **Step 1: Write failing config tests**

Append to `tests/unit/services/test_config_service.py`:

```python
def test_resolve_config_infers_anthropic_provider_and_defaults_to_messages(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "anthropic-demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_BASE_URL": "https://api.anthropic.com",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.ANTHROPIC
    assert config.protocol is ProtocolId.ANTHROPIC_MESSAGES
    assert config.model == "claude-sonnet-4-6"
    assert config.api_base_url == "https://api.anthropic.com"


def test_resolve_config_uses_anthropic_defaults_for_explicit_provider(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "anthropic-demo"},
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "anthropic",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.provider is ProviderId.ANTHROPIC
    assert config.protocol is ProtocolId.ANTHROPIC_MESSAGES
    assert config.model == "claude-sonnet-4-6"
    assert config.api_base_url == "https://api.anthropic.com"


def test_resolve_config_rejects_anthropic_with_responses_protocol(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(
        ValueError,
        match="Provider 'anthropic' does not support protocol 'responses'",
    ):
        resolve_config(
            cli_args={"session": "anthropic-demo"},
            env={
                "MYCLI_API_KEY": "test-key",
                "MYCLI_PROVIDER": "anthropic",
                "MYCLI_PROTOCOL": "responses",
            },
            cwd=workspace,
            home=home_dir,
        )


def test_resolve_config_rejects_anthropic_with_chat_completions_protocol(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(
        ValueError,
        match="Provider 'anthropic' does not support protocol 'chat_completions'",
    ):
        resolve_config(
            cli_args={"session": "anthropic-demo"},
            env={
                "MYCLI_API_KEY": "test-key",
                "MYCLI_PROVIDER": "anthropic",
                "MYCLI_PROTOCOL": "chat_completions",
            },
            cwd=workspace,
            home=home_dir,
        )
```

- [ ] **Step 2: Write failing provider registry tests**

Update `tests/unit/infrastructure/test_provider_adapters.py`:

```python
from mycli.infrastructure.providers import infer_provider_from_base_url
from mycli.infrastructure.providers.anthropic import ANTHROPIC_PROFILE
```

Extend `test_profile_for_provider_uses_provider_module_profiles`:

```python
    assert profile_for_provider(ProviderId.ANTHROPIC) is ANTHROPIC_PROFILE
    assert ANTHROPIC_PROFILE.default_protocol is ProtocolId.ANTHROPIC_MESSAGES
    assert ANTHROPIC_PROFILE.default_base_url == "https://api.anthropic.com"
```

Add:

```python
def test_infer_provider_from_base_url_detects_anthropic_hosts() -> None:
    assert infer_provider_from_base_url("https://api.anthropic.com") is ProviderId.ANTHROPIC
    assert infer_provider_from_base_url("https://console.anthropic.com") is ProviderId.ANTHROPIC
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py tests/unit/infrastructure/test_provider_adapters.py -q
```

Expected:

```text
FAILED ... AttributeError: ANTHROPIC
```

- [ ] **Step 4: Implement provider and protocol types**

Modify `src/mycli/domain/providers.py`:

```python
class ProviderId(StrEnum):
    OPENAI = "openai"
    QWEN = "qwen"
    DEEPSEEK = "deepseek"
    ANTHROPIC = "anthropic"
    COMPATIBLE = "compatible"


class ProtocolId(StrEnum):
    RESPONSES = "responses"
    CHAT_COMPLETIONS = "chat_completions"
    ANTHROPIC_MESSAGES = "anthropic_messages"
```

Extend `ProviderProfile`:

```python
@dataclass(slots=True, frozen=True)
class ProviderProfile:
    provider: ProviderId
    default_protocol: ProtocolId
    supports_responses: bool
    supports_chat_completions: bool
    default_base_url: str
    default_model: str | None = None
    unsupported_responses_hint: str | None = None
    supports_anthropic_messages: bool = False
```

- [ ] **Step 5: Add Anthropic provider module**

Create `src/mycli/infrastructure/providers/anthropic.py`:

```python
from __future__ import annotations

from mycli.domain.providers import ProtocolId, ProviderId, ProviderProfile

ANTHROPIC_PROFILE = ProviderProfile(
    provider=ProviderId.ANTHROPIC,
    default_protocol=ProtocolId.ANTHROPIC_MESSAGES,
    supports_responses=False,
    supports_chat_completions=False,
    supports_anthropic_messages=True,
    default_base_url="https://api.anthropic.com",
    default_model="claude-sonnet-4-6",
    unsupported_responses_hint="Use protocol='anthropic_messages' for Anthropic.",
)

__all__ = ["ANTHROPIC_PROFILE"]
```

- [ ] **Step 6: Register Anthropic profile and protocol validation**

Modify `src/mycli/infrastructure/providers/registry.py`:

```python
from mycli.infrastructure.providers.anthropic import ANTHROPIC_PROFILE
```

Add to `_PROFILES`:

```python
ProviderId.ANTHROPIC: ANTHROPIC_PROFILE,
```

Add to `infer_provider_from_base_url` before the OpenAI fallback:

```python
if normalized == "api.anthropic.com" or normalized.endswith(".anthropic.com"):
    return ProviderId.ANTHROPIC
```

Add to `validate_provider_protocol`:

```python
if (
    protocol is ProtocolId.ANTHROPIC_MESSAGES
    and not profile.supports_anthropic_messages
):
    raise ValueError(
        f"Provider '{provider.value}' does not support protocol '{protocol.value}'."
    )
```

- [ ] **Step 7: Export Anthropic profile**

Modify `src/mycli/infrastructure/providers/__init__.py`:

```python
from mycli.infrastructure.providers.anthropic import ANTHROPIC_PROFILE
```

Add `"ANTHROPIC_PROFILE"` to `__all__`.

- [ ] **Step 8: Run targeted tests**

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py tests/unit/infrastructure/test_provider_adapters.py -q
```

Expected:

```text
passed
```

- [ ] **Step 9: Commit provider registry support**

Run:

```bash
git add src/mycli/domain/providers.py src/mycli/infrastructure/providers tests/unit/services/test_config_service.py tests/unit/infrastructure/test_provider_adapters.py
git commit -m "Register Anthropic as a native provider" -m "Anthropic needs its own protocol because Messages API semantics do not match Responses or chat-completions."
```

---

### Task 3: Add Anthropic Messages Adapter Serialization Tests

**Files:**
- Create: `tests/unit/infrastructure/models/test_anthropic_messages_adapter.py`
- Create: `src/mycli/infrastructure/models/anthropic_messages_adapter.py`

- [ ] **Step 1: Write fake client and serialization tests**

Create `tests/unit/infrastructure/models/test_anthropic_messages_adapter.py` with:

```python
from __future__ import annotations

from mycli.infrastructure.models.anthropic_messages_adapter import (
    AnthropicMessagesModelAdapter,
)
from mycli.infrastructure.models.base import (
    ModelToolDefinition,
    ModelToolParameter,
    RuntimeBlock,
    RuntimeItem,
)


class FakeAnthropicMessagesClient:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload
        self.captured_system: str | None = None
        self.captured_messages: list[dict[str, object]] = []
        self.captured_tools: list[dict[str, object]] = []

    def create_message(
        self,
        *,
        system: str | None,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        self.captured_system = system
        self.captured_messages = messages
        self.captured_tools = tools
        return self.payload


def test_anthropic_adapter_serializes_system_developer_messages_and_tools() -> None:
    client = FakeAnthropicMessagesClient(
        {
            "id": "msg_123",
            "role": "assistant",
            "content": [{"type": "text", "text": "Ready."}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 3},
        }
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    result = adapter.next_turn(
        items=[
            RuntimeItem(
                role="system",
                blocks=(RuntimeBlock(type="text", text="System rules."),),
            ),
            RuntimeItem(
                role="developer",
                blocks=(RuntimeBlock(type="text", text="Developer rules."),),
            ),
            RuntimeItem(
                role="user",
                blocks=(RuntimeBlock(type="text", text="Read README."),),
            ),
        ],
        tools=[
            ModelToolDefinition(
                name="read_file",
                description="Read a file",
                parameters=(
                    ModelToolParameter(
                        name="path",
                        type="string",
                        required=True,
                        description="Path to read",
                    ),
                ),
            ),
        ],
    )

    assert client.captured_system == "System rules.\n\nDeveloper rules."
    assert client.captured_messages == [
        {
            "role": "user",
            "content": [{"type": "text", "text": "Read README."}],
        }
    ]
    assert client.captured_tools == [
        {
            "name": "read_file",
            "description": "Read a file",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to read",
                    }
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        }
    ]
    assert result.done is True
    assert result.response_id == "msg_123"
    assert result.metadata == {"usage": {"input_tokens": 10, "output_tokens": 3}}
    assert result.items[0].blocks[0].text == "Ready."
```

- [ ] **Step 2: Add replay serialization test**

Append:

```python
def test_anthropic_adapter_serializes_prior_tool_use_and_tool_result() -> None:
    client = FakeAnthropicMessagesClient(
        {
            "id": "msg_124",
            "role": "assistant",
            "content": [{"type": "text", "text": "The README says hello."}],
            "stop_reason": "end_turn",
        }
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    adapter.next_turn(
        items=[
            RuntimeItem(
                role="assistant",
                blocks=(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name="read_file",
                        tool_arguments={"path": "README.md"},
                        call_id="toolu_123",
                        provider_id="toolu_123",
                    ),
                ),
            ),
            RuntimeItem(
                role="tool",
                blocks=(
                    RuntimeBlock(
                        type="tool_result",
                        text="README content",
                        call_id="toolu_123",
                    ),
                ),
            ),
        ],
        tools=[],
    )

    assert client.captured_messages == [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_123",
                    "name": "read_file",
                    "input": {"path": "README.md"},
                }
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_123",
                    "content": "README content",
                }
            ],
        },
    ]
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/infrastructure/models/test_anthropic_messages_adapter.py -q
```

Expected:

```text
FAILED ... ModuleNotFoundError: No module named 'mycli.infrastructure.models.anthropic_messages_adapter'
```

- [ ] **Step 4: Create minimal adapter shell**

Create `src/mycli/infrastructure/models/anthropic_messages_adapter.py`:

```python
from __future__ import annotations

from typing import Protocol

from mycli.domain.runtime.blocks import ModelTurnResult, RuntimeBlock, RuntimeItem
from mycli.infrastructure.models.base import (
    ModelAction,
    ModelMessage,
    ModelToolDefinition,
)


class AnthropicMessagesClientProtocol(Protocol):
    def create_message(
        self,
        *,
        system: str | None,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        ...


class AnthropicMessagesModelAdapter:
    def __init__(self, *, client: AnthropicMessagesClientProtocol) -> None:
        self._client = client

    def next_action(
        self,
        *,
        messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> ModelAction:
        result = self.next_turn(
            items=[
                RuntimeItem(
                    role=message.role,  # type: ignore[arg-type]
                    blocks=(RuntimeBlock(type="text", text=message.content),),
                )
                for message in messages
                if message.content
            ],
            tools=tools,
        )
        text_block = (
            result.items[0].blocks[0]
            if result.items and result.items[0].blocks
            else None
        )
        return ModelAction(
            assistant_message=text_block.text if text_block else None,
            done=result.done,
        )

    def next_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> ModelTurnResult:
        system, messages = self._serialize_items(items)
        payload = self._client.create_message(
            system=system,
            messages=messages,
            tools=self._serialize_tools(tools),
        )
        return self._to_turn_result(payload)
```

The `# type: ignore[arg-type]` is temporary inside this task only. Remove it in the same task when `_runtime_item_from_model_message` is added below.

- [ ] **Step 5: Add serialization helpers**

Add these methods to `AnthropicMessagesModelAdapter`:

```python
    def _serialize_items(
        self,
        items: list[RuntimeItem],
    ) -> tuple[str | None, list[dict[str, object]]]:
        system_parts: list[str] = []
        messages: list[dict[str, object]] = []
        for item in items:
            if item.role in {"system", "developer"}:
                system_parts.extend(
                    block.text
                    for block in item.blocks
                    if block.type == "text" and block.text
                )
                continue
            content = self._content_blocks_for_item(item)
            if content:
                messages.append({"role": self._anthropic_role(item.role), "content": content})
        system = "\n\n".join(system_parts) if system_parts else None
        return system, messages

    def _anthropic_role(self, role: str) -> str:
        return "user" if role == "tool" else role

    def _content_blocks_for_item(self, item: RuntimeItem) -> list[dict[str, object]]:
        content: list[dict[str, object]] = []
        for block in item.blocks:
            if block.type == "text" and block.text:
                content.append({"type": "text", "text": block.text})
                continue
            if block.type == "tool_call":
                content.append(
                    {
                        "type": "tool_use",
                        "id": str(block.call_id),
                        "name": str(block.tool_name),
                        "input": block.tool_arguments or {},
                    }
                )
                continue
            if block.type == "tool_result" and block.call_id:
                content.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.call_id,
                        "content": block.text or "",
                    }
                )
                continue
        return content

    def _serialize_tools(
        self,
        tools: list[ModelToolDefinition],
    ) -> list[dict[str, object]]:
        serialized_tools: list[dict[str, object]] = []
        for tool in tools:
            properties: dict[str, object] = {}
            required: list[str] = []
            for parameter in tool.parameters:
                schema: dict[str, object] = {"type": parameter.type}
                if parameter.description is not None:
                    schema["description"] = parameter.description
                if parameter.items_schema is not None:
                    schema["items"] = dict(parameter.items_schema)
                properties[parameter.name] = schema
                if parameter.required:
                    required.append(parameter.name)
            serialized_tools.append(
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": {
                        "type": "object",
                        "properties": properties,
                        "required": required,
                        "additionalProperties": False,
                    },
                }
            )
        return serialized_tools
```

- [ ] **Step 6: Add response mapping helper**

Add:

```python
    def _to_turn_result(self, payload: dict[str, object]) -> ModelTurnResult:
        blocks: list[RuntimeBlock] = []
        raw_content = payload.get("content", [])
        content = raw_content if isinstance(raw_content, list) else []
        has_tool_call = False
        for raw_block in content:
            if not isinstance(raw_block, dict):
                continue
            block_type = raw_block.get("type")
            provider_id = raw_block.get("id")
            provider_id_value = provider_id if isinstance(provider_id, str) else None
            if block_type == "text":
                text = raw_block.get("text")
                if isinstance(text, str) and text:
                    blocks.append(
                        RuntimeBlock(
                            type="text",
                            text=text,
                            provider_id=provider_id_value,
                            metadata={"anthropic": dict(raw_block)},
                        )
                    )
                continue
            if block_type == "thinking":
                thinking = raw_block.get("thinking") or raw_block.get("text")
                if isinstance(thinking, str) and thinking:
                    blocks.append(
                        RuntimeBlock(
                            type="reasoning",
                            text=thinking,
                            provider_id=provider_id_value,
                            metadata={"anthropic": dict(raw_block)},
                        )
                    )
                continue
            if block_type == "tool_use":
                name = raw_block.get("name")
                tool_input = raw_block.get("input", {})
                tool_id = raw_block.get("id")
                if isinstance(name, str) and isinstance(tool_id, str):
                    blocks.append(
                        RuntimeBlock(
                            type="tool_call",
                            tool_name=name,
                            tool_arguments=tool_input if isinstance(tool_input, dict) else {},
                            call_id=tool_id,
                            provider_id=tool_id,
                            source="native",
                            metadata={"anthropic": dict(raw_block)},
                        )
                    )
                    has_tool_call = True
        response_id = payload.get("id")
        usage = payload.get("usage")
        return ModelTurnResult(
            items=(RuntimeItem(role="assistant", blocks=tuple(blocks)),) if blocks else (),
            done=not has_tool_call,
            response_id=response_id if isinstance(response_id, str) else None,
            metadata={"usage": usage} if isinstance(usage, dict) else {},
        )
```

- [ ] **Step 7: Remove temporary ignore**

Replace the `next_action` item conversion with a helper:

```python
    def _runtime_item_from_model_message(self, message: ModelMessage) -> RuntimeItem | None:
        if message.role not in {"system", "developer", "user", "assistant", "tool"}:
            return None
        blocks: list[RuntimeBlock] = []
        if message.content:
            blocks.append(RuntimeBlock(type="text", text=message.content))
        for call in message.tool_calls:
            blocks.append(
                RuntimeBlock(
                    type="tool_call",
                    tool_name=call.name,
                    tool_arguments=call.arguments,
                    call_id=call.call_id or call.name,
                )
            )
        if not blocks:
            return None
        return RuntimeItem(role=message.role, blocks=tuple(blocks))
```

Update `next_action`:

```python
runtime_items = [
    item
    for message in messages
    if (item := self._runtime_item_from_model_message(message)) is not None
]
```

- [ ] **Step 8: Run targeted tests**

Run:

```bash
uv run pytest tests/unit/infrastructure/models/test_anthropic_messages_adapter.py -q
uv run mypy src/mycli/infrastructure/models/anthropic_messages_adapter.py
```

Expected:

```text
passed
Success: no issues found
```

- [ ] **Step 9: Commit serialization adapter**

Run:

```bash
git add src/mycli/infrastructure/models/anthropic_messages_adapter.py tests/unit/infrastructure/models/test_anthropic_messages_adapter.py
git commit -m "Serialize Anthropic Messages runtime turns" -m "The Anthropic adapter maps mycli runtime items, native tools, tool calls, and tool results into Anthropic Messages shapes while returning normal ModelTurnResult objects."
```

---

### Task 4: Add Tool Use And Thinking Response Mapping Tests

**Files:**
- Modify: `tests/unit/infrastructure/models/test_anthropic_messages_adapter.py`
- Modify: `src/mycli/infrastructure/models/anthropic_messages_adapter.py`

- [ ] **Step 1: Add tool-use response mapping test**

Append to `tests/unit/infrastructure/models/test_anthropic_messages_adapter.py`:

```python
def test_anthropic_adapter_maps_tool_use_to_runtime_tool_call() -> None:
    client = FakeAnthropicMessagesClient(
        {
            "id": "msg_tool",
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_456",
                    "name": "search_text",
                    "input": {"pattern": "Anthropic"},
                }
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 12, "output_tokens": 7},
        }
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    result = adapter.next_turn(
        items=[
            RuntimeItem(
                role="user",
                blocks=(RuntimeBlock(type="text", text="Find Anthropic."),),
            )
        ],
        tools=[],
    )

    block = result.items[0].blocks[0]
    assert result.done is False
    assert block.type == "tool_call"
    assert block.tool_name == "search_text"
    assert block.tool_arguments == {"pattern": "Anthropic"}
    assert block.call_id == "toolu_456"
    assert block.provider_id == "toolu_456"
    assert block.source == "native"
    assert block.metadata["anthropic"] == {
        "type": "tool_use",
        "id": "toolu_456",
        "name": "search_text",
        "input": {"pattern": "Anthropic"},
    }
```

- [ ] **Step 2: Add thinking response mapping test**

Append:

```python
def test_anthropic_adapter_maps_thinking_to_reasoning_block() -> None:
    client = FakeAnthropicMessagesClient(
        {
            "id": "msg_thinking",
            "role": "assistant",
            "content": [
                {
                    "type": "thinking",
                    "thinking": "I should inspect the repository first.",
                    "signature": "sig_123",
                },
                {"type": "text", "text": "I will inspect the repository."},
            ],
            "stop_reason": "end_turn",
        }
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    result = adapter.next_turn(
        items=[
            RuntimeItem(
                role="user",
                blocks=(RuntimeBlock(type="text", text="Analyze this repo."),),
            )
        ],
        tools=[],
    )

    reasoning_block = result.items[0].blocks[0]
    text_block = result.items[0].blocks[1]
    assert reasoning_block.type == "reasoning"
    assert reasoning_block.text == "I should inspect the repository first."
    assert reasoning_block.metadata["anthropic"] == {
        "type": "thinking",
        "thinking": "I should inspect the repository first.",
        "signature": "sig_123",
    }
    assert text_block.type == "text"
    assert text_block.text == "I will inspect the repository."
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/infrastructure/models/test_anthropic_messages_adapter.py::test_anthropic_adapter_maps_tool_use_to_runtime_tool_call tests/unit/infrastructure/models/test_anthropic_messages_adapter.py::test_anthropic_adapter_maps_thinking_to_reasoning_block -q
```

Expected:

```text
FAILED
```

- [ ] **Step 4: Update response mapping**

Ensure `_to_turn_result` has the exact handling shown in Task 3 Step 6 for `tool_use` and `thinking`.

If the existing code already matches, only run the tests. Do not rewrite working code.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
uv run pytest tests/unit/infrastructure/models/test_anthropic_messages_adapter.py -q
```

Expected:

```text
passed
```

- [ ] **Step 6: Commit response mapping**

Run:

```bash
git add src/mycli/infrastructure/models/anthropic_messages_adapter.py tests/unit/infrastructure/models/test_anthropic_messages_adapter.py
git commit -m "Map Anthropic tool and thinking blocks" -m "Anthropic tool_use blocks become native runtime tool calls and thinking blocks become reasoning blocks so the existing agent loop can display progress and execute tools."
```

---

### Task 5: Add Anthropic SDK Client

**Files:**
- Create: `src/mycli/infrastructure/anthropic_messages_client.py`
- Create: `tests/unit/infrastructure/test_anthropic_messages_client.py`

- [ ] **Step 1: Write fake SDK tests for request construction**

Create `tests/unit/infrastructure/test_anthropic_messages_client.py`:

```python
from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.runtime import ReasoningEffort
from mycli.infrastructure.anthropic_messages_client import AnthropicMessagesClient
from mycli.services.workspace_log_service import WorkspaceLogService


class FakeMessagesResource:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload
        self.kwargs: dict[str, object] = {}

    def create(self, **kwargs: object) -> dict[str, object]:
        self.kwargs = dict(kwargs)
        return self.payload


class FakeAnthropicSdkClient:
    def __init__(self, payload: dict[str, object]) -> None:
        self.messages = FakeMessagesResource(payload)


def test_anthropic_client_builds_messages_request_with_thinking(
    tmp_path: Path,
) -> None:
    sdk_client = FakeAnthropicSdkClient(
        {
            "id": "msg_1",
            "role": "assistant",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
        }
    )
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=4096,
        log_service=WorkspaceLogService(workspace_root=tmp_path),
        sdk_client=sdk_client,
    )
    client.set_thinking_config(enabled=True, effort=ReasoningEffort.MEDIUM)

    payload = client.create_message(
        system="System rules.",
        messages=[{"role": "user", "content": [{"type": "text", "text": "Hi"}]}],
        tools=[{"name": "read_file", "description": "Read", "input_schema": {"type": "object"}}],
    )

    assert payload["id"] == "msg_1"
    assert sdk_client.messages.kwargs["model"] == "claude-sonnet-4-6"
    assert sdk_client.messages.kwargs["system"] == "System rules."
    assert sdk_client.messages.kwargs["max_tokens"] == 4096
    assert sdk_client.messages.kwargs["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "Hi"}]}
    ]
    assert sdk_client.messages.kwargs["tools"] == [
        {"name": "read_file", "description": "Read", "input_schema": {"type": "object"}}
    ]
    assert sdk_client.messages.kwargs["thinking"] == {
        "type": "enabled",
        "budget_tokens": 1536,
    }
```

- [ ] **Step 2: Add thinking disabled and low max token tests**

Append:

```python
def test_anthropic_client_omits_thinking_when_disabled(tmp_path: Path) -> None:
    sdk_client = FakeAnthropicSdkClient(
        {
            "id": "msg_2",
            "role": "assistant",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
        }
    )
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=2048,
        log_service=WorkspaceLogService(workspace_root=tmp_path),
        sdk_client=sdk_client,
    )
    client.set_thinking_config(enabled=False, effort=None)

    client.create_message(system=None, messages=[], tools=[])

    assert "thinking" not in sdk_client.messages.kwargs


def test_anthropic_client_rejects_thinking_budget_that_exceeds_max_tokens(
    tmp_path: Path,
) -> None:
    sdk_client = FakeAnthropicSdkClient(
        {
            "id": "msg_3",
            "role": "assistant",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
        }
    )
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=1024,
        log_service=WorkspaceLogService(workspace_root=tmp_path),
        sdk_client=sdk_client,
    )
    client.set_thinking_config(enabled=True, effort=ReasoningEffort.MEDIUM)

    try:
        client.create_message(system=None, messages=[], tools=[])
    except Exception as exc:
        assert "thinking budget" in str(exc)
    else:
        raise AssertionError("Expected thinking budget validation error")
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_anthropic_messages_client.py -q
```

Expected:

```text
FAILED ... ModuleNotFoundError: No module named 'mycli.infrastructure.anthropic_messages_client'
```

- [ ] **Step 4: Implement SDK client shell and payload serialization**

Create `src/mycli/infrastructure/anthropic_messages_client.py`:

```python
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from anthropic import Anthropic, APIConnectionError, APIStatusError, APITimeoutError

from mycli.domain.logging import LogLevel, ModelLogContext, ModelLogEvent
from mycli.domain.runtime import StopReason
from mycli.infrastructure.openai_client import ModelResponseError
from mycli.infrastructure.ssl import ensure_certifi_ca_bundle
from mycli.services.workspace_log_service import WorkspaceLogService

DEFAULT_ANTHROPIC_SDK_TIMEOUT_SECONDS = 60.0


def _payload_to_dict(payload: object) -> dict[str, object]:
    if isinstance(payload, dict):
        return dict(payload)
    for attr in ("to_dict", "model_dump", "dict"):
        serializer = getattr(payload, attr, None)
        if callable(serializer):
            serialized = serializer()
            if isinstance(serialized, dict):
                return dict(serialized)
    raise TypeError("Anthropic SDK payload must serialize to a dictionary.")
```

Add class constructor:

```python
class AnthropicMessagesClient:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        max_output_tokens: int,
        log_service: WorkspaceLogService | None = None,
        log_context_provider: Callable[[], ModelLogContext] | None = None,
        sdk_client: object | None = None,
    ) -> None:
        ensure_certifi_ca_bundle()
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._max_output_tokens = max_output_tokens
        self._log_service = log_service
        self._log_context_provider = log_context_provider
        self._thinking_enabled = True
        self._thinking_effort: str | None = None
        self._sdk_client = sdk_client or Anthropic(
            api_key=api_key,
            base_url=base_url,
            timeout=DEFAULT_ANTHROPIC_SDK_TIMEOUT_SECONDS,
            max_retries=0,
        )
```

- [ ] **Step 5: Implement thinking config and request creation**

Add:

```python
    def set_log_context_provider(
        self,
        provider: Callable[[], ModelLogContext],
    ) -> None:
        self._log_context_provider = provider

    def set_thinking_config(self, *, enabled: bool, effort: object) -> None:
        self._thinking_enabled = enabled
        value = getattr(effort, "value", effort)
        self._thinking_effort = str(value) if enabled and value is not None else None

    def _thinking_budget_tokens(self) -> int:
        effort = self._thinking_effort or "medium"
        budgets = {
            "low": 1024,
            "medium": 1536,
            "high": 4096,
            "xhigh": 8192,
        }
        return budgets.get(effort, 1536)

    def _thinking_payload(self) -> dict[str, object] | None:
        if not self._thinking_enabled:
            return None
        budget = self._thinking_budget_tokens()
        if budget >= self._max_output_tokens:
            raise ModelResponseError(
                (
                    "Anthropic thinking budget must be lower than max_output_tokens "
                    f"(budget={budget}, max_output_tokens={self._max_output_tokens})."
                ),
                stop_reason=StopReason.MODEL_ERROR,
                failure_kind="invalid_provider_config",
            )
        return {"type": "enabled", "budget_tokens": budget}

    def create_message(
        self,
        *,
        system: str | None,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        payload_body: dict[str, object] = {
            "model": self._model,
            "max_tokens": self._max_output_tokens,
            "messages": messages,
        }
        if system is not None:
            payload_body["system"] = system
        if tools:
            payload_body["tools"] = tools
        thinking = self._thinking_payload()
        if thinking is not None:
            payload_body["thinking"] = thinking
        self._log_request(payload_body)
        try:
            payload = _payload_to_dict(self._sdk_client.messages.create(**payload_body))  # type: ignore[attr-defined]
        except APIStatusError as exc:
            raise self._status_error(exc) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            raise ModelResponseError(
                f"Failed to reach Anthropic provider: {exc}",
                stop_reason=StopReason.MODEL_ERROR,
                is_retryable=True,
                failure_kind="provider_connection_error",
            ) from exc
        except TypeError as exc:
            raise ModelResponseError(
                "Anthropic provider response did not serialize to a JSON object.",
                stop_reason=StopReason.MODEL_ERROR,
                failure_kind="provider_response_parse_error",
            ) from exc
        self._log_response(payload)
        return payload
```

- [ ] **Step 6: Implement logging and status errors**

Add:

```python
    def _status_error(self, exc: APIStatusError) -> ModelResponseError:
        return ModelResponseError(
            f"Anthropic provider returned HTTP {exc.status_code}: {exc}",
            stop_reason=StopReason.MODEL_ERROR,
            is_retryable=exc.status_code >= 500 or exc.status_code == 429,
            failure_kind="provider_error",
        )

    def _log_request(self, payload_body: dict[str, object]) -> None:
        if self._log_service is None:
            return
        context = self._current_log_context()
        self._log_service.write_raw_model_payload(
            session_id=context.session_id,
            turn_id=context.turn_id,
            provider="anthropic",
            protocol="anthropic_messages",
            model=self._model,
            direction="request",
            payload=payload_body,
        )
        self._log_model_event("anthropic_messages_request", LogLevel.INFO)

    def _log_response(self, payload: dict[str, object]) -> None:
        if self._log_service is None:
            return
        context = self._current_log_context()
        self._log_service.write_raw_model_payload(
            session_id=context.session_id,
            turn_id=context.turn_id,
            provider="anthropic",
            protocol="anthropic_messages",
            model=self._model,
            direction="response",
            payload=payload,
        )
        self._log_model_event("anthropic_messages_response", LogLevel.INFO)

    def _log_model_event(self, event: str, level: LogLevel) -> None:
        if self._log_service is None:
            return
        context = self._current_log_context()
        self._log_service.log_model_event(
            ModelLogEvent(
                timestamp="",
                level=level,
                event=event,
                message=event,
                session_id=context.session_id,
                turn_id=context.turn_id,
                provider="anthropic",
                protocol="anthropic_messages",
                model=self._model,
                path=None,
            )
        )

    def _current_log_context(self) -> ModelLogContext:
        if self._log_context_provider is None:
            return ModelLogContext(session_id="default", turn_id="unknown")
        return self._log_context_provider()
```

Before using `WorkspaceLogService.write_raw_model_payload`, inspect its current signature and adapt parameter names exactly. Do not change `WorkspaceLogService` unless the current signature cannot represent provider/protocol/model/direction.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_anthropic_messages_client.py -q
uv run mypy src/mycli/infrastructure/anthropic_messages_client.py
```

Expected:

```text
passed
Success: no issues found
```

- [ ] **Step 8: Commit SDK client**

Run:

```bash
git add src/mycli/infrastructure/anthropic_messages_client.py tests/unit/infrastructure/test_anthropic_messages_client.py
git commit -m "Wrap the Anthropic Messages SDK" -m "The Anthropic client owns SDK construction, request logging, thinking budget validation, and provider error translation while exposing a small create_message interface to the model adapter."
```

---

### Task 6: Wire Anthropic Into CLI Runtime Construction

**Files:**
- Modify: `src/mycli/cli/main.py`
- Modify: `src/mycli/infrastructure/models/__init__.py`
- Modify: `tests/integration/test_cli_repl.py`

- [ ] **Step 1: Write failing runtime selection test**

Modify imports in `tests/integration/test_cli_repl.py`:

```python
from mycli.infrastructure.models.anthropic_messages_adapter import (
    AnthropicMessagesModelAdapter,
)
```

Add:

```python
def test_build_turn_service_uses_anthropic_messages_adapter(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = build_turn_service(
        cli_args={"session": "anthropic-demo"},
        cwd=workspace,
        home=home_dir,
        env={
            "MYCLI_API_KEY": "test-key",
            "MYCLI_PROVIDER": "anthropic",
        },
    )

    assert service._config.provider is ProviderId.ANTHROPIC
    assert service._config.protocol is ProtocolId.ANTHROPIC_MESSAGES
    assert service._config.model == "claude-sonnet-4-6"
    assert isinstance(service._runtime._model_adapter, AnthropicMessagesModelAdapter)
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
uv run pytest tests/integration/test_cli_repl.py::test_build_turn_service_uses_anthropic_messages_adapter -q
```

Expected:

```text
FAILED
```

- [ ] **Step 3: Export model adapter**

Modify `src/mycli/infrastructure/models/__init__.py`:

```python
from mycli.infrastructure.models.anthropic_messages_adapter import (
    AnthropicMessagesModelAdapter,
)
```

Add `"AnthropicMessagesModelAdapter"` to `__all__`.

- [ ] **Step 4: Wire CLI branch**

Modify `src/mycli/cli/main.py` imports:

```python
from mycli.infrastructure.anthropic_messages_client import AnthropicMessagesClient
from mycli.infrastructure.models.anthropic_messages_adapter import (
    AnthropicMessagesModelAdapter,
)
```

Update `build_turn_service`:

```python
    if config.protocol is ProtocolId.ANTHROPIC_MESSAGES:
        anthropic_client = AnthropicMessagesClient(
            api_key=config.api_key,
            base_url=config.api_base_url,
            model=config.model,
            max_output_tokens=config.max_output_tokens,
            log_service=workspace_log_service,
        )
        model_adapter = cast(
            ModelAdapter,
            AnthropicMessagesModelAdapter(client=anthropic_client),
        )
    elif config.protocol is ProtocolId.CHAT_COMPLETIONS:
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

Keep `provider_adapter = chat_adapter_for_provider(config.provider)` before this branch or move it into the chat-completions branch. Moving it into the chat-completions branch is cleaner because Anthropic does not use `ChatProviderAdapter`.

- [ ] **Step 5: Run targeted test**

Run:

```bash
uv run pytest tests/integration/test_cli_repl.py::test_build_turn_service_uses_anthropic_messages_adapter -q
```

Expected:

```text
passed
```

- [ ] **Step 6: Run CLI integration file**

Run:

```bash
uv run pytest tests/integration/test_cli_repl.py -q
```

Expected:

```text
passed
```

- [ ] **Step 7: Commit runtime wiring**

Run:

```bash
git add src/mycli/cli/main.py src/mycli/infrastructure/models/__init__.py tests/integration/test_cli_repl.py
git commit -m "Route Anthropic config to the Messages adapter" -m "The CLI service builder now selects AnthropicMessagesModelAdapter for ProtocolId.ANTHROPIC_MESSAGES while preserving existing Responses and chat-completions branches."
```

---

### Task 7: Verify Full Tool-Call Round Trip With The Runtime Boundary

**Files:**
- Modify: `tests/unit/infrastructure/models/test_anthropic_messages_adapter.py`

- [ ] **Step 1: Add adapter round-trip test**

Append:

```python
def test_anthropic_adapter_round_trips_tool_call_and_result() -> None:
    client = FakeAnthropicMessagesClient(
        {
            "id": "msg_tool_result",
            "role": "assistant",
            "content": [{"type": "text", "text": "README content received."}],
            "stop_reason": "end_turn",
        }
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    first_result = adapter.next_turn(
        items=[
            RuntimeItem(
                role="user",
                blocks=(RuntimeBlock(type="text", text="Read README.md"),),
            )
        ],
        tools=[
            ModelToolDefinition(
                name="read_file",
                description="Read a file",
                parameters=(
                    ModelToolParameter(name="path", type="string", required=True),
                ),
            )
        ],
    )

    assert first_result.done is True

    adapter.next_turn(
        items=[
            RuntimeItem(
                role="assistant",
                blocks=(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name="read_file",
                        tool_arguments={"path": "README.md"},
                        call_id="toolu_readme",
                    ),
                ),
            ),
            RuntimeItem(
                role="tool",
                blocks=(
                    RuntimeBlock(
                        type="tool_result",
                        text="README.md says hello",
                        call_id="toolu_readme",
                    ),
                ),
            ),
        ],
        tools=[],
    )

    assert client.captured_messages[-2:] == [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_readme",
                    "name": "read_file",
                    "input": {"path": "README.md"},
                }
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_readme",
                    "content": "README.md says hello",
                }
            ],
        },
    ]
```

- [ ] **Step 2: Run targeted test**

Run:

```bash
uv run pytest tests/unit/infrastructure/models/test_anthropic_messages_adapter.py::test_anthropic_adapter_round_trips_tool_call_and_result -q
```

Expected:

```text
passed
```

- [ ] **Step 3: Run adapter tests**

Run:

```bash
uv run pytest tests/unit/infrastructure/models/test_anthropic_messages_adapter.py -q
```

Expected:

```text
passed
```

- [ ] **Step 4: Commit round-trip coverage**

Run:

```bash
git add tests/unit/infrastructure/models/test_anthropic_messages_adapter.py
git commit -m "Cover Anthropic tool result replay" -m "The adapter test now proves prior Anthropic tool_use blocks and mycli tool results replay into the next Messages request shape."
```

---

### Task 8: Run Full Verification And Fix Strict Typing Issues

**Files:**
- Modify files reported by `mypy`, `ruff`, or failing tests.

- [ ] **Step 1: Run mypy**

Run:

```bash
uv run mypy src
```

Expected:

```text
Success: no issues found
```

If mypy reports an error in `AnthropicMessagesModelAdapter.next_action` caused by runtime role narrowing, replace the list comprehension with this explicit loop:

```python
runtime_items: list[RuntimeItem] = []
for message in messages:
    runtime_item = self._runtime_item_from_model_message(message)
    if runtime_item is not None:
        runtime_items.append(runtime_item)
```

- [ ] **Step 2: Run ruff**

Run:

```bash
uv run ruff check src tests
```

Expected:

```text
All checks passed!
```

If ruff reports import sorting issues, run:

```bash
uv run ruff check src tests --fix
```

Then rerun:

```bash
uv run ruff check src tests
```

- [ ] **Step 3: Run full pytest**

Run:

```bash
uv run pytest -q
```

Expected:

```text
passed
```

- [ ] **Step 4: Inspect git status**

Run:

```bash
git status --short
```

Expected output contains only intentional Anthropic provider changes.

- [ ] **Step 5: Commit verification fixes**

If Step 1, Step 2, or Step 3 required code changes, run:

```bash
git add src tests
git commit -m "Stabilize Anthropic provider verification" -m "Strict typing, linting, and full unit coverage now pass for the Anthropic provider implementation."
```

If Step 1, Step 2, and Step 3 passed without changes, do not create an empty commit.

---

### Task 9: Document Local Anthropic Configuration

**Files:**
- Modify: `README.md`
- Test: no code test; verify docs do not include real API keys.

- [ ] **Step 1: Add README configuration example**

Add this section to `README.md`:

```markdown
## Anthropic Provider

Configure Anthropic with the native Messages protocol:

```toml
provider = "anthropic"
protocol = "anthropic_messages"
model = "claude-sonnet-4-6"
api_key = "your-anthropic-api-key"
thinking_enabled = true
thinking_effort = "medium"
```

Environment variable equivalents:

```bash
export MYCLI_PROVIDER=anthropic
export MYCLI_PROTOCOL=anthropic_messages
export MYCLI_MODEL=claude-sonnet-4-6
export MYCLI_API_KEY=your-anthropic-api-key
export MYCLI_THINKING_ENABLED=true
export MYCLI_THINKING_EFFORT=medium
```

Do not commit `.mycli/config.toml`, `~/.config/mycli/config.toml`, or raw model logs.
```

- [ ] **Step 2: Scan docs for real-looking secrets**

Run:

```bash
rg -n "sk-ant-|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-|AKIA[0-9A-Z]{16}" README.md docs/superpowers -g '*.md' || true
```

Expected:

```text
no output
```

- [ ] **Step 3: Commit docs**

Run:

```bash
git add README.md
git commit -m "Document Anthropic provider configuration" -m "The README now shows how to select the native Anthropic Messages provider without including real credentials."
```

---

### Task 10: Final Verification Checkpoint

**Files:**
- No planned file edits.

- [ ] **Step 1: Run final verification commands**

Run:

```bash
uv run mypy src
uv run ruff check src tests
uv run pytest -q
```

Expected:

```text
Success: no issues found
All checks passed!
passed
```

- [ ] **Step 2: Confirm raw logs and local config are not staged**

Run:

```bash
git status --short --ignored | rg "(\\.mycli/|^log/|model-raw|evaluation/runs|\\.DS_Store)" || true
```

Expected output may show ignored files with `!!`; it must not show staged or unstaged tracked changes for local config or raw logs.

- [ ] **Step 3: Review commit history**

Run:

```bash
git log --oneline -8
```

Expected: recent commits include dependency, registry, adapter, client, runtime wiring, docs, and verification commits.

---

## Self-Review

Spec coverage:

- Provider/protocol model: Task 2.
- Official SDK dependency: Task 1 and Task 5.
- Runtime integration through `ModelAdapter -> ModelTurnResult`: Task 3, Task 4, Task 6, Task 7.
- System/developer merge: Task 3.
- Tool schema, `tool_use`, and `tool_result`: Task 3, Task 4, Task 7.
- Thinking config and output mapping: Task 4 and Task 5.
- Error handling and logging: Task 5.
- Config examples and secret hygiene: Task 9.
- Verification commands: Task 8 and Task 10.

Placeholder scan:

- No placeholder markers or unspecified test-writing steps are intentionally present.
- Every new module has concrete tests before implementation steps.

Type consistency:

- Provider enum names match the spec: `ProviderId.ANTHROPIC`, `ProtocolId.ANTHROPIC_MESSAGES`.
- Adapter name is consistent: `AnthropicMessagesModelAdapter`.
- Client name is consistent: `AnthropicMessagesClient`.
- Protocol string is consistent: `anthropic_messages`.
- Default model string is consistent: `claude-sonnet-4-6`.

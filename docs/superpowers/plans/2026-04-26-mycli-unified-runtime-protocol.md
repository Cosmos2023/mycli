# MyCLI Unified Runtime Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a provider-agnostic internal runtime protocol so OpenAI Responses, chat completions, and future providers all normalize into the same `mycli` event stream and transcript model before the runtime consumes them, with a unified thinking-mode and thinking-effort control surface.

**Architecture:** Keep `RuntimeItem` and `RuntimeBlock` as the canonical transcript format, then introduce a new internal event layer for model output. Provider-specific transports will translate wire payloads into `ModelEvent` objects, and a shared turn aggregator will convert those events into `ModelTurnResult`, so `MCP`, `skill`, native tools, and future providers all share one tool-call lifecycle. Normalize thinking controls as `thinking_enabled` plus `thinking_effort`, then let each transport map those settings into provider-specific request fields only when the provider supports them.

**Tech Stack:** Python 3.13, standard library `dataclasses` and `enum`, existing OpenAI SDK wrappers, `pytest`, `ruff`, `mypy`

---

## Scope Check

This is one subsystem plan: internal runtime protocol normalization. It is the foundation for later provider work such as DeepSeek and Anthropic. It still stops short of changing user-facing provider selection, but it now explicitly includes normalized thinking controls so “turn on thinking and set effort” becomes a runtime-level concept instead of a provider-specific quirk. The runtime should behave the same after this plan, while the transport layer becomes cleaner and more extensible.

## File Structure

- Create: `src/mycli/domain/model_events.py`
  Responsibility: define the provider-agnostic model event contract, including event types and unified tool execution sources.
- Create: `src/mycli/infrastructure/models/turn_event_aggregator.py`
  Responsibility: aggregate provider-normalized `ModelEvent` sequences into `ModelTurnResult`.
- Create: `src/mycli/schemas/responses_wire_protocol.py`
  Responsibility: keep OpenAI Responses wire-format parsing in one provider-specific place, instead of mixing it with runtime-facing protocol concepts.
- Modify: `src/mycli/domain/runtime/__init__.py`
  Responsibility: add normalized thinking configuration fields to `AgentConfig` without tying them to any single provider protocol.
- Modify: `src/mycli/domain/runtime/blocks.py`
  Responsibility: make transcript blocks explicitly capable of tracking unified tool sources without introducing provider-specific branching.
- Modify: `src/mycli/services/config_service.py`
  Responsibility: parse unified thinking settings such as `thinking_enabled` and `thinking_effort`, while preserving compatibility with existing reasoning-effort inputs.
- Modify: `src/mycli/application/runtime/agent_runtime.py`
  Responsibility: push normalized thinking configuration into model adapters through one transport-agnostic interface.
- Modify: `src/mycli/infrastructure/models/base.py`
  Responsibility: export the new event contract and the shared adapter/transport interfaces.
- Modify: `src/mycli/schemas/responses_protocol.py`
  Responsibility: keep only Responses transport capabilities and continuation state here.
- Modify: `src/mycli/infrastructure/openai_responses_client.py`
  Responsibility: translate Responses wire items and stream events into provider-agnostic `ModelEvent` values and map normalized thinking settings into Responses request fields.
- Modify: `src/mycli/infrastructure/responses_request_builder.py`
  Responsibility: emit Responses reasoning payload only when normalized thinking is enabled.
- Modify: `src/mycli/infrastructure/models/responses_adapter.py`
  Responsibility: replace direct Responses-item parsing with the shared event aggregator.
- Modify: `src/mycli/infrastructure/openai_client.py`
  Responsibility: normalize chat-completions output into the same internal event protocol used by Responses and map normalized thinking settings only when supported by the target provider.
- Modify: `src/mycli/infrastructure/models/native_tool_adapter.py`
  Responsibility: consume shared `ModelEvent` aggregation rather than maintaining a protocol-specific shape.
- Modify: `tests/unit/infrastructure/models/test_responses_adapter.py`
  Responsibility: lock down the new event-to-turn aggregation path for Responses.
- Modify: `tests/unit/infrastructure/test_openai_responses_client.py`
  Responsibility: verify Responses payloads become the right `ModelEvent` sequence.
- Modify: `tests/unit/infrastructure/test_openai_client.py`
  Responsibility: verify chat-completions payloads become the same internal event sequence.
- Modify: `tests/unit/services/test_config_service.py`
  Responsibility: verify thinking-mode and thinking-effort configuration resolution.
- Create: `tests/unit/domain/test_model_events.py`
  Responsibility: validate the new event contract and source semantics for native tools, MCP, and skills.
- Create: `tests/unit/infrastructure/models/test_turn_event_aggregator.py`
  Responsibility: verify that a provider-agnostic event stream becomes the expected `ModelTurnResult`.
- Modify: `README.md`
  Responsibility: document the new internal architecture boundary and clarify that provider wire protocols are normalized before runtime consumption.

## Task 1: Define the Provider-Agnostic Event Contract

**Files:**
- Create: `src/mycli/domain/model_events.py`
- Modify: `src/mycli/domain/runtime/blocks.py`
- Modify: `src/mycli/infrastructure/models/base.py`
- Test: `tests/unit/domain/test_model_events.py`

- [ ] **Step 1: Write the failing domain-contract tests**

Add these tests to `tests/unit/domain/test_model_events.py`:

```python
from __future__ import annotations

import pytest

from mycli.domain.model_events import ModelEvent, ModelEventType, ToolExecutionSource


def test_model_event_supports_unified_tool_sources_for_native_mcp_and_skill() -> None:
    native_event = ModelEvent.tool_call_requested(
        tool_name="read_file",
        tool_arguments={"path": "README.md"},
        call_id="call_native_1",
        source=ToolExecutionSource.NATIVE,
    )
    mcp_event = ModelEvent.tool_call_requested(
        tool_name="fetch_docs",
        tool_arguments={"topic": "responses"},
        call_id="call_mcp_1",
        source=ToolExecutionSource.MCP,
    )
    skill_event = ModelEvent.tool_call_requested(
        tool_name="writing-plans",
        tool_arguments={"topic": "protocol"},
        call_id="call_skill_1",
        source=ToolExecutionSource.SKILL,
    )

    assert native_event.source is ToolExecutionSource.NATIVE
    assert mcp_event.source is ToolExecutionSource.MCP
    assert skill_event.source is ToolExecutionSource.SKILL


def test_model_event_requires_tool_fields_for_tool_call_requested() -> None:
    with pytest.raises(ValueError, match="tool_name"):
        ModelEvent(type=ModelEventType.TOOL_CALL_REQUESTED, call_id="call_missing_name")

    with pytest.raises(ValueError, match="call_id"):
        ModelEvent(type=ModelEventType.TOOL_CALL_REQUESTED, tool_name="read_file")


def test_runtime_block_tracks_unified_tool_source() -> None:
    from mycli.domain.runtime.blocks import RuntimeBlock

    block = RuntimeBlock(
        type="tool_call",
        tool_name="fetch_docs",
        tool_arguments={"topic": "mcp"},
        call_id="call_mcp_1",
        source="mcp",
    )

    assert block.source == "mcp"
```

- [ ] **Step 2: Run the domain tests to verify the new protocol does not exist yet**

Run: `uv run pytest tests/unit/domain/test_model_events.py -v`

Expected: `FAIL` because `mycli.domain.model_events` does not exist and `RuntimeBlock` does not yet expose `source`.

- [ ] **Step 3: Implement the event contract and transcript source field**

Create `src/mycli/domain/model_events.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from mycli.domain.runtime.blocks import RuntimeRole


class ModelEventType(StrEnum):
    MESSAGE_DELTA = "message_delta"
    MESSAGE_COMPLETED = "message_completed"
    REASONING_DELTA = "reasoning_delta"
    TOOL_CALL_REQUESTED = "tool_call_requested"
    TOOL_ARGUMENTS_DELTA = "tool_arguments_delta"
    TOOL_RESULT_SUBMITTED = "tool_result_submitted"
    TURN_COMPLETED = "turn_completed"
    TURN_FAILED = "turn_failed"


class ToolExecutionSource(StrEnum):
    PROVIDER = "provider"
    NATIVE = "native"
    MCP = "mcp"
    SKILL = "skill"
    PROVIDER_BUILTIN = "provider_builtin"


@dataclass(slots=True, frozen=True)
class ModelEvent:
    type: ModelEventType
    role: RuntimeRole | None = None
    text: str | None = None
    tool_name: str | None = None
    tool_arguments: dict[str, object] | None = None
    tool_arguments_text: str | None = None
    call_id: str | None = None
    provider_id: str | None = None
    source: ToolExecutionSource | None = None
    response_id: str | None = None
    error_message: str | None = None
    usage: dict[str, object] | None = None
    metadata: dict[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.type is ModelEventType.TOOL_CALL_REQUESTED:
            if not self.tool_name:
                raise ValueError("tool_call_requested event requires tool_name")
            if not self.call_id:
                raise ValueError("tool_call_requested event requires call_id")
        if self.type is ModelEventType.MESSAGE_DELTA and not self.text:
            raise ValueError("message_delta event requires text")
        if self.type is ModelEventType.REASONING_DELTA and not self.text:
            raise ValueError("reasoning_delta event requires text")

    @classmethod
    def message_delta(
        cls,
        *,
        text: str,
        role: RuntimeRole = "assistant",
        provider_id: str | None = None,
    ) -> "ModelEvent":
        return cls(
            type=ModelEventType.MESSAGE_DELTA,
            role=role,
            text=text,
            provider_id=provider_id,
        )

    @classmethod
    def tool_call_requested(
        cls,
        *,
        tool_name: str,
        tool_arguments: dict[str, object],
        call_id: str,
        source: ToolExecutionSource,
        provider_id: str | None = None,
    ) -> "ModelEvent":
        return cls(
            type=ModelEventType.TOOL_CALL_REQUESTED,
            tool_name=tool_name,
            tool_arguments=tool_arguments,
            call_id=call_id,
            source=source,
            provider_id=provider_id,
        )
```

Update `src/mycli/domain/runtime/blocks.py`:

```python
from typing import Literal

BlockType = Literal["text", "tool_call", "tool_result", "reasoning"]
RuntimeRole = Literal["system", "developer", "user", "assistant", "tool"]
ToolSource = Literal["provider", "native", "mcp", "skill", "provider_builtin"]


@dataclass(slots=True, frozen=True)
class RuntimeBlock:
    type: BlockType
    text: str | None = None
    tool_name: str | None = None
    tool_arguments: dict[str, object] | None = None
    call_id: str | None = None
    provider_id: str | None = None
    source: ToolSource | None = None
    metadata: dict[str, object] = field(default_factory=dict)
```

Update `src/mycli/infrastructure/models/base.py` exports:

```python
from mycli.domain.model_events import (
    ModelEvent,
    ModelEventType,
    ToolExecutionSource,
)

__all__ = [
    "BlockType",
    "ModelAction",
    "ModelAdapter",
    "ModelEvent",
    "ModelEventType",
    "ModelMessage",
    "ModelToolDefinition",
    "ModelToolParameter",
    "ModelTurnResult",
    "RuntimeBlock",
    "RuntimeItem",
    "RuntimeRole",
    "ToolExecutionSource",
]
```

- [ ] **Step 4: Run the domain tests to verify the new contract passes**

Run: `uv run pytest tests/unit/domain/test_model_events.py -v`

Expected: `PASS`

- [ ] **Step 5: Commit the protocol contract work**

Run:

```bash
git add tests/unit/domain/test_model_events.py src/mycli/domain/model_events.py src/mycli/domain/runtime/blocks.py src/mycli/infrastructure/models/base.py
git commit -F - <<'EOF'
Establish a provider-agnostic runtime event contract

Introduce a small internal event model for message deltas, reasoning,
tool calls, and turn completion while keeping RuntimeItem and
RuntimeBlock as the stable transcript contract.

Constraint: Must preserve existing runtime transcript semantics
Rejected: Make Responses wire items the canonical internal protocol | locks runtime to one provider
Confidence: high
Scope-risk: moderate
Reversibility: clean
Directive: New provider transports must normalize into ModelEvent before touching runtime-facing code
Tested: uv run pytest tests/unit/domain/test_model_events.py -v
Not-tested: Live provider integration
EOF
```

## Task 2: Add a Shared Turn Event Aggregator

**Files:**
- Create: `src/mycli/infrastructure/models/turn_event_aggregator.py`
- Create: `tests/unit/infrastructure/models/test_turn_event_aggregator.py`
- Modify: `src/mycli/infrastructure/models/base.py`

- [ ] **Step 1: Write the failing aggregator tests**

Add these tests to `tests/unit/infrastructure/models/test_turn_event_aggregator.py`:

```python
from __future__ import annotations

from mycli.domain.model_events import ModelEvent, ModelEventType, ToolExecutionSource
from mycli.infrastructure.models.turn_event_aggregator import TurnEventAggregator


def test_turn_event_aggregator_builds_model_turn_result_from_mixed_events() -> None:
    aggregator = TurnEventAggregator()

    result = aggregator.collect(
        [
            ModelEvent(type=ModelEventType.REASONING_DELTA, text="Inspecting tool options"),
            ModelEvent.message_delta(text="I will inspect the repository."),
            ModelEvent.tool_call_requested(
                tool_name="list_directory",
                tool_arguments={"path": "."},
                call_id="call_001",
                source=ToolExecutionSource.NATIVE,
                provider_id="fc_001",
            ),
            ModelEvent(type=ModelEventType.TURN_COMPLETED, response_id="resp_123"),
        ]
    )

    assert result.response_id == "resp_123"
    assert result.done is False
    assert result.items[0].blocks[0].type == "reasoning"
    assert result.items[0].blocks[1].type == "text"
    assert result.items[0].blocks[2].type == "tool_call"
    assert result.items[0].blocks[2].source == "native"


def test_turn_event_aggregator_marks_turn_done_when_no_tool_call_requested() -> None:
    aggregator = TurnEventAggregator()

    result = aggregator.collect(
        [
            ModelEvent.message_delta(text="Done."),
            ModelEvent(type=ModelEventType.TURN_COMPLETED, response_id="resp_done"),
        ]
    )

    assert result.done is True
    assert result.items[0].blocks[0].text == "Done."
```

- [ ] **Step 2: Run the aggregator tests to verify the aggregator does not exist yet**

Run: `uv run pytest tests/unit/infrastructure/models/test_turn_event_aggregator.py -v`

Expected: `FAIL` because `TurnEventAggregator` is not defined.

- [ ] **Step 3: Implement the shared aggregator**

Create `src/mycli/infrastructure/models/turn_event_aggregator.py`:

```python
from __future__ import annotations

from collections.abc import Iterable

from mycli.domain.model_events import ModelEvent, ModelEventType
from mycli.domain.runtime.blocks import ModelTurnResult, RuntimeBlock, RuntimeItem
from mycli.infrastructure.openai_client import ModelResponseError


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
                    )
                )
                continue
            if event.type is ModelEventType.MESSAGE_DELTA:
                blocks.append(
                    RuntimeBlock(
                        type="text",
                        text=event.text,
                        provider_id=event.provider_id,
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
```

Update `src/mycli/infrastructure/models/base.py` with the aggregator-facing protocol:

```python
from collections.abc import Iterator
from typing import Protocol

from mycli.domain.model_events import ModelEvent


class EventProducingModelClient(Protocol):
    def create_events(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> list[ModelEvent]:
        ...

    def stream_events(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> Iterator[ModelEvent]:
        ...
```

- [ ] **Step 4: Run the aggregator tests to verify the shared collector passes**

Run: `uv run pytest tests/unit/infrastructure/models/test_turn_event_aggregator.py -v`

Expected: `PASS`

- [ ] **Step 5: Commit the shared aggregation layer**

Run:

```bash
git add tests/unit/infrastructure/models/test_turn_event_aggregator.py src/mycli/infrastructure/models/turn_event_aggregator.py src/mycli/infrastructure/models/base.py
git commit -F - <<'EOF'
Add a shared aggregator for provider-normalized model events

Introduce TurnEventAggregator so transport-specific clients can emit one
internal event protocol while the runtime continues to consume
ModelTurnResult and RuntimeBlock values.

Constraint: AgentRuntime should not need provider-specific event parsing
Rejected: Push event parsing into AgentRuntime | leaks transport details upward
Confidence: high
Scope-risk: moderate
Reversibility: clean
Directive: Keep transport-specific wire parsing below the aggregator boundary
Tested: uv run pytest tests/unit/infrastructure/models/test_turn_event_aggregator.py -v
Not-tested: Streaming backpressure behavior
EOF
```

## Task 3: Normalize Thinking Mode and Thinking Effort

**Files:**
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/services/config_service.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/infrastructure/models/base.py`
- Modify: `src/mycli/infrastructure/openai_responses_client.py`
- Modify: `src/mycli/infrastructure/openai_client.py`
- Modify: `src/mycli/infrastructure/responses_request_builder.py`
- Modify: `tests/unit/services/test_config_service.py`
- Modify: `tests/unit/infrastructure/test_openai_responses_client.py`
- Modify: `tests/unit/infrastructure/test_openai_client.py`

- [ ] **Step 1: Write the failing thinking-config tests**

Add these tests to `tests/unit/services/test_config_service.py`:

```python
def test_resolve_config_enables_thinking_when_explicit_toggle_is_true(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={
            "MYCLI_THINKING_ENABLED": "true",
            "MYCLI_THINKING_EFFORT": "high",
        },
        cwd=workspace,
        home=home_dir,
    )

    assert config.thinking_enabled is True
    assert config.thinking_effort == "high"


def test_resolve_config_maps_legacy_reasoning_effort_to_thinking_effort(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    config = resolve_config(
        cli_args={"session": "demo"},
        env={"MYCLI_REASONING_EFFORT": "medium"},
        cwd=workspace,
        home=home_dir,
    )

    assert config.thinking_enabled is True
    assert config.thinking_effort == "medium"


def test_resolve_config_rejects_thinking_effort_when_thinking_disabled(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    with pytest.raises(ValueError, match="thinking_effort requires thinking_enabled=true"):
        resolve_config(
            cli_args={"session": "demo"},
            env={
                "MYCLI_THINKING_ENABLED": "false",
                "MYCLI_THINKING_EFFORT": "high",
            },
            cwd=workspace,
            home=home_dir,
        )
```

Add this request-builder assertion to `tests/unit/infrastructure/test_openai_responses_client.py`:

```python
def test_openai_responses_client_omits_reasoning_payload_when_thinking_disabled(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(handler=lambda kwargs: {"id": "resp_123", "output": []})
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )
    client.set_thinking_config(enabled=False, effort=None)

    client.create_response(
        input_items=[{"role": "user", "content": "inspect the repo"}],
        tools=[],
    )

    assert "reasoning" not in sdk_client.responses_api.create_calls[-1]
```

Add this compatibility assertion to `tests/unit/infrastructure/test_openai_client.py`:

```python
def test_openai_chat_client_accepts_thinking_config_without_request_failure(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(chat_payload={"choices": [{"message": {"content": "done"}}]})
    monkeypatch.setattr(
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )
    client.set_thinking_config(enabled=True, effort="high")

    payload = client.complete([{"role": "user", "content": "inspect the repo"}])

    assert payload["assistant_message"] == "done"
```

- [ ] **Step 2: Run the thinking-config tests to verify the unified control surface does not exist yet**

Run: `uv run pytest tests/unit/services/test_config_service.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/test_openai_client.py -v`

Expected: `FAIL` because `thinking_enabled`, `thinking_effort`, and `set_thinking_config()` do not exist yet.

- [ ] **Step 3: Add normalized thinking fields to runtime config and transport interfaces**

Update `src/mycli/domain/runtime/__init__.py`:

```python
@dataclass(slots=True, frozen=True)
class AgentConfig:
    workspace_root: Path
    model: str = "gpt-5"
    protocol: str = "responses"
    api_base_url: str = "https://api.openai.com/v1"
    api_key: str | None = None
    session_id: str = "default"
    max_steps: int = 4
    max_prompt_tokens: int = 12000
    max_output_tokens: int = 2048
    reasoning_effort: ReasoningEffort = ReasoningEffort.MEDIUM
    thinking_enabled: bool = True
    thinking_effort: ReasoningEffort | None = ReasoningEffort.MEDIUM
    compression_threshold_tokens: int = 8000
    recent_message_count: int = 6
    auto_approve_medium: bool = True
```

Update `src/mycli/infrastructure/models/base.py`:

```python
from mycli.domain.runtime import ReasoningEffort


class ThinkingConfigurableClient(Protocol):
    def set_thinking_config(
        self,
        *,
        enabled: bool,
        effort: ReasoningEffort | str | None,
    ) -> None:
        ...
```

Update `src/mycli/application/runtime/agent_runtime.py`:

```python
    def _set_model_reasoning_effort(self, reasoning_effort: ReasoningEffort) -> None:
        thinking_setter = getattr(self._model_adapter, "set_thinking_config", None)
        if callable(thinking_setter):
            thinking_setter(enabled=True, effort=reasoning_effort)
            return
        setter = getattr(self._model_adapter, "set_reasoning_effort", None)
        if callable(setter):
            setter(reasoning_effort.value)
```

- [ ] **Step 4: Parse normalized thinking settings and preserve backward compatibility**

Update `src/mycli/services/config_service.py`:

```python
def _parse_optional_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return None


legacy_reasoning_effort = (
    env.get("MYCLI_REASONING_EFFORT")
    or project_config.get("reasoning_effort")
    or user_config.get("reasoning_effort")
)
thinking_enabled = _parse_optional_bool(
    env.get("MYCLI_THINKING_ENABLED")
    or project_config.get("thinking_enabled")
    or user_config.get("thinking_enabled")
)
thinking_effort_raw = (
    env.get("MYCLI_THINKING_EFFORT")
    or project_config.get("thinking_effort")
    or user_config.get("thinking_effort")
)

resolved_thinking_effort = (
    _validate_reasoning_effort(str(thinking_effort_raw))
    if thinking_effort_raw is not None
    else (
        _validate_reasoning_effort(str(legacy_reasoning_effort))
        if legacy_reasoning_effort is not None
        else ReasoningEffort.MEDIUM
    )
)
resolved_thinking_enabled = (
    thinking_enabled
    if thinking_enabled is not None
    else (legacy_reasoning_effort is not None or thinking_effort_raw is not None)
)
if resolved_thinking_enabled is False and thinking_effort_raw is not None:
    raise ValueError("thinking_effort requires thinking_enabled=true")

return AgentConfig(
    ...,
    reasoning_effort=resolved_thinking_effort,
    thinking_enabled=resolved_thinking_enabled,
    thinking_effort=(resolved_thinking_effort if resolved_thinking_enabled else None),
    ...,
)
```

- [ ] **Step 5: Map normalized thinking controls into provider requests**

Update `src/mycli/infrastructure/openai_responses_client.py`:

```python
        self._thinking_enabled = True
        self._reasoning_effort: str | None = None

    def set_thinking_config(
        self,
        *,
        enabled: bool,
        effort: str | None,
    ) -> None:
        self._thinking_enabled = enabled
        self._reasoning_effort = effort
```

Update `src/mycli/infrastructure/responses_request_builder.py`:

```python
    def build(
        self,
        *,
        model: str,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
        max_output_tokens: int,
        reasoning_effort: str | None,
        thinking_enabled: bool,
        stream: bool,
        continuation_state: ResponsesContinuationState | None = None,
    ) -> BuildResult:
        ...
        if thinking_enabled and reasoning_effort and self._capability_profile.supports_reasoning:
            payload_body["reasoning"] = {"effort": reasoning_effort}
```

Update the call sites in `src/mycli/infrastructure/openai_responses_client.py`:

```python
            build_result = self._request_builder.build(
                model=self._model,
                input_items=input_items,
                tools=normalized_tools,
                max_output_tokens=self._max_output_tokens,
                reasoning_effort=self._reasoning_effort,
                thinking_enabled=self._thinking_enabled,
                stream=False,
                continuation_state=continuation_state,
            )
```

Update `src/mycli/infrastructure/openai_client.py`:

```python
        self._thinking_enabled = True
        self._thinking_effort: str | None = None

    def set_thinking_config(
        self,
        *,
        enabled: bool,
        effort: str | None,
    ) -> None:
        self._thinking_enabled = enabled
        self._thinking_effort = effort
```

- [ ] **Step 6: Run the thinking-config tests to verify the unified control surface passes**

Run: `uv run pytest tests/unit/services/test_config_service.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/test_openai_client.py -v`

Expected: `PASS`

- [ ] **Step 7: Commit the thinking-control normalization**

Run:

```bash
git add src/mycli/domain/runtime/__init__.py src/mycli/services/config_service.py src/mycli/application/runtime/agent_runtime.py src/mycli/infrastructure/models/base.py src/mycli/infrastructure/openai_responses_client.py src/mycli/infrastructure/openai_client.py src/mycli/infrastructure/responses_request_builder.py tests/unit/services/test_config_service.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/test_openai_client.py
git commit -F - <<'EOF'
Normalize thinking mode and thinking effort across transports

Promote thinking controls to a runtime-level concept so provider
transports can map one normalized enabled/effort pair into their own
request fields without leaking protocol-specific semantics upward.

Constraint: Must preserve existing reasoning-effort behavior for current users
Rejected: Keep thinking strength as a Responses-only request field | blocks provider-agnostic configuration
Confidence: medium
Scope-risk: moderate
Reversibility: clean
Directive: New transports must accept set_thinking_config even if they ignore unsupported fields
Tested: uv run pytest tests/unit/services/test_config_service.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/test_openai_client.py -v
Not-tested: Live provider-specific thinking behavior
EOF
```

## Task 4: Move OpenAI Responses onto the Shared Protocol

**Files:**
- Create: `src/mycli/schemas/responses_wire_protocol.py`
- Modify: `src/mycli/schemas/responses_protocol.py`
- Modify: `src/mycli/infrastructure/openai_responses_client.py`
- Modify: `src/mycli/infrastructure/models/responses_adapter.py`
- Modify: `tests/unit/infrastructure/test_openai_responses_client.py`
- Modify: `tests/unit/infrastructure/models/test_responses_adapter.py`

- [ ] **Step 1: Write the failing Responses transport tests**

Add these tests to `tests/unit/infrastructure/test_openai_responses_client.py`:

```python
from mycli.domain.model_events import ModelEventType


def test_openai_responses_client_maps_output_payload_to_model_events(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        handler=lambda kwargs: {
            "id": "resp_123",
            "output": [
                {
                    "id": "fc_001",
                    "type": "function_call",
                    "name": "list_directory",
                    "arguments": "{\"path\":\".\"}",
                    "call_id": "call_001",
                },
                {
                    "id": "msg_001",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "I can inspect the repository."}],
                },
            ],
        }
    )
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )

    events = client.create_events(
        input_items=[{"role": "user", "content": "inspect the repo"}],
        tools=[],
    )

    assert [event.type for event in events] == [
        ModelEventType.TOOL_CALL_REQUESTED,
        ModelEventType.MESSAGE_DELTA,
        ModelEventType.TURN_COMPLETED,
    ]
```

Add this adapter assertion to `tests/unit/infrastructure/models/test_responses_adapter.py`:

```python
def test_responses_adapter_aggregates_model_events_into_turn_result() -> None:
    client = FakeResponsesClient({"id": "resp_123", "output": []})
    client.create_events = lambda **_: [
        ModelEvent.message_delta(text="I can inspect the repository."),
        ModelEvent.tool_call_requested(
            tool_name="list_directory",
            tool_arguments={"path": "."},
            call_id="call_001",
            source=ToolExecutionSource.NATIVE,
            provider_id="fc_001",
        ),
        ModelEvent(type=ModelEventType.TURN_COMPLETED, response_id="resp_123"),
    ]
    adapter = ResponsesModelAdapter(client=client)

    result = adapter.next_turn(
        items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect the repo"),))],
        tools=[],
    )

    assert result.response_id == "resp_123"
    assert result.items[0].blocks[0].type == "text"
    assert result.items[0].blocks[1].type == "tool_call"
```

- [ ] **Step 2: Run the Responses-focused tests to verify the old parsing path fails**

Run: `uv run pytest tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py -v`

Expected: `FAIL` because `create_events()` does not exist and the adapter still depends on provider-specific parse helpers.

- [ ] **Step 3: Split wire parsing from runtime protocol and emit `ModelEvent` values**

Create `src/mycli/schemas/responses_wire_protocol.py` with the existing Responses wire dataclasses and parse helpers:

```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True, frozen=True)
class ResponsesOutputItem:
    provider_id: str | None
    item_type: str
    payload: dict[str, object]


@dataclass(slots=True, frozen=True)
class ResponsesStreamEnvelope:
    event_type: str
    payload: dict[str, object]


def parse_responses_output_item(item: dict[str, object]) -> ResponsesOutputItem:
    return ResponsesOutputItem(
        provider_id=item.get("id") if isinstance(item.get("id"), str) else None,
        item_type=str(item.get("type", "")),
        payload=item,
    )


def parse_responses_stream_event(payload: dict[str, object]) -> ResponsesStreamEnvelope:
    return ResponsesStreamEnvelope(
        event_type=str(payload.get("type", "")),
        payload=payload,
    )
```

Reduce `src/mycli/schemas/responses_protocol.py` to only the capability and continuation-state types:

```python
__all__ = [
    "ResponsesCapabilityProfile",
    "ResponsesContinuationState",
]
```

Update `src/mycli/infrastructure/openai_responses_client.py` with a provider-agnostic event API:

```python
from mycli.domain.model_events import ModelEvent, ModelEventType, ToolExecutionSource
from mycli.schemas.responses_wire_protocol import (
    parse_responses_output_item,
    parse_responses_stream_event,
)


def create_events(
    self,
    *,
    input_items: list[dict[str, object]],
    tools: list[dict[str, object]] | None = None,
) -> list[ModelEvent]:
    payload = self.create_response(input_items=input_items, tools=tools)
    events: list[ModelEvent] = []
    for raw_item in payload.get("output", []):
        if not isinstance(raw_item, dict):
            continue
        item = parse_responses_output_item(raw_item)
        if item.item_type == "function_call":
            events.append(
                ModelEvent.tool_call_requested(
                    tool_name=str(item.payload.get("name", "")),
                    tool_arguments=json.loads(str(item.payload.get("arguments", "{}"))),
                    call_id=str(item.payload.get("call_id", item.provider_id or "")),
                    source=ToolExecutionSource.NATIVE,
                    provider_id=item.provider_id,
                )
            )
        elif item.item_type == "message":
            for content_item in item.payload.get("content", []):
                if isinstance(content_item, dict) and content_item.get("type") == "output_text":
                    text = content_item.get("text")
                    if isinstance(text, str) and text:
                        events.append(
                            ModelEvent.message_delta(
                                text=text,
                                provider_id=item.provider_id,
                            )
                        )
        elif item.item_type == "reasoning":
            for summary_item in item.payload.get("summary", []):
                if isinstance(summary_item, dict) and summary_item.get("type") == "summary_text":
                    text = summary_item.get("text")
                    if isinstance(text, str) and text:
                        events.append(ModelEvent(type=ModelEventType.REASONING_DELTA, text=text))
    events.append(
        ModelEvent(
            type=ModelEventType.TURN_COMPLETED,
            response_id=payload.get("id") if isinstance(payload.get("id"), str) else None,
        )
    )
    return events
```

Update `src/mycli/infrastructure/models/responses_adapter.py`:

```python
from mycli.infrastructure.models.turn_event_aggregator import TurnEventAggregator


class ResponsesModelAdapter:
    def __init__(
        self,
        client: ResponsesClient,
        log_service: WorkspaceLogService | None = None,
    ) -> None:
        self._client = client
        self._aggregator = TurnEventAggregator()
        self._log_service = log_service

    def next_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> ModelTurnResult:
        events = self._client.create_events(
            input_items=self._serialize_items(items),
            tools=self._serialize_tools(tools),
        )
        turn_result = self._aggregator.collect(events)
        self._record_client_completion(turn_result)
        return turn_result
```

- [ ] **Step 4: Run the Responses-focused tests to verify the shared protocol path passes**

Run: `uv run pytest tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py -v`

Expected: `PASS`

- [ ] **Step 5: Commit the Responses migration**

Run:

```bash
git add src/mycli/schemas/responses_wire_protocol.py src/mycli/schemas/responses_protocol.py src/mycli/infrastructure/openai_responses_client.py src/mycli/infrastructure/models/responses_adapter.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py
git commit -F - <<'EOF'
Move Responses transport onto the shared runtime protocol

Separate Responses wire parsing from runtime-facing behavior and have the
Responses client emit provider-agnostic ModelEvent values that the shared
aggregator can consume.

Constraint: Responses continuation behavior must stay intact
Rejected: Keep parse_responses_output_item as a runtime-facing contract | preserves provider leakage
Confidence: medium
Scope-risk: moderate
Reversibility: clean
Directive: ResponsesCapabilityProfile is transport capability state, not a runtime protocol type
Tested: uv run pytest tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py -v
Not-tested: Real streaming provider responses
EOF
```

## Task 5: Normalize Chat Completions onto the Same Protocol

**Files:**
- Modify: `src/mycli/infrastructure/openai_client.py`
- Modify: `src/mycli/infrastructure/models/native_tool_adapter.py`
- Modify: `tests/unit/infrastructure/test_openai_client.py`

- [ ] **Step 1: Write the failing chat-completions protocol tests**

Add this test to `tests/unit/infrastructure/test_openai_client.py`:

```python
from mycli.domain.model_events import ModelEventType


def test_openai_chat_client_maps_tool_call_payload_to_model_events(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "tool_calls": [
                            {
                                "id": "call_001",
                                "type": "function",
                                "function": {
                                    "name": "list_directory",
                                    "arguments": "{\"path\":\".\"}",
                                },
                            }
                        ],
                        "content": "I will inspect the repository.",
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
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )

    events = client.create_events(
        input_items=[{"role": "user", "content": "inspect the repo"}],
        tools=[],
    )

    assert [event.type for event in events] == [
        ModelEventType.MESSAGE_DELTA,
        ModelEventType.TOOL_CALL_REQUESTED,
        ModelEventType.TURN_COMPLETED,
    ]
```

- [ ] **Step 2: Run the chat-completions tests to verify the old shape does not support shared events**

Run: `uv run pytest tests/unit/infrastructure/test_openai_client.py -v`

Expected: `FAIL` because `OpenAIChatClient` only exposes `complete()` and returns a protocol-specific payload shape.

- [ ] **Step 3: Implement shared event normalization for chat completions**

Update `src/mycli/infrastructure/openai_client.py`:

```python
from mycli.domain.model_events import ModelEvent, ModelEventType, ToolExecutionSource


def create_events(
    self,
    *,
    input_items: list[dict[str, object]],
    tools: list[dict[str, object]] | None = None,
) -> list[ModelEvent]:
    payload = self.complete(messages=input_items, tools=tools)
    events: list[ModelEvent] = []

    assistant_message = payload.get("assistant_message")
    if isinstance(assistant_message, str) and assistant_message:
        events.append(ModelEvent.message_delta(text=assistant_message))

    raw_tool_call = payload.get("tool_call")
    if isinstance(raw_tool_call, dict):
        events.append(
            ModelEvent.tool_call_requested(
                tool_name=str(raw_tool_call["name"]),
                tool_arguments=(
                    raw_tool_call.get("arguments")
                    if isinstance(raw_tool_call.get("arguments"), dict)
                    else {}
                ),
                call_id=str(raw_tool_call.get("id") or raw_tool_call.get("call_id") or "tool_call"),
                source=ToolExecutionSource.NATIVE,
            )
        )

    events.append(
        ModelEvent(
            type=ModelEventType.TURN_COMPLETED,
            metadata={"done": bool(payload.get("done", False))},
        )
    )
    return events
```

Update `src/mycli/infrastructure/models/native_tool_adapter.py` to reuse the shared aggregator:

```python
from mycli.infrastructure.models.turn_event_aggregator import TurnEventAggregator


class NativeToolClient(Protocol):
    def create_events(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> list[ModelEvent]:
        ...


class NativeToolModelAdapter:
    def __init__(self, client: NativeToolClient) -> None:
        self._client = client
        self._aggregator = TurnEventAggregator()

    def next_action(
        self,
        *,
        messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> ModelAction:
        events = self._client.create_events(
            input_items=[{"role": message.role, "content": message.content} for message in messages],
            tools=[
                {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": [
                        {
                            "name": parameter.name,
                            "type": parameter.type,
                            "required": parameter.required,
                            "description": parameter.description,
                        }
                        for parameter in tool.parameters
                    ],
                }
                for tool in tools
            ],
        )
        turn_result = self._aggregator.collect(events)
        assistant_item = turn_result.items[0] if turn_result.items else None
        tool_block = (
            None
            if assistant_item is None
            else next((block for block in assistant_item.blocks if block.type == "tool_call"), None)
        )
        return ModelAction(
            assistant_message=(
                None
                if assistant_item is None
                else next((block.text for block in assistant_item.blocks if block.type == "text"), None)
            ),
            progress_message=None,
            tool_call=(
                None
                if tool_block is None
                else ToolCall(
                    name=str(tool_block.tool_name),
                    arguments=tool_block.tool_arguments or {},
                    reason="model requested tool",
                    call_id=tool_block.call_id,
                )
            ),
            done=turn_result.done,
        )
```

- [ ] **Step 4: Run the chat-completions tests to verify protocol alignment passes**

Run: `uv run pytest tests/unit/infrastructure/test_openai_client.py -v`

Expected: `PASS`

- [ ] **Step 5: Commit the chat-completions normalization**

Run:

```bash
git add src/mycli/infrastructure/openai_client.py src/mycli/infrastructure/models/native_tool_adapter.py tests/unit/infrastructure/test_openai_client.py
git commit -F - <<'EOF'
Normalize chat completions into the shared runtime protocol

Make the chat-completions path emit the same internal ModelEvent
sequence as Responses so future providers can reuse one tool-call and
turn aggregation contract.

Constraint: Keep current NativeToolModelAdapter behavior stable for the runtime
Rejected: Leave chat completions on a bespoke payload shape | blocks provider convergence
Confidence: medium
Scope-risk: moderate
Reversibility: clean
Directive: Do not add another provider-specific adapter protocol above ModelEvent
Tested: uv run pytest tests/unit/infrastructure/test_openai_client.py -v
Not-tested: Provider-specific quirks from DeepSeek or Anthropic
EOF
```

## Task 6: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Test: `tests/unit/domain/test_model_events.py`
- Test: `tests/unit/infrastructure/models/test_turn_event_aggregator.py`
- Test: `tests/unit/infrastructure/test_openai_responses_client.py`
- Test: `tests/unit/infrastructure/models/test_responses_adapter.py`
- Test: `tests/unit/infrastructure/test_openai_client.py`

- [ ] **Step 1: Update the architecture documentation**

Add this section to `README.md`:

```markdown
## Internal Runtime Protocol

`mycli` does not treat any provider wire format as its runtime contract.
Instead:

1. Provider transports such as OpenAI Responses or chat completions parse their
   own wire payloads.
2. Each transport normalizes model output into the internal `ModelEvent`
   protocol.
3. A shared turn aggregator converts those events into `RuntimeItem`,
   `RuntimeBlock`, and `ModelTurnResult`.

Tool execution sources are unified across native tools, MCP tools, and skills.
That means future providers only need a transport adapter; the runtime and tool
orchestration layers do not need to learn another message format.
```

- [ ] **Step 2: Run the focused protocol test suite**

Run: `uv run pytest tests/unit/domain/test_model_events.py tests/unit/infrastructure/models/test_turn_event_aggregator.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/infrastructure/test_openai_client.py -v`

Expected: `PASS`

- [ ] **Step 3: Run lint and typecheck**

Run: `uv run ruff check src tests`

Expected: `All checks passed!`

Run: `uv run mypy src`

Expected: `Success: no issues found`

- [ ] **Step 4: Commit docs and verification**

Run:

```bash
git add README.md
git commit -F - <<'EOF'
Document the unified runtime protocol boundary

Explain that provider wire protocols are normalized into an internal
event stream before the runtime consumes them, and record the intended
boundary for future provider, MCP, and skill integrations.

Constraint: Documentation must match the transport boundary implemented in code
Rejected: Keep provider-specific terminology in runtime documentation | obscures the intended abstraction
Confidence: high
Scope-risk: narrow
Reversibility: clean
Directive: Update this section whenever a new provider transport is added
Tested: uv run pytest tests/unit/domain/test_model_events.py tests/unit/infrastructure/models/test_turn_event_aggregator.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/infrastructure/test_openai_client.py -v; uv run ruff check src tests; uv run mypy src
Not-tested: Live provider traffic
EOF
```

## Self-Review

- Spec coverage: the plan covers the unified event contract, shared aggregation, Responses migration, chat-completions migration, MCP/skill source unification, docs, and verification. It intentionally does not change config/provider selection.
- Placeholder scan: no `TODO`, `TBD`, or cross-task hand-waving remains.
- Type consistency: `ModelEvent`, `ModelEventType`, `ToolExecutionSource`, `TurnEventAggregator`, `RuntimeBlock.source`, and `ModelTurnResult` are named consistently across all tasks.

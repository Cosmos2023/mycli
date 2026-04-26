# mycli Responses Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current `chat/completions`-centric model path with a Responses-first runtime while preserving the current CLI interaction model and approval UX.

**Architecture:** Introduce a typed block/item contract between provider adapters and `AgentRuntime`, then implement an OpenAI Responses client plus adapter that produces those blocks. Refactor the runtime loop, transcript persistence, and CLI wiring to consume the new contract while demoting the legacy chat adapters to explicit fallback mode.

**Tech Stack:** Python 3.13, standard library `dataclasses`/`urllib`/`pathlib`, `pytest`, `ruff`, `mypy`, existing schema-first tools and session services

---

## Scope Check

This plan covers only the Responses runtime migration approved in [2026-04-05-mycli-responses-runtime-design.md](/Users/cosmos/Desktop/mycli/docs/superpowers/specs/2026-04-05-mycli-responses-runtime-design.md). It does not include subagents, Anthropic/Gemini adapters, or a CLI UX redesign.

## File Structure

- Create: `src/mycli/infrastructure/openai_responses_client.py`
  Owns `POST /responses`, request serialization, provider response parsing, and user-facing provider errors.
- Create: `src/mycli/infrastructure/models/responses_adapter.py`
  Converts provider output items into typed runtime blocks and produces `ModelTurnResult`.
- Modify: `src/mycli/infrastructure/models/base.py`
  Adds the new block/item/result contracts and preserves a small legacy surface while the runtime is migrating.
- Modify: `src/mycli/infrastructure/models/__init__.py`
  Re-exports the new Responses contracts and adapter.
- Modify: `src/mycli/domain/conversation.py`
  Adds typed transcript blocks/items while keeping the current `Conversation` shell for session storage continuity.
- Modify: `src/mycli/services/session_service.py`
  Persists typed transcript blocks, response ids, tool call ids, and suspended turn state for block-driven resume.
- Modify: `src/mycli/application/runtime/agent_runtime.py`
  Replaces the `assistant_message/tool_call/done` loop with block consumption and tool-result reinjection.
- Modify: `src/mycli/cli/main.py`
  Switches default wiring to the Responses client/adapter and surfaces a readable error for unsupported providers.
- Modify: `src/mycli/services/config_service.py`
  Adds a small protocol switch with `responses` as the default and `legacy_chat` as explicit fallback.
- Modify: `src/mycli/prompts/system.py`
  Keeps prompts aligned with the new block/item model and removes completion-era assumptions.
- Modify: `README.md`
  Documents `Responses API` as the primary requirement and explains the legacy fallback mode.
- Test: `tests/unit/infrastructure/test_openai_responses_client.py`
  Verifies request shape, response parsing, and unsupported-provider failures.
- Test: `tests/unit/infrastructure/models/test_responses_adapter.py`
  Verifies provider output items map to runtime blocks/items.
- Modify: `tests/unit/services/test_session_service.py`
  Verifies block-aware transcript serialization and suspended-turn recovery.
- Modify: `tests/unit/application/test_agent_runtime.py`
  Verifies block-driven looping, tool-result reinjection, and approval resume.
- Modify: `tests/unit/cli/test_main.py`
  Verifies CLI wiring defaults to Responses and still supports an explicit legacy fallback.
- Modify: `tests/unit/prompts/test_prompts.py`
  Verifies prompt text stays compatible with the Responses-first runtime.

## Task 1: Introduce Typed Runtime Blocks and Turn Results

**Files:**
- Modify: `src/mycli/infrastructure/models/base.py`
- Modify: `src/mycli/infrastructure/models/__init__.py`
- Modify: `src/mycli/domain/conversation.py`
- Test: `tests/unit/infrastructure/models/test_responses_adapter.py`

- [ ] **Step 1: Write the failing block-contract test**

```python
from mycli.infrastructure.models.base import ModelTurnResult, RuntimeBlock, RuntimeItem


def test_runtime_block_contract_supports_text_and_tool_calls() -> None:
    block = RuntimeBlock(
        type="tool_call",
        tool_name="read_file",
        tool_arguments={"path": "README.md"},
        call_id="call_readme_1",
    )
    item = RuntimeItem(role="assistant", blocks=(block,))
    result = ModelTurnResult(items=(item,), done=False, response_id="resp_123")

    assert result.items[0].blocks[0].type == "tool_call"
    assert result.items[0].blocks[0].call_id == "call_readme_1"
```

- [ ] **Step 2: Run the test to confirm the contracts do not exist yet**

Run: `uv run pytest tests/unit/infrastructure/models/test_responses_adapter.py -k runtime_block_contract_supports_text_and_tool_calls -v`

Expected: FAIL with `ImportError` or missing `RuntimeBlock`/`RuntimeItem`/`ModelTurnResult`

- [ ] **Step 3: Add the new typed contracts to the shared model layer**

```python
# src/mycli/infrastructure/models/base.py
from dataclasses import dataclass, field
from typing import Literal, Protocol


BlockType = Literal["text", "tool_call", "tool_result", "reasoning"]


@dataclass(slots=True, frozen=True)
class RuntimeBlock:
    type: BlockType
    text: str | None = None
    tool_name: str | None = None
    tool_arguments: dict[str, object] = field(default_factory=dict)
    call_id: str | None = None
    provider_id: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(slots=True, frozen=True)
class RuntimeItem:
    role: str
    blocks: tuple[RuntimeBlock, ...] = ()


@dataclass(slots=True, frozen=True)
class ModelTurnResult:
    items: tuple[RuntimeItem, ...] = ()
    done: bool = False
    response_id: str | None = None
```

- [ ] **Step 4: Extend the conversation model so transcript storage can carry typed blocks**

```python
# src/mycli/domain/conversation.py
from dataclasses import dataclass, field
from typing import Literal

from mycli.infrastructure.models.base import RuntimeBlock

Role = Literal["system", "user", "assistant", "tool"]


@dataclass(slots=True, frozen=True)
class Message:
    role: Role
    content: str
    tool_call_id: str | None = None
    tool_calls: tuple[ToolCall, ...] = field(default_factory=tuple)
    blocks: tuple[RuntimeBlock, ...] = field(default_factory=tuple)
    response_id: str | None = None
```

- [ ] **Step 5: Re-export the new types from the models package**

```python
# src/mycli/infrastructure/models/__init__.py
from mycli.infrastructure.models.base import (
    ModelAdapter,
    ModelToolDefinition,
    ModelToolParameter,
    ModelTurnResult,
    RuntimeBlock,
    RuntimeItem,
)
from mycli.infrastructure.models.responses_adapter import ResponsesModelAdapter
```

- [ ] **Step 6: Run the targeted tests and make sure the new contracts are green**

Run: `uv run pytest tests/unit/infrastructure/models/test_responses_adapter.py -k runtime_block_contract_supports_text_and_tool_calls -v`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/mycli/infrastructure/models/base.py src/mycli/infrastructure/models/__init__.py src/mycli/domain/conversation.py tests/unit/infrastructure/models/test_responses_adapter.py
git commit -m "feat: add typed runtime block contracts"
```

## Task 2: Add a Responses Client and Adapter

**Files:**
- Create: `src/mycli/infrastructure/openai_responses_client.py`
- Create: `src/mycli/infrastructure/models/responses_adapter.py`
- Test: `tests/unit/infrastructure/test_openai_responses_client.py`
- Test: `tests/unit/infrastructure/models/test_responses_adapter.py`

- [ ] **Step 1: Write the failing Responses client request/response test**

```python
from mycli.infrastructure.openai_responses_client import OpenAIResponsesClient


def test_openai_responses_client_serializes_input_and_tools(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_urlopen(request_obj):
        captured["body"] = json.loads(request_obj.data.decode("utf-8"))
        return FakeResponse(
            {
                "id": "resp_123",
                "output": [
                    {
                        "id": "rs_1",
                        "type": "function_call",
                        "call_id": "call_read_file_1",
                        "name": "read_file",
                        "arguments": "{\"path\":\"README.md\"}",
                    }
                ],
                "output_text": "",
            }
        )

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://api.openai.com/v1",
        model="gpt-5",
        max_output_tokens=2048,
    )
    payload = client.create_response(
        items=[{"role": "user", "content": "read the readme"}],
        tools=[{"name": "read_file", "description": "Read a file", "parameters": []}],
    )

    assert captured["body"]["model"] == "gpt-5"
    assert captured["body"]["input"][0]["role"] == "user"
    assert payload["id"] == "resp_123"
    assert payload["output"][0]["type"] == "function_call"
```

- [ ] **Step 2: Run the test to verify the new client is still missing**

Run: `uv run pytest tests/unit/infrastructure/test_openai_responses_client.py::test_openai_responses_client_serializes_input_and_tools -v`

Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement the minimal Responses HTTP client**

```python
# src/mycli/infrastructure/openai_responses_client.py
class OpenAIResponsesClient:
    def create_response(
        self,
        *,
        items: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        payload_body = {
            "model": self._model,
            "input": items,
            "tools": self._normalize_tool_definitions(tools),
            "max_output_tokens": self._max_output_tokens,
        }
        http_request = request.Request(
            url=f"{self._base_url}/responses",
            data=json.dumps(payload_body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        ...
```

- [ ] **Step 4: Write the failing adapter translation test**

```python
from mycli.infrastructure.models.responses_adapter import ResponsesModelAdapter


class FakeResponsesClient:
    def create_response(self, *, items, tools):
        del items, tools
        return {
            "id": "resp_123",
            "output": [
                {
                    "id": "fc_1",
                    "type": "function_call",
                    "call_id": "call_list_1",
                    "name": "list_directory",
                    "arguments": "{\"path\":\".\"}",
                }
            ],
        }


def test_responses_adapter_converts_function_call_items_to_runtime_blocks() -> None:
    adapter = ResponsesModelAdapter(client=FakeResponsesClient())
    result = adapter.next_turn(items=[], tools=[])

    assert result.response_id == "resp_123"
    assert result.items[0].blocks[0].type == "tool_call"
    assert result.items[0].blocks[0].tool_name == "list_directory"
```

- [ ] **Step 5: Implement the adapter that maps Responses output items to runtime blocks**

```python
# src/mycli/infrastructure/models/responses_adapter.py
class ResponsesModelAdapter:
    def next_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> ModelTurnResult:
        payload = self._client.create_response(
            items=[self._serialize_item(item) for item in items],
            tools=[self._serialize_tool(tool) for tool in tools],
        )
        runtime_items: list[RuntimeItem] = []
        for output in payload.get("output", []):
            if output["type"] == "function_call":
                runtime_items.append(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name=str(output["name"]),
                                tool_arguments=json.loads(output["arguments"]),
                                call_id=str(output["call_id"]),
                                provider_id=str(output["id"]),
                            ),
                        ),
                    )
                )
        return ModelTurnResult(items=tuple(runtime_items), done=not runtime_items, response_id=payload.get("id"))
```

- [ ] **Step 6: Add a failing unsupported-provider test**

```python
def test_openai_responses_client_surfaces_missing_responses_support(monkeypatch) -> None:
    def fake_urlopen(request_obj):
        raise HTTPError(
            request_obj.full_url,
            404,
            "Not Found",
            hdrs=None,
            fp=FakeErrorResponse('{"error":{"message":"unknown path /responses"}}'),
        )

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    client = OpenAIResponsesClient(...)

    with pytest.raises(ModelResponseError, match="Responses API is not available"):
        client.create_response(items=[], tools=[])
```

- [ ] **Step 7: Implement the user-readable unsupported-provider error mapping**

```python
if exc.code in {404, 400} and "/responses" in detail:
    raise ModelResponseError(
        "Responses API is not available for the current provider. "
        "Switch to a provider/model that supports Responses or set protocol=legacy_chat."
    ) from exc
```

- [ ] **Step 8: Run the targeted infrastructure tests**

Run: `uv run pytest tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py -v`

Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/mycli/infrastructure/openai_responses_client.py src/mycli/infrastructure/models/responses_adapter.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py
git commit -m "feat: add responses client and adapter"
```

## Task 3: Persist Block-Aware Transcripts and Suspended Turns

**Files:**
- Modify: `src/mycli/services/session_service.py`
- Modify: `src/mycli/domain/conversation.py`
- Modify: `src/mycli/domain/runtime/turn_state.py`
- Modify: `tests/unit/services/test_session_service.py`

- [ ] **Step 1: Write the failing session round-trip test for typed blocks**

```python
from mycli.domain.conversation import Conversation, Message
from mycli.infrastructure.models.base import RuntimeBlock
from mycli.services.session_service import SessionService


def test_session_service_round_trips_message_blocks(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    conversation = Conversation(session_id="demo")
    conversation.append(
        Message(
            role="assistant",
            content="",
            response_id="resp_123",
            blocks=(
                RuntimeBlock(
                    type="tool_call",
                    tool_name="list_directory",
                    tool_arguments={"path": "."},
                    call_id="call_list_1",
                ),
            ),
        )
    )

    service.save_conversation(conversation)
    loaded = service.load_conversation("demo")

    assert loaded.messages[0].response_id == "resp_123"
    assert loaded.messages[0].blocks[0].call_id == "call_list_1"
```

- [ ] **Step 2: Run the session test to verify block persistence does not exist yet**

Run: `uv run pytest tests/unit/services/test_session_service.py -k round_trips_message_blocks -v`

Expected: FAIL because `blocks` or `response_id` are not serialized

- [ ] **Step 3: Extend session serialization for blocks and response ids**

```python
# src/mycli/services/session_service.py
"messages": [
    {
        "role": message.role,
        "content": message.content,
        "tool_call_id": message.tool_call_id,
        "response_id": message.response_id,
        "blocks": [
            {
                "type": block.type,
                "text": block.text,
                "tool_name": block.tool_name,
                "tool_arguments": block.tool_arguments,
                "call_id": block.call_id,
                "provider_id": block.provider_id,
                "metadata": block.metadata,
            }
            for block in message.blocks
        ],
    }
]
```

- [ ] **Step 4: Add the suspended-turn block round-trip test**

```python
def test_session_service_round_trips_suspended_turn_blocks(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path / "home")
    suspended = SuspendedTurn(
        user_message="list files",
        conversation=(
            Message(
                role="assistant",
                content="",
                response_id="resp_123",
                blocks=(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name="list_directory",
                        tool_arguments={"path": "."},
                        call_id="call_list_1",
                    ),
                ),
            ),
        ),
    )

    service.save_suspended_turn("demo", suspended)
    loaded = service.load_suspended_turn("demo")

    assert loaded is not None
    assert loaded.conversation[0].blocks[0].tool_name == "list_directory"
```

- [ ] **Step 5: Implement the matching load path and keep the old fields readable**

```python
blocks=tuple(
    RuntimeBlock(
        type=block["type"],
        text=block.get("text"),
        tool_name=block.get("tool_name"),
        tool_arguments=block.get("tool_arguments", {}),
        call_id=block.get("call_id"),
        provider_id=block.get("provider_id"),
        metadata=block.get("metadata", {}),
    )
    for block in item.get("blocks", [])
),
response_id=item.get("response_id"),
```

- [ ] **Step 6: Run the session service test file**

Run: `uv run pytest tests/unit/services/test_session_service.py -v`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/mycli/services/session_service.py src/mycli/domain/conversation.py src/mycli/domain/runtime/turn_state.py tests/unit/services/test_session_service.py
git commit -m "feat: persist typed response transcripts"
```

## Task 4: Refactor AgentRuntime to Consume Runtime Blocks

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/prompts/system.py`
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tests/unit/prompts/test_prompts.py`

- [ ] **Step 1: Write the failing block-driven runtime test**

```python
from mycli.infrastructure.models.base import ModelTurnResult, RuntimeBlock, RuntimeItem


class BlockThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="list_directory",
                                tool_arguments={"path": "."},
                                call_id="call_list_1",
                            ),
                        ),
                    ),
                ),
                done=False,
                response_id="resp_1",
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Inspection complete"),),
                ),
            ),
            done=True,
            response_id="resp_2",
        )


def test_agent_runtime_consumes_tool_call_blocks_and_returns_text_blocks(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=BlockThenDoneAdapter(),
    )

    response = runtime.handle_user_turn("inspect repo")

    assert response.assistant_message == "Inspection complete"
```

- [ ] **Step 2: Run the targeted runtime test to verify the old loop fails**

Run: `uv run pytest tests/unit/application/test_agent_runtime.py -k consumes_tool_call_blocks_and_returns_text_blocks -v`

Expected: FAIL because `AgentRuntime` still expects `assistant_message/tool_call/done`

- [ ] **Step 3: Replace the runtime loop with block consumption**

```python
# src/mycli/application/runtime/agent_runtime.py
turn_result = self._model_adapter.next_turn(
    items=self._build_runtime_items(...),
    tools=self._tool_registry.render_for_model(),
)
final_text: list[str] = []
for item in turn_result.items:
    for block in item.blocks:
        if block.type == "tool_call":
            call = ToolCall(
                name=str(block.tool_name),
                arguments=block.tool_arguments,
                reason="model requested tool",
                call_id=block.call_id,
            )
            ...
        elif block.type == "text" and block.text:
            final_text.append(block.text)
```

- [ ] **Step 4: Add the failing tool-result reinjection assertion**

```python
def test_agent_runtime_reinjects_tool_results_as_tool_result_blocks(tmp_path: Path) -> None:
    ...
    assert any(
        block.type == "tool_result" and block.call_id == "call_list_1"
        for message in stored_conversation.messages
        for block in message.blocks
    )
```

- [ ] **Step 5: Implement block-aware transcript recording helpers**

```python
def _record_tool_result_block(
    self,
    conversation: Conversation,
    *,
    tool_name: str,
    content: str,
    call_id: str | None,
) -> None:
    conversation.append(
        Message(
            role="tool",
            content=content,
            tool_call_id=call_id,
            blocks=(
                RuntimeBlock(
                    type="tool_result",
                    text=content,
                    tool_name=tool_name,
                    call_id=call_id,
                ),
            ),
        )
    )
```

- [ ] **Step 6: Update the prompt tests to keep prompts protocol-agnostic**

```python
def test_build_system_prompt_mentions_native_tools_without_completion_contract() -> None:
    prompt = build_system_prompt()

    assert "Responses API" not in prompt
    assert "Never describe or serialize the tool protocol" in prompt
```

- [ ] **Step 7: Run the runtime and prompt tests**

Run: `uv run pytest tests/unit/application/test_agent_runtime.py tests/unit/prompts/test_prompts.py -v`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/prompts/system.py tests/unit/application/test_agent_runtime.py tests/unit/prompts/test_prompts.py
git commit -m "refactor: drive runtime from typed response blocks"
```

## Task 5: Switch CLI and Config to Responses by Default

**Files:**
- Modify: `src/mycli/services/config_service.py`
- Modify: `src/mycli/cli/main.py`
- Modify: `README.md`
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/integration/test_cli_repl.py`

- [ ] **Step 1: Write the failing config test for protocol defaults**

```python
from mycli.services.config_service import resolve_config


def test_resolve_config_defaults_to_responses_protocol(tmp_path: Path) -> None:
    config = resolve_config(cli_args={}, env={"MYCLI_API_KEY": "test-key"}, cwd=tmp_path, home=tmp_path)
    assert config.protocol == "responses"
```

- [ ] **Step 2: Run the config test to confirm the setting is missing**

Run: `uv run pytest tests/unit/services/test_config_service.py -k defaults_to_responses_protocol -v`

Expected: FAIL because `AgentConfig` has no `protocol`

- [ ] **Step 3: Add the protocol field to config resolution**

```python
# src/mycli/domain/runtime/__init__.py
@dataclass(slots=True, frozen=True)
class AgentConfig:
    workspace_root: Path
    model: str = "gpt-5"
    api_base_url: str = "https://api.openai.com/v1"
    api_key: str | None = None
    protocol: str = "responses"
    ...
```

```python
# src/mycli/services/config_service.py
protocol = str(
    env.get("MYCLI_PROTOCOL")
    or project_config.get("protocol")
    or user_config.get("protocol")
    or "responses"
)
```

- [ ] **Step 4: Write the failing CLI wiring test**

```python
def test_build_turn_service_uses_responses_adapter_by_default(tmp_path: Path) -> None:
    service = build_turn_service(
        cli_args={"session": "demo", "model": "gpt-5"},
        cwd=tmp_path,
        home=tmp_path / "home",
        env={"MYCLI_API_KEY": "test-key", "MYCLI_BASE_URL": "https://api.openai.com/v1"},
    )

    assert type(service._runtime._model_adapter).__name__ == "ResponsesModelAdapter"
```

- [ ] **Step 5: Implement CLI wiring for `responses` and explicit `legacy_chat`**

```python
# src/mycli/cli/main.py
if config.protocol == "legacy_chat":
    model_client = OpenAIChatClient(...)
    model_adapter = NativeToolModelAdapter(client=model_client)
else:
    model_client = OpenAIResponsesClient(...)
    model_adapter = ResponsesModelAdapter(client=model_client)
```

- [ ] **Step 6: Update README to make Responses the primary requirement**

```md
## 环境要求

- Python `3.13`
- `uv`
- 默认要求可用的 `Responses API` 提供方
- `chat/completions` 仅作为 `protocol = "legacy_chat"` fallback
```

- [ ] **Step 7: Add a readable legacy fallback example to the docs**

```toml
model = "deepseek-chat"
api_base_url = "https://api.deepseek.com"
api_key = "your-api-key"
protocol = "legacy_chat"
```

- [ ] **Step 8: Run the CLI/config/doc-adjacent tests**

Run: `uv run pytest tests/unit/services/test_config_service.py tests/unit/cli/test_main.py tests/integration/test_cli_repl.py -v`

Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/mycli/domain/runtime/__init__.py src/mycli/services/config_service.py src/mycli/cli/main.py README.md tests/unit/services/test_config_service.py tests/unit/cli/test_main.py tests/integration/test_cli_repl.py
git commit -m "feat: default mycli to responses protocol"
```

## Task 6: Full Verification and Legacy Surface Cleanup

**Files:**
- Modify: `src/mycli/infrastructure/models/compat_chat_adapter.py`
- Modify: `src/mycli/infrastructure/models/native_tool_adapter.py`
- Modify: `src/mycli/infrastructure/models/__init__.py`
- Modify: `README.md`

- [ ] **Step 1: Mark the old adapters as legacy in code comments and exports**

```python
# src/mycli/infrastructure/models/compat_chat_adapter.py
"""Legacy compat adapter kept for providers that still require chat/completions."""
```

```python
# src/mycli/infrastructure/models/native_tool_adapter.py
"""Legacy chat-completions tool adapter kept for explicit fallback mode."""
```

- [ ] **Step 2: Add a README note that DeepSeek currently requires `legacy_chat`**

```md
> DeepSeek 当前未作为 Responses 主线路径验证完成。
> 如果继续使用 DeepSeek，请显式设置 `protocol = "legacy_chat"`。
```

- [ ] **Step 3: Run the full project verification**

Run: `uv run pytest -q`

Expected: PASS with all tests green

Run: `uv run ruff check .`

Expected: `All checks passed!`

Run: `uv run mypy src`

Expected: `Success: no issues found`

- [ ] **Step 4: Run a real Responses smoke test**

Run: `printf '当前目录下都有哪些文件\n/quit\n' | uv run mycli --session responses-smoke`

Expected: the CLI answers in natural language without printing a JSON protocol object

- [ ] **Step 5: Run an explicit legacy fallback smoke test**

Run: `printf '当前目录下都有哪些文件\n/quit\n' | MYCLI_PROTOCOL=legacy_chat uv run mycli --session legacy-smoke`

Expected: the CLI still works or fails with a provider-specific error that clearly indicates fallback behavior

- [ ] **Step 6: Commit**

```bash
git add src/mycli/infrastructure/models/compat_chat_adapter.py src/mycli/infrastructure/models/native_tool_adapter.py src/mycli/infrastructure/models/__init__.py README.md
git commit -m "docs: mark legacy chat adapters as fallback"
```

## Self-Review

### Spec coverage

- Responses 主协议：Task 2, Task 5
- block/item-first 内部抽象：Task 1, Task 4
- transcript 持久化迁移：Task 3
- CLI 表现尽量不变：Task 4, Task 5
- legacy fallback 与 DeepSeek 降级：Task 5, Task 6

### Placeholder scan

- 没有使用 `TBD`、`TODO`、`implement later`
- 每个任务都给了文件路径、测试入口和明确命令
- 所有代码步骤都给了最小实现轮廓，而不是“自行实现”

### Type consistency

- 新主线统一围绕 `RuntimeBlock`、`RuntimeItem`、`ModelTurnResult`
- `call_id` 在 adapter、session、runtime 三层保持同名
- `protocol` 在 `AgentConfig`、`config_service`、`main.py`、README 中保持同名

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-05-mycli-responses-runtime-implementation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

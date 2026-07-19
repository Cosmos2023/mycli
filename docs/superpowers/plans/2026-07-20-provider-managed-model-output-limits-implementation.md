# Provider-Managed Model Output Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop sending generic output-token limits in Chat Completions and Responses model requests while preserving Anthropic's required internal limit and treating truncated generations as errors.

**Architecture:** Output-budget policy moves from shared `AgentConfig` into protocol clients. Chat Completions and Responses omit optional limit fields, Anthropic owns an internal `8192` default, and provider truncation signals are normalized into `ModelResponseError(failure_kind="output_token_limit")` instead of successful turn completion.

**Tech Stack:** Python 3.13, OpenAI-compatible Chat Completions, OpenAI Responses API, Anthropic Messages API, pytest, Ruff, mypy

---

### Task 1: Reject Truncated Chat Completions

**Files:**
- Modify: `tests/unit/infrastructure/test_openai_client.py`
- Modify: `src/mycli/llms/clients/openai_chat.py`

- [ ] **Step 1: Write failing request-shape and truncation tests**

Add tests that construct `OpenAIChatClient` without `max_output_tokens`, assert the SDK request omits `max_tokens`, and cover both streaming and non-streaming `finish_reason="length"`:

```python
def test_openai_chat_client_omits_model_output_limit(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [{"finish_reason": "stop", "message": {"content": "done"}}]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    client.complete(messages=[{"role": "user", "content": "inspect"}])

    assert "max_tokens" not in sdk_client.chat_completions.calls[-1]


def test_openai_chat_client_rejects_non_streaming_length_finish_reason(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "finish_reason": "length",
                    "message": {"content": "partial"},
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    with pytest.raises(ModelResponseError) as exc_info:
        client.complete(messages=[{"role": "user", "content": "inspect"}])

    assert exc_info.value.failure_kind == "output_token_limit"


def test_openai_chat_client_rejects_streaming_length_finish_reason(monkeypatch) -> None:
    sdk_client = _FakeStreamingOpenAISdkClient(
        chunks=[
            {"id": "chatcmpl_stream", "choices": [{"delta": {"content": "partial"}}]},
            {
                "id": "chatcmpl_stream",
                "choices": [{"delta": {}, "finish_reason": "length"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2048},
            },
        ]
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    with pytest.raises(ModelResponseError) as exc_info:
        list(client.stream_events(input_items=[{"role": "user", "content": "inspect"}]))

    assert exc_info.value.failure_kind == "output_token_limit"
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_openai_client.py -k 'omits_model_output_limit or length_finish_reason' -v
```

Expected: failures because the constructor still requires `max_output_tokens`, requests include `max_tokens`, and `length` is emitted as a normal completion.

- [ ] **Step 3: Remove the Chat Completions request limit and normalize truncation**

Delete the `max_output_tokens` constructor parameter, the
`self._max_output_tokens` assignment, and the setter. Change the request body to:

```python
payload_body: dict[str, object] = {
    "model": self._model,
    "messages": adapted_messages,
    "temperature": 0,
}
```

Add one helper used by `complete()` and `_events_from_chat_stream()`:

```python
@staticmethod
def _raise_for_finish_reason(finish_reason: object) -> None:
    if finish_reason == "length":
        raise ModelResponseError(
            "Model output reached the provider token limit.",
            stop_reason=StopReason.MODEL_ERROR,
            failure_kind="output_token_limit",
        )
```

In `complete()`, call it after validating `first_choice`. In the stream parser, remember the final non-null finish reason, preserve normal `tool_calls` handling, flush pending content, and call the helper before yielding `TURN_COMPLETED`. Remove `set_max_output_tokens()`.

Update all `OpenAIChatClient(...)` test constructors to remove the obsolete argument.

- [ ] **Step 4: Run Chat Completions tests**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_openai_client.py tests/unit/infrastructure/models/test_native_tool_adapter.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit the Chat Completions change**

```bash
git add src/mycli/llms/clients/openai_chat.py tests/unit/infrastructure/test_openai_client.py tests/unit/infrastructure/models/test_native_tool_adapter.py
git commit -m "fix: reject truncated chat completions"
```

### Task 2: Remove the Responses Output Limit

**Files:**
- Modify: `tests/unit/infrastructure/test_responses_request_builder.py`
- Modify: `tests/unit/infrastructure/test_openai_responses_client.py`
- Modify: `src/mycli/infrastructure/responses_request_builder.py`
- Modify: `src/mycli/llms/clients/openai_responses.py`
- Modify: `src/mycli/llms/adapters/responses_adapter.py`

- [ ] **Step 1: Write failing Responses request-shape tests**

Update builder/client tests so calls no longer pass a model output limit and assert both payload and continuation signature omit it:

```python
result = builder.build(
    model="gpt-test",
    input_items=[{"role": "user", "content": "inspect"}],
    tools=[],
    reasoning_effort=None,
    stream=True,
)

assert "max_output_tokens" not in result.payload_body
assert result.request_signature == '{"model":"gpt-test","stream":true,"tools":[]}'
```

Update the client request assertion:

```python
assert sdk_client.responses_api.create_calls == [{
    "model": "gpt-test",
    "input": [{"role": "user", "content": "inspect the repo"}],
    "tools": expected_tools,
}]
```

- [ ] **Step 2: Run the focused Responses tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_responses_request_builder.py tests/unit/infrastructure/test_openai_responses_client.py -k 'request or continuation or create_response' -q
```

Expected: failures because the builder still requires and serializes `max_output_tokens`.

- [ ] **Step 3: Remove the field from the builder, client, and adapter**

Delete `max_output_tokens` from `ResponsesRequestBuilder.build()` and `_build_signature()`. Build payloads from model, input, and tools only:

```python
payload_body: dict[str, object] = {
    "model": model,
    "input": [dict(item) for item in normalized_input],
    "tools": tools,
}
```

Remove the constructor field and setter from `OpenAIResponsesClient`, remove both builder call arguments, and remove `ResponsesModelAdapter.set_max_output_tokens()`. Update all constructor/build call sites and expected signatures in tests.

- [ ] **Step 4: Run Responses protocol tests**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_responses_request_builder.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/schemas/test_responses_protocol.py -q
```

Expected: all tests pass, including existing `response.incomplete` error coverage.

- [ ] **Step 5: Commit the Responses change**

```bash
git add src/mycli/infrastructure/responses_request_builder.py src/mycli/llms/clients/openai_responses.py src/mycli/llms/adapters/responses_adapter.py tests/unit/infrastructure/test_responses_request_builder.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/models/test_responses_adapter.py
git commit -m "refactor: let responses provider manage output limits"
```

### Task 3: Make Anthropic's Required Limit Internal

**Files:**
- Modify: `tests/unit/infrastructure/test_anthropic_messages_client.py`
- Modify: `src/mycli/llms/clients/anthropic_messages.py`
- Modify: `src/mycli/llms/adapters/anthropic_messages_adapter.py`

- [ ] **Step 1: Write failing internal-default and truncation tests**

Add a default request test and a streaming stop-reason test:

```python
def test_anthropic_client_uses_internal_default_max_tokens() -> None:
    sdk_client = FakeAnthropicSdkClient(
        {"id": "msg_1", "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"}
    )
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        sdk_client=sdk_client,
    )

    client.create_message(system=None, messages=[{"role": "user", "content": "Hi"}], tools=[])

    assert sdk_client.messages.kwargs["max_tokens"] == 8192


def test_anthropic_stream_rejects_max_tokens_stop_reason() -> None:
    sdk_client = TruncatedAnthropicStreamingSdkClient()
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        sdk_client=sdk_client,
    )

    with pytest.raises(ModelResponseError) as exc_info:
        list(client.stream_message(system=None, messages=[{"role": "user", "content": "Hi"}], tools=[]))

    assert exc_info.value.failure_kind == "output_token_limit"
```

Add equivalent non-streaming coverage for top-level `stop_reason="max_tokens"`.
Add focused stream fakes so this test exercises the public stream method:

```python
class TruncatedMessagesStreamResource(FakeMessagesResource):
    def __init__(self) -> None:
        super().__init__({"id": "unused", "content": []})

    def stream(self, **kwargs: object):
        self.kwargs = dict(kwargs)
        return iter([
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "partial"},
            },
            {"type": "message_delta", "delta": {"stop_reason": "max_tokens"}},
            {"type": "message_stop", "message": {"id": "msg_1"}},
        ])


class TruncatedAnthropicStreamingSdkClient:
    def __init__(self) -> None:
        self.messages = TruncatedMessagesStreamResource()
        self.closed = False

    def close(self) -> None:
        self.closed = True
```

- [ ] **Step 2: Run focused Anthropic tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_anthropic_messages_client.py -k 'internal_default or max_tokens_stop_reason' -v
```

Expected: constructor/default and truncation assertions fail.

- [ ] **Step 3: Add the internal default and typed truncation error**

Define and use a protocol-owned default:

```python
DEFAULT_ANTHROPIC_MAX_TOKENS = 8192

class AnthropicMessagesClient:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        max_output_tokens: int = DEFAULT_ANTHROPIC_MAX_TOKENS,
        log_service: WorkspaceLogService | None = None,
        log_context_provider: Callable[[], ModelLogContext] | None = None,
        sdk_client: object | None = None,
    ) -> None:
        self._max_output_tokens = max_output_tokens

    def reset_max_output_tokens(self) -> None:
        self._max_output_tokens = DEFAULT_ANTHROPIC_MAX_TOKENS
```

Raise a typed output-limit `ModelResponseError` for non-streaming `stop_reason == "max_tokens"` and for the stream's `message_delta.delta.stop_reason == "max_tokens"`. Expose `reset_max_output_tokens()` through `AnthropicMessagesModelAdapter` so internal summarization can restore the protocol default after a temporary budget.

- [ ] **Step 4: Run Anthropic tests**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_anthropic_messages_client.py tests/unit/infrastructure/models/test_anthropic_messages_adapter.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit the Anthropic change**

```bash
git add src/mycli/llms/clients/anthropic_messages.py src/mycli/llms/adapters/anthropic_messages_adapter.py tests/unit/infrastructure/test_anthropic_messages_client.py tests/unit/infrastructure/models/test_anthropic_messages_adapter.py
git commit -m "refactor: internalize anthropic output budget"
```

### Task 4: Remove Shared Output-Limit Configuration and Escalation

**Files:**
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/config/settings.py`
- Modify: `src/mycli/config/toml_format.py`
- Modify: `src/mycli/cli/bootstrap.py`
- Modify: `src/mycli/cli/main.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `src/mycli/application/runtime/recovery.py`
- Modify: `tests/unit/services/test_config_service.py`
- Modify: `tests/unit/domain/test_runtime.py`
- Modify: `tests/unit/cli/test_eval_cli.py`
- Modify: `tests/unit/application/test_turn_recovery_and_budget.py`
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tests/unit/application/test_agent_runtime_l4.py`

- [ ] **Step 1: Write failing configuration and bootstrap tests**

Change config tests to prove legacy keys are ignored and generated config omits them:

```python
def test_resolve_config_ignores_legacy_model_output_limit_settings(tmp_path: Path) -> None:
    config_path = tmp_path / "workspace" / ".mycli" / "config.toml"
    config_path.parent.mkdir(parents=True)
    config_path.write_text(
        "max_output_tokens = 2048\n"
        "output_limit_escalation_max_tokens = 65536\n"
        "output_recovery_retry_limit = 3\n",
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={"MYCLI_MAX_OUTPUT_TOKENS": "1024"},
        cwd=tmp_path / "workspace",
        home=tmp_path / "home",
    )

    assert not hasattr(config, "max_output_tokens")
    assert not hasattr(config, "output_limit_escalation_max_tokens")
    assert not hasattr(config, "output_recovery_retry_limit")
```

Add bootstrap assertions that Chat/Responses clients are created without an output-limit argument and Anthropic receives its internal default by omission.

- [ ] **Step 2: Run focused config/runtime tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py tests/unit/domain/test_runtime.py tests/unit/cli/test_eval_cli.py tests/unit/application/test_turn_recovery_and_budget.py -k 'output or recovery or eval' -q
```

Expected: failures because `AgentConfig`, config loading, eval propagation, and recovery still expose shared output budgets.

- [ ] **Step 3: Remove shared configuration fields and request wiring**

Delete these `AgentConfig` fields:

```python
max_output_tokens: int = 2048
output_limit_escalation_max_tokens: int = 65_536
output_recovery_retry_limit: int = 3
```

Remove their environment/TOML reads from `resolve_config()`, their generated TOML mappings, and `MYCLI_MAX_OUTPUT_TOKENS` propagation in eval mode. In `build_turn_service()`, stop passing an output budget to all three client constructors.

- [ ] **Step 4: Remove output-budget escalation while retaining typed failure handling**

Delete the `output_token_retries` member from `LoopState`, `escalated_max_output_tokens` from `TurnRecoveryAction`, the output-limit retry branch in `_recovery_action_for_model_error()`, the `output_tokens_escalated` request-loop state, and `output_limit_metadata()`.

Keep output-limit errors classified as model errors. They must finalize with failure rather than retrying with a client-selected larger budget.

Retain `_SummarizerClientAdapter`'s optional temporary max-token hooks for Anthropic only. Change restoration to call a protocol-owned reset method:

```python
def _restore_model_max_output_tokens(self) -> None:
    resetter = getattr(self._model_adapter, "reset_max_output_tokens", None)
    if callable(resetter):
        resetter()
```

Chat and Responses adapters no longer expose setters, so summarizer `max_tokens` is provider-managed for those protocols.

- [ ] **Step 5: Update tests and run the focused runtime suite**

Remove obsolete escalation fixtures/assertions and replace the recovery test with:

```python
def test_turn_executor_output_token_limit_fails_without_budget_retry(tmp_path: Path) -> None:
    adapter = AlwaysOutputTokenLimitAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("write a long answer")

    assert adapter.calls == 1
    assert response.turn is not None
    assert response.turn.status is TurnStatus.FAILED
    assert response.turn.stop_reason is StopReason.MODEL_ERROR
```

Run:

```bash
uv run pytest tests/unit/services/test_config_service.py tests/unit/domain/test_runtime.py tests/unit/cli/test_eval_cli.py tests/unit/application/test_turn_recovery_and_budget.py tests/unit/application/test_agent_runtime.py tests/unit/application/test_agent_runtime_l4.py -q
```

Expected: all tests pass.

- [ ] **Step 6: Commit shared configuration cleanup**

```bash
git add src/mycli/domain/runtime/__init__.py src/mycli/config/settings.py src/mycli/config/toml_format.py src/mycli/cli/bootstrap.py src/mycli/cli/main.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py src/mycli/application/runtime/recovery.py tests/unit/services/test_config_service.py tests/unit/domain/test_runtime.py tests/unit/cli/test_eval_cli.py tests/unit/application/test_turn_recovery_and_budget.py tests/unit/application/test_agent_runtime.py tests/unit/application/test_agent_runtime_l4.py
git commit -m "refactor: remove shared model output limits"
```

### Task 5: Verify Cross-Protocol Behavior

**Files:**
- Modify only if verification exposes a scoped defect in files already listed above.

- [ ] **Step 1: Confirm no model request path still serializes a shared limit**

Run:

```bash
rg -n 'max_output_tokens|max_tokens' src/mycli/llms src/mycli/infrastructure src/mycli/cli src/mycli/config src/mycli/domain/runtime
```

Expected: model-generation matches remain only in Anthropic protocol internals and generic error classification; tool-output budget files are outside this search scope or clearly unrelated.

- [ ] **Step 2: Run all Python tests**

Run:

```bash
uv run pytest -q
```

Expected: all tests pass.

- [ ] **Step 3: Run static checks**

Run:

```bash
uv run ruff check src tests
uv run mypy src
```

Expected: both commands pass without errors.

- [ ] **Step 4: Verify the request shape with a local fake-provider test**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_openai_client.py::test_openai_chat_client_omits_model_output_limit tests/unit/infrastructure/test_openai_client.py::test_openai_chat_client_rejects_streaming_length_finish_reason tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/test_anthropic_messages_client.py -q
```

Expected: Chat and Responses omit optional limits, Anthropic sends `8192`, and truncation tests pass.

- [ ] **Step 5: Review the final diff and repository status**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; unrelated pre-existing edits to `.codex/config.toml` and `docs/superpowers/plans/2026-07-17-codex-style-unified-shell-runtime-implementation.md` remain unstaged and unchanged.

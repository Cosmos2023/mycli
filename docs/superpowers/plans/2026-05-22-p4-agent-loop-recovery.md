# P4 Agent Loop Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden model-turn recovery so transient provider failures, output limits, fallback model attempts, heartbeats, and interrupted turns are classified, retried, observed, and resumed predictably.

**Architecture:** Keep the existing `TurnExecutor` loop and add a narrow recovery support module for retry/backoff metadata. Provider clients classify failures through one shared pure taxonomy function that returns stable `failure_kind` values; `TurnExecutor` maps those into retry, fallback, heartbeat, and finalization behavior. Recovery output is recorded as warnings/trace/progress only and never injected into model-visible provider input.

**Tech Stack:** Python 3.13, dataclasses, existing `AgentRuntime`, `TurnExecutor`, `ModelResponseError`, `ResponsesErrorFactory`, pytest, ruff, mypy. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-22-p4-agent-loop-recovery.md`

---

## File Structure

- `src/mycli/domain/runtime/protocol.py`: add `AUTH_FAILED`, `RATE_LIMITED`, and `INTERRUPTED` stop reasons.
- `src/mycli/domain/runtime/__init__.py`: add recovery config fields to `AgentConfig`.
- `src/mycli/domain/runtime/turn_state.py`: persist why a turn was suspended.
- `src/mycli/config/settings.py`: parse recovery config from env/project/user config.
- `src/mycli/application/runtime/recovery.py`: define `RetryBackoffPolicy`, transient/fallback/output metadata builders, and delay calculation.
- `src/mycli/application/runtime/turn_executor.py`: use recovery metadata, backoff sleeper, fallback model, configured output recovery, heartbeat, and interrupted stop reason.
- `src/mycli/application/runtime/agent_runtime.py`: expose test-injected sleeper/clock and restore model/max-output settings reliably.
- `src/mycli/llms/clients/responses_errors.py`: expose shared provider failure taxonomy by status/detail/code.
- `src/mycli/llms/clients/openai_chat.py`: classify chat-completions HTTP failures into the same taxonomy.
- `src/mycli/llms/clients/anthropic_messages.py`: classify Anthropic HTTP failures into the same taxonomy.
- `tests/unit/application/test_turn_recovery_and_budget.py`: runtime recovery behavior.
- `tests/unit/infrastructure/test_openai_responses_client.py`: Responses taxonomy tests.
- `tests/unit/infrastructure/test_openai_client.py`: chat-completions taxonomy tests.
- `tests/unit/infrastructure/test_anthropic_messages_client.py`: Anthropic taxonomy tests.
- `tests/unit/services/test_config_service.py`: config parsing tests.
- `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`: update recovery rows after implementation.
- `docs/superpowers/reports/2026-05-22-p4-agent-loop-recovery-smoke.md`: verification report.

---

### Task 1: Stop Reasons And Recovery Config

**Files:**
- Modify: `src/mycli/domain/runtime/protocol.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/domain/runtime/turn_state.py`
- Modify: `src/mycli/config/settings.py`
- Modify: `src/mycli/state/session_service.py`
- Modify: `tests/unit/domain/test_runtime.py`
- Modify: `tests/unit/services/test_session_service.py`
- Modify: `tests/unit/services/test_config_service.py`

- [ ] **Step 1: Write failing domain config tests**

Append to `tests/unit/domain/test_runtime.py`:

```python
def test_agent_config_exposes_recovery_defaults(tmp_path: Path) -> None:
    config = AgentConfig(workspace_root=tmp_path)

    assert config.fallback_model is None
    assert config.transport_retry_limit == 2
    assert config.output_limit_escalation_max_tokens == 65_536
    assert config.output_recovery_retry_limit == 3
    assert config.heartbeat_enabled is True
    assert config.heartbeat_interval_seconds == 30.0
```

Append to `tests/unit/services/test_config_service.py`:

```python
def test_config_service_reads_recovery_settings(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    config_path = workspace / ".mycli" / "config.toml"
    config_path.parent.mkdir()
    config_path.write_text(
        "\n".join(
            [
                'provider = "openai"',
                'model = "primary-model"',
                'fallback_model = "fallback-model"',
                "transport_retry_limit = 4",
                "output_limit_escalation_max_tokens = 32768",
                "output_recovery_retry_limit = 2",
                "heartbeat_enabled = false",
                "heartbeat_interval_seconds = 12.5",
            ]
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        cli_args={"session": "demo"},
        env={},
        cwd=workspace,
        home=home_dir,
    )

    assert config.fallback_model == "fallback-model"
    assert config.transport_retry_limit == 4
    assert config.output_limit_escalation_max_tokens == 32_768
    assert config.output_recovery_retry_limit == 2
    assert config.heartbeat_enabled is False
    assert config.heartbeat_interval_seconds == 12.5
```

Append to `tests/unit/services/test_session_service.py`:

```python
def test_suspended_turn_persists_suspend_reason(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path)
    suspended = SuspendedTurn(
        user_message="inspect",
        conversation=(Message(role="user", content="inspect"),),
        suspend_reason=StopReason.INTERRUPTED,
    )

    service.save_suspended_turn("demo", suspended)
    loaded = service.load_suspended_turn("demo")

    assert loaded is not None
    assert loaded.suspend_reason is StopReason.INTERRUPTED
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py::test_agent_config_exposes_recovery_defaults tests/unit/services/test_config_service.py::test_config_service_reads_recovery_settings tests/unit/services/test_session_service.py::test_suspended_turn_persists_suspend_reason -q
```

Expected: fails because the new `AgentConfig` fields and config parsing do not exist.

- [ ] **Step 3: Add stop reasons and AgentConfig fields**

In `src/mycli/domain/runtime/protocol.py`, extend `StopReason`:

```python
    AUTH_FAILED = "auth_failed"
    RATE_LIMITED = "rate_limited"
    INTERRUPTED = "interrupted"
```

In `src/mycli/domain/runtime/__init__.py`, add fields to `AgentConfig` after `max_output_tokens`:

```python
    fallback_model: str | None = None
    transport_retry_limit: int = 2
    output_limit_escalation_max_tokens: int = 65_536
    output_recovery_retry_limit: int = 3
    heartbeat_enabled: bool = True
    heartbeat_interval_seconds: float = 30.0
```

In `src/mycli/domain/runtime/turn_state.py`, import `StopReason` and extend `SuspendedTurn`:

```python
from mycli.domain.runtime.protocol import StopReason

...

    suspend_reason: StopReason = StopReason.INTERRUPTED
```

- [ ] **Step 4: Parse settings**

In `src/mycli/config/settings.py`, add value extraction near `max_output_tokens_value`:

```python
    fallback_model_value = (
        env.get("MYCLI_FALLBACK_MODEL")
        or project_config.get("fallback_model")
        or user_config.get("fallback_model")
    )
    transport_retry_limit_value = (
        env.get("MYCLI_TRANSPORT_RETRY_LIMIT")
        or project_config.get("transport_retry_limit")
        or user_config.get("transport_retry_limit")
        or 2
    )
    output_limit_escalation_max_tokens_value = (
        env.get("MYCLI_OUTPUT_LIMIT_ESCALATION_MAX_TOKENS")
        or project_config.get("output_limit_escalation_max_tokens")
        or user_config.get("output_limit_escalation_max_tokens")
        or 65_536
    )
    output_recovery_retry_limit_value = (
        env.get("MYCLI_OUTPUT_RECOVERY_RETRY_LIMIT")
        or project_config.get("output_recovery_retry_limit")
        or user_config.get("output_recovery_retry_limit")
        or 3
    )
    heartbeat_enabled_value = _parse_optional_bool(
        env.get("MYCLI_HEARTBEAT_ENABLED")
        or project_config.get("heartbeat_enabled")
        or user_config.get("heartbeat_enabled")
    )
    heartbeat_interval_seconds_value = (
        env.get("MYCLI_HEARTBEAT_INTERVAL_SECONDS")
        or project_config.get("heartbeat_interval_seconds")
        or user_config.get("heartbeat_interval_seconds")
        or 30.0
    )
```

Pass values into `AgentConfig(...)`:

```python
        fallback_model=str(fallback_model_value) if fallback_model_value else None,
        transport_retry_limit=int(str(transport_retry_limit_value)),
        output_limit_escalation_max_tokens=int(str(output_limit_escalation_max_tokens_value)),
        output_recovery_retry_limit=int(str(output_recovery_retry_limit_value)),
        heartbeat_enabled=True if heartbeat_enabled_value is None else heartbeat_enabled_value,
        heartbeat_interval_seconds=float(str(heartbeat_interval_seconds_value)),
```

Update `src/mycli/state/session_service.py` suspended-turn serialization/deserialization:

```python
"suspend_reason": suspended.suspend_reason.value,
```

When loading legacy suspended turns without that field, default to:

```python
StopReason.INTERRUPTED
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py::test_agent_config_exposes_recovery_defaults tests/unit/services/test_config_service.py::test_config_service_reads_recovery_settings tests/unit/services/test_session_service.py::test_suspended_turn_persists_suspend_reason -q
```

Expected: all targeted tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/domain/runtime/protocol.py src/mycli/domain/runtime/__init__.py src/mycli/domain/runtime/turn_state.py src/mycli/config/settings.py src/mycli/state/session_service.py tests/unit/domain/test_runtime.py tests/unit/services/test_config_service.py tests/unit/services/test_session_service.py
git commit -m "Expose agent loop recovery configuration"
```

Use Lore trailers:

```text
Constraint: Recovery policy must be explicit config, not inferred from provider/model names.
Rejected: Hardcode fallback model names | unsafe across providers and private deployments.
Confidence: high
Scope-risk: narrow
Tested: uv run pytest tests/unit/domain/test_runtime.py::test_agent_config_exposes_recovery_defaults tests/unit/services/test_config_service.py::test_config_service_reads_recovery_settings tests/unit/services/test_session_service.py::test_suspended_turn_persists_suspend_reason -q
```

---

### Task 2: Provider Failure Taxonomy

**Files:**
- Modify: `src/mycli/llms/clients/responses_errors.py`
- Modify: `src/mycli/llms/clients/openai_chat.py`
- Modify: `src/mycli/llms/clients/anthropic_messages.py`
- Modify: `tests/unit/infrastructure/test_openai_responses_client.py`
- Modify: `tests/unit/infrastructure/test_openai_client.py`
- Modify: `tests/unit/infrastructure/test_anthropic_messages_client.py`

- [ ] **Step 1: Write failing Responses taxonomy tests**

Append to `tests/unit/infrastructure/test_openai_responses_client.py`:

```python
def test_responses_error_factory_classifies_rate_limit_and_overload(tmp_path: Path) -> None:
    factory = ResponsesErrorFactory(
        logger=ResponsesClientLogger(
            base_url="https://api.test/v1",
            model="test-model",
            log_service=None,
        )
    )

    rate_limited = factory.classify_provider_failure(
        detail="rate limit exceeded",
        status_code=429,
        provider_error_code=None,
    )
    overloaded = factory.classify_provider_failure(
        detail="overloaded",
        status_code=529,
        provider_error_code=None,
    )

    assert rate_limited.stop_reason is StopReason.RATE_LIMITED
    assert rate_limited.failure_kind == "rate_limited"
    assert rate_limited.is_retryable is True
    assert overloaded.stop_reason is StopReason.RATE_LIMITED
    assert overloaded.failure_kind == "provider_overloaded"
    assert overloaded.is_retryable is True
```

Append:

```python
def test_responses_error_factory_classifies_auth_and_output_limit(tmp_path: Path) -> None:
    factory = ResponsesErrorFactory(
        logger=ResponsesClientLogger(
            base_url="https://api.test/v1",
            model="test-model",
            log_service=None,
        )
    )

    auth = factory.classify_provider_failure(
        detail="invalid api key",
        status_code=401,
        provider_error_code=None,
    )
    output = factory.classify_provider_failure(
        detail="max output tokens exceeded",
        status_code=None,
        provider_error_code="output_token_limit",
    )

    assert auth.stop_reason is StopReason.AUTH_FAILED
    assert auth.failure_kind == "auth_error"
    assert auth.is_retryable is False
    assert output.stop_reason is StopReason.MODEL_ERROR
    assert output.failure_kind == "output_token_limit"
    assert output.is_retryable is True
```

- [ ] **Step 2: Write failing chat and Anthropic taxonomy tests**

Append to `tests/unit/infrastructure/test_openai_client.py`:

```python
def test_openai_chat_status_errors_use_shared_failure_taxonomy() -> None:
    classification = classify_chat_provider_failure(
        detail="rate limit exceeded",
        status_code=429,
        provider_error_code=None,
    )

    assert classification.stop_reason is StopReason.RATE_LIMITED
    assert classification.failure_kind == "rate_limited"
    assert classification.is_retryable is True
```

Append:

```python
def test_openai_chat_status_error_sets_model_response_recovery_fields(tmp_path: Path) -> None:
    client = OpenAIChatClient(
        api_key="test",
        base_url="https://api.test/v1",
        model="test-model",
        max_output_tokens=128,
        log_service=WorkspaceLogService(workspace_root=tmp_path),
    )
    exc = _status_error(status_code=429, body={"error": {"message": "rate limit exceeded"}})

    error = client._status_error(exc=exc, request_path=None)

    assert error.stop_reason is StopReason.RATE_LIMITED
    assert error.failure_kind == "rate_limited"
    assert error.is_retryable is True
```

Append to `tests/unit/infrastructure/test_anthropic_messages_client.py`:

```python
def test_anthropic_status_errors_use_shared_failure_taxonomy() -> None:
    classification = classify_anthropic_provider_failure(
        detail="overloaded",
        status_code=529,
        provider_error_code=None,
    )

    assert classification.stop_reason is StopReason.RATE_LIMITED
    assert classification.failure_kind == "provider_overloaded"
    assert classification.is_retryable is True
```

Append:

```python
def test_anthropic_status_error_sets_model_response_recovery_fields(tmp_path: Path) -> None:
    client = AnthropicMessagesClient(
        api_key="test",
        base_url="https://api.anthropic.test",
        model="test-model",
        max_output_tokens=128,
        log_service=WorkspaceLogService(workspace_root=tmp_path),
    )
    exc = _status_error(status_code=529, body={"error": {"message": "overloaded"}})

    error = client._status_error(exc=exc, request_path=None)

    assert error.stop_reason is StopReason.RATE_LIMITED
    assert error.failure_kind == "provider_overloaded"
    assert error.is_retryable is True
```

- [ ] **Step 3: Run taxonomy tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_openai_responses_client.py::test_responses_error_factory_classifies_rate_limit_and_overload tests/unit/infrastructure/test_openai_responses_client.py::test_responses_error_factory_classifies_auth_and_output_limit tests/unit/infrastructure/test_openai_client.py::test_openai_chat_status_errors_use_shared_failure_taxonomy tests/unit/infrastructure/test_openai_client.py::test_openai_chat_status_error_sets_model_response_recovery_fields tests/unit/infrastructure/test_anthropic_messages_client.py::test_anthropic_status_errors_use_shared_failure_taxonomy tests/unit/infrastructure/test_anthropic_messages_client.py::test_anthropic_status_error_sets_model_response_recovery_fields -q
```

Expected: fails because classification helpers, `_status_error()` structured mapping, and new failure kinds do not exist.

- [ ] **Step 4: Implement shared taxonomy as a pure function**

In `src/mycli/llms/clients/responses_errors.py`, add a module-level pure function `classify_provider_failure(...)` with the current context-window classification plus the new output/auth/rate-limit branches:

```python
        output_markers = (
            "max output tokens",
            "output token",
            "completion token",
            "response too long",
        )
        auth_markers = ("api key", "authentication", "authorization", "unauthorized", "forbidden")
        if normalized_code in {"output_token_limit", "max_output_tokens", "output_tokens_exceeded"} or any(
            marker in normalized_detail for marker in output_markers
        ):
            return FailureClassification(
                stop_reason=StopReason.MODEL_ERROR,
                is_retryable=True,
                failure_kind="output_token_limit",
            )
        if status_code in {401, 403} or any(marker in normalized_detail for marker in auth_markers):
            return FailureClassification(
                stop_reason=StopReason.AUTH_FAILED,
                is_retryable=False,
                failure_kind="auth_error",
            )
        if status_code == 408:
            return FailureClassification(
                stop_reason=StopReason.TRANSPORT_FAILED,
                is_retryable=True,
                failure_kind="request_timeout",
            )
        if status_code == 429:
            return FailureClassification(
                stop_reason=StopReason.RATE_LIMITED,
                is_retryable=True,
                failure_kind="rate_limited",
            )
        if status_code == 529:
            return FailureClassification(
                stop_reason=StopReason.RATE_LIMITED,
                is_retryable=True,
                failure_kind="provider_overloaded",
            )
        if status_code in {500, 502, 503, 504}:
            return FailureClassification(
                stop_reason=StopReason.TRANSPORT_FAILED,
                is_retryable=True,
                failure_kind="provider_unavailable",
            )
```

Keep context-window classification before output/auth checks. Then update `ResponsesErrorFactory.classify_provider_failure(...)` to delegate to the module-level function for backward compatibility with existing factory callers.

- [ ] **Step 5: Reuse taxonomy from chat and Anthropic clients**

In `src/mycli/llms/clients/openai_chat.py`, add:

```python
from mycli.llms.clients.responses_errors import FailureClassification, classify_provider_failure
```

Add module helper:

```python
def classify_chat_provider_failure(
    *,
    detail: str,
    status_code: int | None,
    provider_error_code: str | None,
) -> FailureClassification:
    return classify_provider_failure(
        detail=detail,
        status_code=status_code,
        provider_error_code=provider_error_code,
    )
```

Add an `OpenAIChatClient._status_error(exc, request_path)` helper and use it in both `complete()` and `create_events()` `APIStatusError` handlers. Replace each existing inline `except APIStatusError as exc:` block with:

```python
        except APIStatusError as exc:
            raise self._status_error(exc=exc, request_path=request_path) from exc
```

The helper must call `classify_chat_provider_failure(...)`, log `failure_kind`, and construct `ModelResponseError(..., stop_reason=classification.stop_reason, is_retryable=classification.is_retryable, failure_kind=classification.failure_kind)`.

In `src/mycli/llms/clients/anthropic_messages.py`, add equivalent:

```python
def classify_anthropic_provider_failure(
    *,
    detail: str,
    status_code: int | None,
    provider_error_code: str | None,
) -> FailureClassification:
    return classify_provider_failure(
        detail=detail,
        status_code=status_code,
        provider_error_code=provider_error_code,
    )
```

Use the helper in `AnthropicMessagesClient._status_error(...)` so it no longer returns generic `StopReason.MODEL_ERROR` / `failure_kind="provider_error"` for all HTTP statuses.

- [ ] **Step 6: Run taxonomy tests**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_openai_responses_client.py::test_responses_error_factory_classifies_rate_limit_and_overload tests/unit/infrastructure/test_openai_responses_client.py::test_responses_error_factory_classifies_auth_and_output_limit tests/unit/infrastructure/test_openai_client.py::test_openai_chat_status_errors_use_shared_failure_taxonomy tests/unit/infrastructure/test_openai_client.py::test_openai_chat_status_error_sets_model_response_recovery_fields tests/unit/infrastructure/test_anthropic_messages_client.py::test_anthropic_status_errors_use_shared_failure_taxonomy tests/unit/infrastructure/test_anthropic_messages_client.py::test_anthropic_status_error_sets_model_response_recovery_fields -q
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/mycli/llms/clients/responses_errors.py src/mycli/llms/clients/openai_chat.py src/mycli/llms/clients/anthropic_messages.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/test_openai_client.py tests/unit/infrastructure/test_anthropic_messages_client.py
git commit -m "Classify provider recovery failures"
```

Use Lore trailers:

```text
Constraint: Turn recovery depends on stable failure_kind values across provider protocols.
Rejected: Keep generic http_error | cannot distinguish auth, rate limit, overload, and output recovery.
Confidence: medium
Scope-risk: moderate
Tested: uv run pytest taxonomy tests
```

---

### Task 3: Backoff Metadata And Recovery Warnings

**Files:**
- Create: `src/mycli/application/runtime/recovery.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `tests/unit/application/test_turn_recovery_and_budget.py`

- [ ] **Step 1: Write failing tests for backoff policy**

Update imports in `tests/unit/application/test_turn_recovery_and_budget.py`:

```python
from mycli.application.runtime.recovery import RetryBackoffPolicy
from mycli.domain.runtime import AgentConfig
```

Append to `tests/unit/application/test_turn_recovery_and_budget.py`:

```python
def test_retry_backoff_policy_calculates_capped_delays() -> None:
    policy = RetryBackoffPolicy(base_seconds=0.25, multiplier=2.0, max_seconds=1.0)

    assert policy.delay_for_attempt(1) == 0.25
    assert policy.delay_for_attempt(2) == 0.5
    assert policy.delay_for_attempt(3) == 1.0
    assert policy.delay_for_attempt(4) == 1.0
```

Append:

```python
class RetryTwiceThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
        if self.calls <= 2:
            raise ModelResponseError(
                "rate limited",
                stop_reason=StopReason.RATE_LIMITED,
                is_retryable=True,
                failure_kind="rate_limited",
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Recovered after backoff"),),
                ),
            ),
            done=True,
        )


def test_turn_executor_records_retry_backoff_metadata(tmp_path: Path) -> None:
    sleeps: list[float] = []
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=RetryTwiceThenDoneAdapter(),
    )
    runtime._recovery_sleep = sleeps.append
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        transport_retry_limit=2,
    )

    response = runtime.handle_user_turn("inspect")

    assert response.assistant_message == "Recovered after backoff"
    assert sleeps == [0.25, 0.5]
    warnings = [
        item for item in response.turn.items if item.type is TurnItemType.WARNING
    ]
    assert warnings[0].metadata["recovery_kind"] == "retry"
    assert warnings[0].metadata["failure_kind"] == "rate_limited"
    assert warnings[0].metadata["delay_seconds"] == 0.25
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_retry_backoff_policy_calculates_capped_delays tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_records_retry_backoff_metadata -q
```

Expected: fails because `RetryBackoffPolicy` and runtime sleeper handling do not exist.

- [ ] **Step 3: Add recovery support module**

Create `src/mycli/application/runtime/recovery.py`:

```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True, frozen=True)
class RetryBackoffPolicy:
    base_seconds: float = 0.25
    multiplier: float = 2.0
    max_seconds: float = 4.0

    def delay_for_attempt(self, attempt: int) -> float:
        if attempt <= 0:
            return 0.0
        delay = self.base_seconds * (self.multiplier ** (attempt - 1))
        return min(self.max_seconds, delay)


TRANSIENT_FAILURE_KINDS = frozenset(
    {
        "request_timeout",
        "rate_limited",
        "provider_overloaded",
        "provider_unavailable",
        "transport_error",
        "http_error",
    }
)


def is_transient_recovery_failure(*, failure_kind: str, is_retryable: bool) -> bool:
    return is_retryable or failure_kind in TRANSIENT_FAILURE_KINDS


def retry_metadata(
    *,
    attempt: int,
    max_attempts: int,
    delay_seconds: float,
    failure_kind: str,
) -> dict[str, object]:
    return {
        "recovery_kind": "retry",
        "attempt": attempt,
        "max_attempts": max_attempts,
        "delay_seconds": delay_seconds,
        "failure_kind": failure_kind,
    }


def fallback_metadata(
    *,
    from_model: str,
    to_model: str,
    failure_kind: str,
) -> dict[str, object]:
    return {
        "recovery_kind": "fallback_model",
        "from_model": from_model,
        "to_model": to_model,
        "failure_kind": failure_kind,
    }


def output_limit_metadata(
    *,
    attempt: int,
    max_attempts: int,
    failure_kind: str,
    original_max_output_tokens: int | None = None,
    escalated_max_output_tokens: int | None = None,
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "recovery_kind": "output_token_recovery",
        "attempt": attempt,
        "max_attempts": max_attempts,
        "failure_kind": failure_kind,
    }
    if original_max_output_tokens is not None:
        metadata["original_max_output_tokens"] = original_max_output_tokens
    if escalated_max_output_tokens is not None:
        metadata["escalated_max_output_tokens"] = escalated_max_output_tokens
    return metadata
```

- [ ] **Step 4: Wire sleeper and warning metadata**

In `src/mycli/application/runtime/agent_runtime.py`, initialize defaults:

```python
import time
```

In `AgentRuntime.__init__`:

```python
        self._recovery_sleep = time.sleep
```

In `src/mycli/application/runtime/turn_executor.py`, import `RetryBackoffPolicy`. When `recovery_action.should_retry`, before `continue`:

```python
                    if recovery_action.delay_seconds > 0:
                        runtime._recovery_sleep(recovery_action.delay_seconds)
```

When appending warning item, include metadata:

```python
                            metadata=recovery_action.metadata,
```

Extend `TurnRecoveryAction`:

```python
    delay_seconds: float = 0.0
    metadata: dict[str, object] = field(default_factory=dict)
```

Use `field` import from dataclasses.

In transient recovery branch, calculate:

```python
            delay_seconds = RetryBackoffPolicy().delay_for_attempt(attempt)
            metadata = retry_metadata(
                attempt=attempt,
                max_attempts=max(0, self._runtime._config.transport_retry_limit),
                delay_seconds=delay_seconds,
                failure_kind=failure_kind or "transport_error",
            )
```

Use `runtime._config.transport_retry_limit` instead of hardcoded `2`, and use `is_transient_recovery_failure(...)` instead of open-coded `exc.is_retryable or stop_reason is StopReason.TRANSPORT_FAILED`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_retry_backoff_policy_calculates_capped_delays tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_records_retry_backoff_metadata -q
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/application/runtime/recovery.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py tests/unit/application/test_turn_recovery_and_budget.py
git commit -m "Record model recovery retry backoff"
```

Use Lore trailers:

```text
Constraint: Tests must verify retry timing without actually sleeping.
Rejected: Immediate retry loop | worsens provider overload and hides retry behavior from trace.
Confidence: medium
Scope-risk: moderate
Tested: uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_retry_backoff_policy_calculates_capped_delays tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_records_retry_backoff_metadata -q
```

---

### Task 4: Fallback Model After Retry Exhaustion

**Files:**
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `tests/unit/application/test_turn_recovery_and_budget.py`

- [ ] **Step 1: Write failing fallback model test**

Append to `tests/unit/application/test_turn_recovery_and_budget.py`:

```python
class FallbackModelAdapter:
    def __init__(self) -> None:
        self.model = "primary-model"
        self.models_seen: list[str] = []

    def set_model(self, model: str) -> None:
        self.model = model

    def next_turn(self, *, items, tools):
        del items, tools
        self.models_seen.append(self.model)
        if self.model == "primary-model":
            raise ModelResponseError(
                "provider overloaded",
                stop_reason=StopReason.RATE_LIMITED,
                is_retryable=True,
                failure_kind="provider_overloaded",
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Recovered on fallback model"),),
                ),
            ),
            done=True,
        )


def test_turn_executor_uses_fallback_model_after_retry_exhaustion(tmp_path: Path) -> None:
    adapter = FallbackModelAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime._recovery_sleep = lambda delay: None
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        model="primary-model",
        fallback_model="fallback-model",
        transport_retry_limit=1,
    )

    response = runtime.handle_user_turn("inspect")

    assert response.assistant_message == "Recovered on fallback model"
    assert adapter.models_seen == ["primary-model", "primary-model", "fallback-model"]
    assert adapter.model == "primary-model"
    assert any(
        item.type is TurnItemType.WARNING
        and item.metadata.get("recovery_kind") == "fallback_model"
        and item.metadata.get("to_model") == "fallback-model"
        for item in response.turn.items
    )
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_uses_fallback_model_after_retry_exhaustion -q
```

Expected: fails because fallback model is not attempted.

- [ ] **Step 3: Add fallback state and action**

Extend `LoopState` in `turn_executor.py`:

```python
    fallback_model_attempted: bool = False
```

Ensure every `LoopState(...)` construction preserves this field.

Extend `TurnRecoveryAction`:

```python
    fallback_model: str | None = None
```

In `_recovery_action_for_model_error()`, after transient retry budget is exhausted:

```python
            fallback_model = self._runtime._config.fallback_model
            if fallback_model and not loop_state.fallback_model_attempted:
                return TurnRecoveryAction(
                    should_retry=True,
                    warning_text=f"Retry budget exhausted. Trying fallback model {fallback_model}.",
                    runtime_reminders=runtime_reminders,
                    next_state=LoopState(
                        context_window_retries=loop_state.context_window_retries,
                        transport_retries=loop_state.transport_retries,
                        output_token_retries=loop_state.output_token_retries,
                        context_recovery_stage=loop_state.context_recovery_stage,
                        reactive_compact_attempted=loop_state.reactive_compact_attempted,
                        fallback_model_attempted=True,
                    ),
                    fallback_model=fallback_model,
                    metadata=fallback_metadata(
                        from_model=self._runtime._config.model,
                        to_model=fallback_model,
                        failure_kind=failure_kind or "transport_error",
                    ),
                )
```

- [ ] **Step 4: Apply and restore fallback model**

In retry handling before `_request_model_turn` retry, when action has fallback model:

```python
                    if recovery_action.fallback_model is not None:
                        runtime._set_model(recovery_action.fallback_model)
```

After the retry request succeeds or finalizes, ensure model restored. Wrap fallback model use in `try/finally` and set a runtime-local restore guard:

```python
runtime._model_restored = False
try:
    runtime._set_model(recovery_action.fallback_model)
    ...
finally:
    runtime._restore_model()
    runtime._model_restored = True
```

At the start of `execute_user_turn()`, defensively call `runtime._restore_model()` when the adapter supports `set_model`, so a failed previous restore cannot silently leak fallback model state into a later turn.

Do not restore before a `continue` retry when the next request should use fallback; restore after that request returns or fails.

- [ ] **Step 5: Run fallback test**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_uses_fallback_model_after_retry_exhaustion -q
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/application/runtime/turn_executor.py src/mycli/application/runtime/agent_runtime.py tests/unit/application/test_turn_recovery_and_budget.py
git commit -m "Recover transient model failures with explicit fallback"
```

Use Lore trailers:

```text
Constraint: Fallback must be configured explicitly and must not switch provider protocols.
Rejected: Guess fallback model from provider family | brittle and unsafe for private deployments.
Confidence: medium
Scope-risk: moderate
Tested: uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_uses_fallback_model_after_retry_exhaustion -q
```

---

### Task 5: Configurable Output Token Recovery

**Files:**
- Modify: `src/mycli/domain/runtime/turn_state.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `tests/unit/application/test_turn_recovery_and_budget.py`

- [ ] **Step 1: Update output recovery test to require config**

Modify `test_turn_executor_output_token_limit_escalates_and_recovers` in `tests/unit/application/test_turn_recovery_and_budget.py`:

```python
def test_turn_executor_output_token_limit_escalates_and_recovers(
    tmp_path: Path,
) -> None:
    adapter = OutputTokenEscalateThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        max_output_tokens=2048,
        output_limit_escalation_max_tokens=32_768,
        output_recovery_retry_limit=2,
    )

    response = runtime.handle_user_turn("write a long answer")

    assert response.assistant_message == "Recovered with more output budget"
    assert adapter.output_token_budgets == [32_768, 2048]
    assert len(adapter.seen_items) == 2
    assert "output budget" in _runtime_reminder_text(adapter.seen_items[1]).lower()
    assert any(
        item.type is TurnItemType.WARNING
        and item.metadata.get("recovery_kind") == "output_token_recovery"
        and item.metadata.get("escalated_max_output_tokens") == 32_768
        for item in response.turn.items
    )
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_output_token_limit_escalates_and_recovers -q
```

Expected: fails because output recovery still hardcodes 65,536 and lacks metadata/restore.

- [ ] **Step 3: Use configured output recovery values**

In `turn_executor.py`, replace hardcoded `3` output retry limit with:

```python
            if loop_state.output_token_retries >= self._runtime._config.output_recovery_retry_limit:
                return TurnRecoveryAction(next_state=loop_state)
```

Replace hardcoded `65_536` with:

```python
                    escalated_max_output_tokens=self._runtime._config.output_limit_escalation_max_tokens,
                    metadata=output_limit_metadata(
                        attempt=1,
                        max_attempts=self._runtime._config.output_recovery_retry_limit,
                        failure_kind=failure_kind,
                        original_max_output_tokens=self._runtime._config.max_output_tokens,
                        escalated_max_output_tokens=self._runtime._config.output_limit_escalation_max_tokens,
                    ),
```

For later output recovery retries, metadata should include:

```python
                    metadata=output_limit_metadata(
                        attempt=loop_state.output_token_retries + 1,
                        max_attempts=self._runtime._config.output_recovery_retry_limit,
                        failure_kind=failure_kind,
                    ),
```

Ensure `runtime._restore_model_max_output_tokens()` is called after model request succeeds or finalizes, so the test observes `[32768, 2048]`.

- [ ] **Step 4: Run output recovery test**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_output_token_limit_escalates_and_recovers -q
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/turn_executor.py tests/unit/application/test_turn_recovery_and_budget.py
git commit -m "Make output token recovery policy configurable"
```

Use Lore trailers:

```text
Constraint: Output recovery must restore the session default after temporary escalation.
Rejected: Keep 65536 hardcoded | cannot tune for provider-specific limits.
Confidence: high
Scope-risk: narrow
Tested: uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_output_token_limit_escalates_and_recovers -q
```

---

### Task 6: Heartbeat Progress Events

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `tests/unit/application/test_turn_recovery_and_budget.py`

- [ ] **Step 1: Write failing heartbeat test**

Update the runtime import in `tests/unit/application/test_turn_recovery_and_budget.py` to include `RuntimeStreamEvent`:

```python
from mycli.domain.runtime import RuntimeStreamEvent
```

Append to `tests/unit/application/test_turn_recovery_and_budget.py`:

```python
class SlowSuccessfulAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Done after silence"),),
                ),
            ),
            done=True,
        )


def test_turn_executor_emits_heartbeat_without_model_visible_context(tmp_path: Path) -> None:
    ticks = [0.0]

    def monotonic() -> float:
        ticks[0] += 2.0
        return ticks[0]

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=SlowSuccessfulAdapter(),
    )
    runtime._monotonic = monotonic
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        heartbeat_enabled=True,
        heartbeat_interval_seconds=1.0,
    )
    stream_events: list[RuntimeStreamEvent] = []

    response = runtime.handle_user_turn("inspect", stream_sink=stream_events.append)

    assert response.assistant_message == "Done after silence"
    assert any(event.kind == "heartbeat" for event in stream_events)
    assert any("[heartbeat]" in update for update in response.progress_updates)
    history = runtime._session_service.load_history_items(runtime._config.session_id)
    assert all("[heartbeat]" not in (item.text or "") for item in history)
```

- [ ] **Step 2: Run heartbeat test to verify it fails**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_emits_heartbeat_without_model_visible_context -q
```

Expected: fails because heartbeat support does not exist.

- [ ] **Step 3: Add monotonic clock**

In `agent_runtime.py`, import `time` if not already imported and set:

```python
        self._monotonic = time.monotonic
```

- [ ] **Step 4: Emit heartbeat after silent model request**

In `turn_executor.py`, before `_request_model_turn(...)`:

```python
                request_started_at = runtime._monotonic()
```

After `_request_model_turn(...)` succeeds, before consuming blocks:

```python
                self._maybe_emit_heartbeat(
                    request_started_at=request_started_at,
                    progress_updates=progress_updates,
                    stream_sink=stream_sink,
                    activity_events=activity_events,
                )
```

Add helper method to `TurnExecutor`:

```python
    def _maybe_emit_heartbeat(
        self,
        *,
        request_started_at: float,
        progress_updates: list[str],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
        activity_events: list[ActivityEvent],
    ) -> None:
        runtime = self._runtime
        if not runtime._config.heartbeat_enabled:
            return
        elapsed = runtime._monotonic() - request_started_at
        if elapsed < runtime._config.heartbeat_interval_seconds:
            return
        message = "[heartbeat] model request still running"
        progress_updates.append(message)
        activity_events.append(ActivityEvent(kind="heartbeat", message=message))
        if stream_sink is not None:
            try:
                stream_sink(RuntimeStreamEvent(kind="heartbeat", text=message))
            except Exception:
                activity_events.append(
                    ActivityEvent(kind="stream_sink_error", message="heartbeat sink failed")
                )
```

This is a loop-boundary heartbeat only; do not write it to conversation/history/runtime items. It does not emit while a single blocking HTTP request is still in flight. The smoke report must call out that future complete heartbeat support needs stream timeout callbacks or cancellable request workers.

- [ ] **Step 5: Run heartbeat test**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_emits_heartbeat_without_model_visible_context -q
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/turn_executor.py tests/unit/application/test_turn_recovery_and_budget.py
git commit -m "Emit recovery heartbeat progress events"
```

Use Lore trailers:

```text
Constraint: Heartbeat must not become model-visible context or persisted conversation text.
Rejected: Background timer around blocking HTTP call | larger async runtime change than this batch needs.
Confidence: medium
Scope-risk: narrow
Tested: uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_emits_heartbeat_without_model_visible_context -q
```

---

### Task 7: Interrupted Turn Stop Reason

**Files:**
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `tests/unit/application/test_turn_recovery_and_budget.py`

- [ ] **Step 1: Update interrupt test**

Modify `test_turn_executor_finalizes_keyboard_interrupt_with_preserved_warning`:

```python
def test_turn_executor_finalizes_keyboard_interrupt_with_preserved_warning(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=KeyboardInterruptAdapter(),
    )

    response = runtime.handle_user_turn("inspect")

    assert response.turn is not None
    assert response.turn.status is TurnStatus.INTERRUPTED
    assert response.turn.stop_reason is StopReason.INTERRUPTED
    suspended = runtime._session_service.load_suspended_turn(runtime._config.session_id)
    assert suspended is not None
    assert suspended.suspend_reason is StopReason.INTERRUPTED
    assert any(
        item.type is TurnItemType.WARNING
        and item.text
        and "interrupt" in item.text.lower()
        and item.metadata.get("recovery_kind") == "interrupted_turn_saved"
        for item in response.turn.items
    )
```

- [ ] **Step 2: Run interrupt test to verify it fails**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_finalizes_keyboard_interrupt_with_preserved_warning -q
```

Expected: fails because stop reason is still `MODEL_ERROR` and warning metadata is missing.

- [ ] **Step 3: Update interrupted finalization**

In `_finalize_interrupted_turn()`, save the suspended turn with explicit reason:

```python
        runtime._session_service.save_suspended_turn(
            runtime._config.session_id,
            SuspendedTurn(
                user_message=user_message,
                conversation=tuple(conversation.messages),
                plan_state=current_plan_state,
                suspend_reason=StopReason.INTERRUPTED,
            ),
        )
```

Change warning item:

```python
            item=TurnItem(
                type=TurnItemType.WARNING,
                text=interrupt_warning,
                metadata={"recovery_kind": "interrupted_turn_saved"},
            ),
```

Change final stop reason:

```python
            stop_reason=StopReason.INTERRUPTED,
```

- [ ] **Step 4: Run interrupt tests**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_finalizes_keyboard_interrupt_with_preserved_warning tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_saves_and_resumes_interrupted_turn tests/unit/application/test_turn_recovery_and_budget.py::test_turn_executor_saves_interrupted_turn_during_pre_request_compaction -q
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/application/runtime/turn_executor.py tests/unit/application/test_turn_recovery_and_budget.py
git commit -m "Mark interrupted turns with explicit stop reason"
```

Use Lore trailers:

```text
Constraint: Interrupt is a recoverable user-control state, not a provider model error.
Rejected: Continue using MODEL_ERROR | obscures resume semantics in trace and history.
Confidence: high
Scope-risk: narrow
Tested: uv run pytest interrupt recovery tests
```

---

### Task 8: Integration Verification And Gap Docs

**Files:**
- Modify: `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`
- Create: `docs/superpowers/reports/2026-05-22-p4-agent-loop-recovery-smoke.md`

- [ ] **Step 1: Run focused recovery suite**

Run:

```bash
uv run pytest tests/unit/application/test_turn_recovery_and_budget.py -q
```

Expected: all tests pass.

- [ ] **Step 2: Run provider taxonomy suites**

Run:

```bash
uv run pytest tests/unit/infrastructure/test_openai_responses_client.py tests/unit/infrastructure/test_openai_client.py tests/unit/infrastructure/test_anthropic_messages_client.py -q
```

Expected: all tests pass.

- [ ] **Step 3: Run full verification**

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

Expected:

- ruff: `All checks passed!`
- mypy: `Success: no issues found`
- pytest: all tests passed

- [ ] **Step 4: Update gap doc**

In `docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md`, update current status to include P4:

```markdown
- P4 agent loop recovery：provider failure taxonomy、retry backoff evidence、explicit fallback model、configurable output token recovery、loop-boundary heartbeat、interrupted stop reason。
```

Update rows:

- `2.1 7个Continue点`: mention transport/rate-limit retry evidence, output recovery, interrupt stop reason, heartbeat; keep ⚠️.
- `2.5 OTK 三层升级`: mention configurable output token recovery; keep ⚠️.
- `2.6 529 fallback 机制`: mention 529 classification/retry/fallback model; keep ⚠️.
- `2.7 401 OAuth token 刷新 + 重试`: mention auth classification/hook only; keep ⚠️ or ❌ if hook not implemented.
- `2.8 Persistent mode heartbeat`: mention loop-boundary heartbeat; keep ⚠️.

- [ ] **Step 5: Write smoke report**

Create `docs/superpowers/reports/2026-05-22-p4-agent-loop-recovery-smoke.md`:

```markdown
# P4 Agent Loop Recovery Smoke

## Commands

- `uv run ruff check src tests`
- `uv run mypy src/mycli`
- `uv run pytest -q`

## Covered

- Provider failure taxonomy classifies rate limit, overload, auth, output limit, context window, and provider unavailable cases.
- Transient retry records backoff metadata.
- Explicit fallback model is attempted only after retry exhaustion and restores the primary model.
- Output token recovery uses configured limits and restores default max output tokens.
- Heartbeat progress events stay out of model-visible history.
- Interrupted turns use `StopReason.INTERRUPTED` and remain resumable.

## Not Covered

- No real provider rate-limit/auth smoke was intentionally triggered.
- No full async in-flight heartbeat timer; P4 heartbeat is loop-boundary only.
- No provider switching or OAuth refresh implementation.
```

- [ ] **Step 6: Commit docs**

```bash
git add docs/superpowers/specs/2026-05-18-mycli-vs-claude-code-gap.md docs/superpowers/reports/2026-05-22-p4-agent-loop-recovery-smoke.md
git commit -m "Document agent loop recovery verification"
```

Use Lore trailers:

```text
Constraint: Rate-limit and auth smoke should not deliberately stress a real provider account.
Rejected: Trigger real 429/401 manually | risks account side effects and noisy external failures.
Confidence: high
Scope-risk: narrow
Tested: uv run ruff check src tests; uv run mypy src/mycli; uv run pytest -q
Not-tested: Real provider 429/401 recovery path
```

---

## Self-Review Checklist

- [ ] Spec coverage: tasks cover taxonomy, retry backoff, fallback model, output recovery config, heartbeat, interrupt semantics, config parsing, gap docs, and smoke report.
- [ ] Placeholder scan: no `TBD`, `TODO`, or "write tests" without concrete tests.
- [ ] Type consistency: `RetryBackoffPolicy`, `fallback_model`, `transport_retry_limit`, `output_limit_escalation_max_tokens`, `output_recovery_retry_limit`, `heartbeat_enabled`, and `heartbeat_interval_seconds` are named consistently across tasks.
- [ ] Recovery context safety: heartbeat/retry warnings are runtime-visible only and not added as model-visible provider input.

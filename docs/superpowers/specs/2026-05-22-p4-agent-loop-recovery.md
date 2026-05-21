# P4 Agent Loop Recovery Pack

## 1. 背景

P0/P1/P2/P3 已经把上下文稳定化、工具安全、流式输出、Bash/file history、permission v1 和 sub-agent 基础能力补起来了。现在真实任务的主要风险点开始转向 agent loop 的恢复能力：模型请求、provider 限流、输出上限、用户中断和长时间无输出时，runtime 应该尽量恢复、降级或保留可继续状态，而不是直接失败。

当前 `TurnExecutor` 已有一部分基础恢复骨架：

- context window exceeded：先 drain redundant context，再 reactive compact，最多 retry 两次。
- output token limit：首次升级 `max_output_tokens` 到 65,536，再用 recovery reminder 最多 retry 三次。
- retryable transport error：最多 retry 两次。
- `KeyboardInterrupt`：保存 `SuspendedTurn`，下一次 user turn 自动 resume。
- stream client：Responses stream 已有内部 retry 和 create fallback 事件。

P4 不重写这条主链，而是在现有骨架上补齐“可配置、可观测、可验证”的恢复包：

1. 明确 provider failure 分类，让 429/529/rate limit、401/auth、output limit、context window 有稳定 `failure_kind` 和 stop reason。当前 Chat Completions 路径几乎不设置 `stop_reason/is_retryable/failure_kind`，Anthropic 路径也只有粗粒度 `provider_error`，这是本批必须补齐的基础工作。
2. 给 transport/rate-limit retry 增加退避策略和 trace/turn item 证据。
3. 增加可选 fallback model，保证只在 retry exhausted 后切换，完成后恢复主模型。
4. 把 output limit 升级从硬编码变成配置化三阶段策略。
5. 给 long-running / streaming-silent turn 增加 heartbeat，不进入模型上下文。
6. 强化 interrupted turn 的 stop reason 和 CLI resume 可见性。

## 2. 目标

### 2.1 Provider failure taxonomy

当前 `ResponsesErrorFactory.classify_provider_failure()` 把 408/409/429/500/502/503/504 都归为 generic `http_error`。P4 要细分：

| 条件 | failure_kind | stop_reason | retryable |
|---|---|---|---|
| context markers / context error code | `context_window_exceeded` | `CONTEXT_WINDOW_EXCEEDED` | false at provider classification layer; `TurnExecutor` still handles drain/reactive-compact retry at the higher recovery layer |
| output limit markers / output token error code | `output_token_limit` | `MODEL_ERROR` | true |
| HTTP 401/403 or auth markers | `auth_error` | `AUTH_FAILED` | true only when refresh hook exists |
| HTTP 408 | `request_timeout` | `TRANSPORT_FAILED` | true |
| HTTP 429 | `rate_limited` | `RATE_LIMITED` | true |
| HTTP 529 | `provider_overloaded` | `RATE_LIMITED` | true |
| HTTP 500/502/503/504 | `provider_unavailable` | `TRANSPORT_FAILED` | true |
| previous_response_id continuation rejection | existing continuation retry reason | existing behavior | existing behavior |
| other provider error | `provider_error` | `MODEL_ERROR` | false |

Requirements:

- Add `StopReason.AUTH_FAILED` and `StopReason.RATE_LIMITED`.
- Chat completions and Anthropic clients must surface the same `failure_kind` categories where their error handling sees status codes. This is not a small mapper tweak: `OpenAIChatClient` currently raises `ModelResponseError` without structured recovery fields for HTTP/status failures, so P4 must wire structured classification into both blocking and streaming chat paths.
- Output token limit detection must live in shared taxonomy, not only in Responses stream adapter inline logic, so Chat/Anthropic paths can trigger the same `TurnExecutor` output recovery policy when providers report output-length failures.
- Error logs must include `failure_kind` and `status_code`.
- Existing `ModelResponseError` API remains compatible.

### 2.2 Retry backoff and observability

Transport and rate-limit retries currently happen immediately. P4 adds deterministic backoff via injectable sleeper:

```python
RetryBackoffPolicy(
    base_seconds=0.25,
    multiplier=2.0,
    max_seconds=4.0,
    jitter_ratio=0.0,
)
```

Runtime behavior:

- `TurnExecutor` uses backoff before retrying `request_timeout`, `rate_limited`, `provider_overloaded`, `provider_unavailable`, and `transport_error`.
- Unit tests inject a no-op sleeper and assert the intended delays without slowing tests.
- Each recovery retry appends a `TurnItemType.WARNING` with metadata:
  - `recovery_kind`
  - `attempt`
  - `max_attempts`
  - `delay_seconds`
  - `failure_kind`
- Trace/rollout gets a `model_recovery_retrying` event with the same metadata.
- User-facing text stays concise; no raw provider body or API key-like content.

### 2.3 Fallback model

P4 adds optional model fallback for transient provider failure. It must be explicit config, never guessed.

Config:

- `fallback_model: str | None = None`
- env/project/user config key: `MYCLI_FALLBACK_MODEL` / `fallback_model`

Behavior:

- Fallback is considered only after normal transient retry budget is exhausted.
- Fallback is used for the current model turn only.
- Runtime calls adapter `set_model(fallback_model)` before fallback request and restores `config.model` in `finally`.
- The request shape and tool exposure stay the same except for model value at provider boundary.
- A `WARNING` turn item and trace event record `from_model`, `to_model`, and `failure_kind`.
- If fallback also fails, final error keeps the fallback error while warning metadata preserves original failure.

Non-goal:

- No provider switching.
- No model capability negotiation.
- No automatic Opus/Sonnet-style model name inference.

### 2.4 Output token recovery policy

Current output limit recovery hardcodes 65,536. P4 makes it configurable and safer:

Config:

- `output_limit_escalation_max_tokens: int = 65_536`
- `output_recovery_retry_limit: int = 3`

Behavior:

- First output limit failure escalates to `min(output_limit_escalation_max_tokens, provider_cap_if_known)`.
- Later output-limit failures retry with compact recovery reminders until `output_recovery_retry_limit`.
- After recovery completes or fails, runtime restores `config.max_output_tokens`.
- Warnings include metadata for original max output tokens and escalated max output tokens.

Non-goal:

- No provider-specific output cap discovery in this batch.

### 2.5 Heartbeat for silent turns

Long running turns should emit periodic progress without modifying model-visible context.

Config:

- `heartbeat_interval_seconds: float = 30.0`
- `heartbeat_enabled: bool = True`

Behavior:

- `TurnExecutor` records heartbeat progress when elapsed time since last visible stream/activity exceeds interval.
- Heartbeat appears as `RuntimeStreamEvent(kind="heartbeat")`, `progress_updates`, and rollout/trace event.
- Heartbeat text is stable and short: `[heartbeat] model request still running`.
- Heartbeat does not become a `RuntimeItem`, `Message`, `HistoryItem`, or provider input.
- Tests use an injected monotonic clock.

P4 accepts a minimal implementation that emits heartbeat before retry boundaries and after blocking model calls return if the elapsed silent time exceeded threshold. Full async timer while a blocking HTTP call is in-flight is explicitly deferred.

### 2.6 Interrupted turn semantics

Current interrupted turns save `SuspendedTurn` but finalize with `StopReason.MODEL_ERROR`. P4 changes this to:

- `TurnStatus.INTERRUPTED`
- `StopReason.INTERRUPTED`
- warning metadata `{"recovery_kind": "interrupted_turn_saved"}`
- `SuspendedTurn.suspend_reason = StopReason.INTERRUPTED`, persisted through `SessionService`, so resume/inspection code can distinguish user interruption from approval suspension or future pause reasons.

Resume behavior remains:

- Next user message resumes saved turn.
- The new user message is not injected into the suspended conversation as model-visible content.
- CLI response includes a concise resume indicator.

### 2.7 Recovery helper decomposition

`TurnExecutor._recovery_action_for_model_error()` is already large. P4 must not make it a monolithic policy object. Move reusable decisions into `src/mycli/application/runtime/recovery.py`:

- `RetryBackoffPolicy`
- transient failure predicate / retry metadata builder
- fallback metadata builder
- output-limit metadata builder

`TurnExecutor` remains responsible for loop state, context compaction, and finalization, but policy details should be small helpers with unit tests.

### 2.8 Fallback restore guard

Fallback model switching must be defensive:

- apply fallback with `runtime._set_model(fallback_model)`
- restore primary model in `finally`
- set a runtime-local `_model_restored` or equivalent guard when restore succeeds
- at the start of every user turn, defensively call `_restore_model()` if the adapter supports `set_model`
- if restore itself fails, record a warning/trace event and avoid masking the original model failure unless the restore failure is the only error

### 2.9 Heartbeat future interface

P4 heartbeat is intentionally loop-boundary only. It does not solve a single blocking HTTP call that stays silent for minutes. The future in-flight heartbeat needs one of these interfaces:

- model adapters expose stream-event timeout callbacks that can emit heartbeat while waiting for the next provider chunk
- or model requests run behind a cancellable worker/future that lets the main loop emit heartbeat and handle interrupt while the provider call is pending

P4 must document this limitation in the smoke report so loop-boundary heartbeat does not become mistaken for complete persistent-mode heartbeat.

### 2.10 Configuration and slash visibility

P4 keeps slash command scope small:

- `/context` remains context-only.
- `/usage` remains token/cost-only.
- No new recovery slash command in this batch.
- Recovery evidence is visible in turn activity, trace, and final smoke report.

## 3. 非目标

- 不做 full AsyncGenerator runtime rewrite。
- 不做真正 in-flight blocking HTTP heartbeat timer；只做 deterministic silent-gap heartbeat at loop boundaries。
- 不做 provider/account credential refresh implementation；只预留 auth refresh hook contract。
- 不做 provider switching 或 automatic model selection。
- 不做 OTK 8K→64K 之外的完整 Claude Code continuation 协议。
- 不做 fork cache sharing。
- 不做 MCP defer loading。
- 不改变 model-visible history 格式，除非为了现有 suspended turn 保存。

## 4. 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| 修改 | `src/mycli/domain/runtime/protocol.py` | 增加 `StopReason.AUTH_FAILED`、`RATE_LIMITED`、`INTERRUPTED` |
| 修改 | `src/mycli/domain/runtime/turn_state.py` | `SuspendedTurn` 增加 `suspend_reason` |
| 修改 | `src/mycli/domain/runtime/__init__.py` | `AgentConfig` 增加 fallback/recovery/heartbeat 配置 |
| 修改 | `src/mycli/config/settings.py` | 解析 fallback/recovery/heartbeat 配置 |
| 新建 | `src/mycli/application/runtime/recovery.py` | backoff policy、recovery metadata builders、fallback/output recovery helpers |
| 修改 | `src/mycli/application/runtime/turn_executor.py` | 使用 retry backoff、fallback model、metadata warning、heartbeat、interrupted stop reason |
| 修改 | `src/mycli/application/runtime/agent_runtime.py` | 注入 sleeper/clock，恢复 model/max_output_tokens |
| 修改 | `src/mycli/llms/clients/responses_errors.py` | provider failure taxonomy |
| 修改 | `src/mycli/llms/clients/openai_chat.py` | chat completions status error taxonomy |
| 修改 | `src/mycli/llms/clients/anthropic_messages.py` | Anthropic status error taxonomy |
| 测试 | `tests/unit/application/test_turn_recovery_and_budget.py` | recovery policy、fallback、heartbeat、interrupt semantics |
| 测试 | `tests/unit/infrastructure/test_openai_responses_client.py` | response error taxonomy |
| 测试 | `tests/unit/infrastructure/test_openai_client.py` | chat completion taxonomy |
| 测试 | `tests/unit/infrastructure/test_anthropic_messages_client.py` | Anthropic taxonomy |
| 测试 | `tests/unit/services/test_config_service.py` | config parsing |
| 报告 | `docs/superpowers/reports/2026-05-22-p4-agent-loop-recovery-smoke.md` | final verification evidence |

## 5. 验收标准

- 429 和 529 会被分类为 retryable rate-limit/overload，不再只是 generic `http_error`。
- 401/403 会被分类为 auth failure；无 refresh hook 时不无限 retry。
- transient retry 会记录 backoff delay metadata，并可在测试中通过 no-op sleeper 验证。
- fallback model 只在 transient retry exhausted 后触发，完成后恢复主模型。
- output token recovery 使用配置化 retry limit 和 max tokens，并在 turn 结束后恢复原 `max_output_tokens`。
- Chat Completions 和 Anthropic HTTP/status failure 会产生结构化 `failure_kind`，不再全部落到无结构或 generic provider error。
- `SuspendedTurn` 持久化挂起原因，interrupt 保存为 `StopReason.INTERRUPTED`。
- interrupted turn 使用 `StopReason.INTERRUPTED`，并仍可通过下一 turn resume。
- heartbeat 事件不进入 model-visible context/history。
- 全量 `ruff`、`mypy`、`pytest` 通过。
- 至少一条 smoke 使用 fake provider 或 controlled adapter 覆盖 fallback/heartbeat/retry evidence；真实 API smoke 可选，因为 rate-limit/auth 错误不应人为触发真实账号。

## 6. Gap 清单映射

| Gap | 本批结果 |
|---|---|
| 2.1 7个Continue点 | 从 ⚠️ 推进：补强 transport/rate-limit retry、output recovery、Ctrl+C stop reason、heartbeat；PTL/OTK 完整 Claude 协议仍开放 |
| 2.5 OTK 三层升级 | 从 ❌ 推进到 ⚠️：已有 output token escalation，P4 配置化并强化恢复证据；非完整 Claude OTK |
| 2.6 529 fallback 机制 | 从 ❌ 推进到 ⚠️：支持 529 分类、retry backoff 和 explicit fallback model；不做自动 Opus/Sonnet 推断 |
| 2.7 401 OAuth token 刷新 + 重试 | 从 ❌ 推进到 ⚠️：分类与 hook contract；真实 OAuth refresh implementation 延后 |
| 2.8 Persistent mode heartbeat | 从 ❌ 推进到 ⚠️：loop-boundary heartbeat；真正 in-flight async heartbeat 延后 |

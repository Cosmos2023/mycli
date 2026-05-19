# P2 Streaming Output

## 1. 背景

P1 已补齐 `/context`、`/usage`、Bash safety 和 Edit pre-read。下一步优先做不破坏 cache prefix 的 CLI 体验提升。Streaming output 是最小、收益最高的一步：它不改变上下文内容、不改 compaction 策略、不触碰 MCP defer loading，也不主动重写历史。

当前代码已经有底层 streaming 骨架：

- `OpenAIResponsesClient.stream_response()` 能消费 provider stream。
- `ResponsesModelAdapter.stream_turn()` 能把 provider stream 转成 `reasoning`、`text_delta`、`tool_call`、`completed` 事件。
- `ModelTurnRequester` 会优先使用 `stream_turn()`，并把 text delta 收集到 `TurnResponse.streamed_chunks`。
- CLI 现在只在 turn 完成后渲染 `streamed_chunks`，因此用户仍然看不到真实实时输出。

本批次目标是把现有 stream event 从 runtime 传到 CLI 的输出函数，使用户在模型生成时立即看到文本 delta 和关键 activity。

## 2. 范围

### 2.1 Runtime streaming sink

新增一个轻量 callback/sink，供 runtime 在模型 stream event 到达时同步通知 CLI。

第一版只要求同步 callback，不引入 async runtime：

```python
StreamingEventSink = Callable[[RuntimeStreamEvent], None]
```

事件至少覆盖：

- assistant text delta
- reasoning/activity delta
- tool call requested
- model stream completed

callback 失败不能让模型 turn 崩溃。runtime 应捕获 sink 异常，记录 activity/error，但继续完成模型请求。

### 2.2 CLI realtime rendering

CLI main loop 在处理普通用户消息时传入 stream sink。sink 直接调用 `output_func` 输出：

- assistant text delta：默认尽量按片段输出；stdlib fallback 可使用 `[stream] ...` 行。
- reasoning/activity：沿用 `[activity] ...` 风格。
- tool call：沿用 `[activity] Tool: ...` 风格。

由于当前 `run_repl()` 的输出接口是行级 `output_func(str)`，P2 不强制做无换行的 terminal live rendering。第一版可以选择“低风险行级 streaming”，即每个 delta 打一行，保证测试和非 TTY pipe 可预测。后续再单独做 rich live rendering。

### 2.3 避免重复输出

如果同一 turn 已经实时输出过 assistant text delta，最终 `handle_user_message()` 不应再把相同内容通过 `render_stream_lines()` 打一遍。

最终 assistant message 仍需输出一次，作为 turn 完整结果；但如果最终 assistant message 与 streaming delta 拼接完全相同，CLI 可以只输出最终 message 或只输出 stream 行之一。P2 推荐：

- 实时输出 `[stream] <delta>` 行。
- turn 完成后仍输出最终 assistant message。
- 不再输出 `render_stream_lines(response)` 的 post-hoc stream replay。

这样 transcript 和最终回答保持可见，同时避免 `[stream]` replay 重复。

### 2.4 Provider fallback

如果 model adapter 不支持 `stream_turn()`，保持现有 blocking 行为。

如果 provider stream 失败并由 existing client fallback 到 non-stream create，CLI 不需要特殊处理；最终 response 正常渲染。

### 2.5 非目标

- 不实现流式工具执行的新语义；当前已有 streamed tool call 事件消费，但工具仍由现有 turn loop 执行。
- 不做 AsyncGenerator runtime 重构。
- 不做 rich TUI live panel。
- 不做 token 级 diff 或 Markdown incremental rendering。
- 不改变 L4、cache、MCP 或 tool exposure 策略。
- 不改变 session transcript 的持久化格式。

## 3. 设计

### 3.1 Domain event

新增 `RuntimeStreamEvent` dataclass，放在 runtime domain 层或 runtime model helper 附近。字段：

- `kind: str`
- `text: str = ""`
- `tool_name: str | None = None`
- `metadata: dict[str, object]`

使用字符串 kind，避免为 P2 引入过重 enum。测试应锁住已支持的 kind。

### 3.2 Requester 边界

`ModelTurnRequester.request_model_turn()` 增加可选 `stream_sink` 参数。

在 `_request_streaming_turn()` 中：

- 收到 `reasoning` event：append block，并通知 `RuntimeStreamEvent(kind="reasoning", text=...)`。
- 收到 `text_delta` event：append block、append streamed chunk，并通知 `RuntimeStreamEvent(kind="text_delta", text=...)`。
- 收到 `tool_call` event：append block，并通知 `RuntimeStreamEvent(kind="tool_call", tool_name=...)`。
- 收到 `completed` event：记录 metadata，并通知 `RuntimeStreamEvent(kind="completed", metadata=...)`。

sink 调用通过 helper 包装，捕获异常。

### 3.3 Runtime wiring

`AgentRuntime.handle_user_turn()` 和 `TurnExecutor.execute_user_turn()` 增加可选 `stream_sink` 参数，并一路传给 `_request_model_turn()`。

`TurnService.handle_user_turn()` 同样增加可选 `stream_sink`，保持默认 `None`，不破坏现有测试和调用方。

### 3.4 CLI rendering

`src/mycli/cli/main.py` 创建 `stream_sink`：

```python
def emit_stream_event(event: RuntimeStreamEvent) -> None:
    for line in render_runtime_stream_event(event):
        output_func(line)
```

新增 `render_runtime_stream_event()` 到 `cli/rendering.py`：

- `text_delta` -> `[stream] {text}`
- `reasoning` -> `[activity] Thinking: {text}`，复用现有 semantic helper 可选
- `tool_call` -> `[activity] Tool: {tool_name}`
- `completed` -> 不输出，或只在 debug 中输出；P2 默认不输出

`handle_user_message()` 调用 `service.handle_user_turn(raw, stream_sink=emit_stream_event)`。完成后不再调用 `render_stream_lines(response)`，避免 replay。

### 3.5 Testing

测试分四层：

- `ModelTurnRequester`：stream events 到达时 sink 收到 `reasoning/text_delta/tool_call/completed`。
- `AgentRuntime`/`TurnService`：调用链能把 sink 传到底层 adapter。
- CLI rendering：`render_runtime_stream_event()` 输出稳定文本。
- REPL/main smoke 单测：模拟 streaming runtime，确认 `output_func` 在最终 assistant message 前收到 `[stream]` 行。

真实 CLI smoke 使用当前 provider 跑一个简短请求，观察至少出现 `[stream]` 行和最终回答。若 provider 不支持 streaming，应在报告中记录 fallback 行为。

## 4. 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| 修改 | `src/mycli/domain/runtime/__init__.py` | 增加 `RuntimeStreamEvent` |
| 修改 | `src/mycli/application/runtime/model/model_turn_requester.py` | 在 stream events 到达时调用 sink |
| 修改 | `src/mycli/application/runtime/agent_runtime.py` | handle/request 方法接受并传递 stream sink |
| 修改 | `src/mycli/application/runtime/turn_executor.py` | turn loop 传递 stream sink |
| 修改 | `src/mycli/application/turn_service.py` | service 层暴露可选 stream sink |
| 修改 | `src/mycli/cli/rendering.py` | 新增 runtime stream event 行渲染 |
| 修改 | `src/mycli/cli/main.py` | CLI 将 stream sink 绑定到 `output_func` |
| 测试 | `tests/unit/application/test_agent_runtime.py` | runtime sink 传递与 stream event 顺序 |
| 测试 | `tests/unit/cli/test_main.py`、`tests/integration/test_cli_repl.py` | CLI 渲染和输出顺序 |
| 报告 | `docs/superpowers/reports/2026-05-20-p2-streaming-output-smoke.md` | 记录验证和真实 CLI smoke |

## 5. 验收标准

- 支持 `stream_turn()` 的 adapter 在模型生成时能同步调用 stream sink。
- CLI 普通用户消息会实时输出 `[stream]` 行，而不是等 turn 完成后 replay。
- 最终 assistant answer 仍正常输出并持久化到 session。
- Tool call streaming 不改变现有工具执行语义。
- 不支持 streaming 的 adapter 保持现有 blocking 行为。
- `uv run ruff check src tests`、`uv run mypy src/mycli`、`uv run pytest -q` 通过。
- 真实 CLI smoke 报告记录 streaming 观察结果。

## 6. 风险与约束

- 行级 streaming 不是最终 UI；它优先保证稳定、可测、适合 pipe。
- 如果输出片段过碎，CLI 会产生很多 `[stream]` 行。P2 不做复杂 coalescing；后续可加最小间隔/按句聚合。
- Sink 异常必须被隔离，不能让模型请求失败。
- 不能把 streaming 输出写回模型上下文；它只是终端渲染。

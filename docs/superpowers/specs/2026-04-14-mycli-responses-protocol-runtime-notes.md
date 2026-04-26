## Responses Protocol Runtime Notes

这次 `formalize-responses-protocol-state-machine` 落地后，`mycli` 的 Responses 主链从“能跑”升级成了“有状态、有边界、可追踪”的 runtime 组件。

### Current Runtime Shape

- `src/mycli/schemas/responses_protocol.py`
  负责 typed protocol models、capability profile、continuation state 和 `function_call_output` payload 抽象。
- `src/mycli/infrastructure/responses_request_builder.py`
  负责 capability-aware request shaping，以及 `previous_response_id + delta input` 的保守续接判断。
- `src/mycli/infrastructure/openai_responses_client.py`
  负责 HTTP/SSE、stream termination 识别、continuation state 更新。
- `src/mycli/infrastructure/models/responses_adapter.py`
  优先消费 typed stream event / output item，并在 runtime blocks 与 Responses items 之间映射。
- `src/mycli/application/runtime/agent_runtime.py`
  在 turn 开始时加载 continuation state，在每次 model turn 完成或失败后持久化，并把关键状态写入 trace / workspace log。

### Capability Profiles

- 默认 profile 保持 OpenAI-style 行为：
  - 支持 reasoning
  - 支持 `previous_response_id`
  - 不强制 assistant content 从 `input_text` 转成 `output_text`
  - 不强制空 `function_call_output` 改写
- DashScope profile 走保守兼容路径：
  - `requires_assistant_output_text=True`
  - `disallows_empty_function_call_output=True`
  - `supports_previous_response_id=False`

这意味着 provider 差异不再散落在 client / adapter / prompt 里，而是集中到 capability profile 决策。

### Continuation State

session 中新增 `*-responses-state.json`，保存：

- `response_id`
- `request_signature`
- `request_input`
- `response_output`
- `eligible`
- `failure_reason`

runtime 行为：

- 每个 turn 开始前，把 session 中的 continuation state 注入 model adapter
- 每次 model turn 成功后，保存最新 continuation snapshot
- 每次 model turn 失败后，也会保存失效后的 snapshot

trace / log 中新增：

- `responses_continuation_loaded`
- `responses_continuation_persisted`

这样后续 turn 不需要任务级硬编码，就能继续沿用或放弃续接链路。

### Termination State Machine

当前显式处理的终止态包括：

- `response.completed`
- `response.failed`
- stream disconnect
- stream parse failure

约定如下：

- `response.completed`：允许 client 记录新的可续接状态
- `response.failed`：当前链路标记为不可续接，runtime 终止当前 turn
- disconnect / parse failure：同样会让 continuation state 失效，下一次请求自动回退 full create

这让 fallback 变成协议状态机的一部分，而不是临时补丁。

### Function Call Output Payload

`ResponsesFunctionCallOutputPayload` 现在支持：

- `body`
- `structured_content`
- `success`

当前外部 wire 兼容策略仍然是：

- 对 provider 发送 `output: <text>`
- richer payload 作为内部对象和 metadata 保留

runtime 在记录 tool result 时会把 payload 存入 block metadata：

- `function_call_output_payload.body`
- `function_call_output_payload.structured_content`
- `function_call_output_payload.success`

这为后续图片、结构化工具结果、多段输出等更通用的助手能力预留了内部扩展位。

### Verification

已完成的本地验证：

- `uv run pytest tests/unit/schemas/test_responses_protocol.py tests/unit/infrastructure/test_responses_request_builder.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/services/test_session_service.py tests/unit/application/test_agent_runtime.py -q`
- `uv run ruff check src/mycli/schemas/responses_protocol.py src/mycli/infrastructure/responses_request_builder.py src/mycli/infrastructure/models/responses_adapter.py src/mycli/infrastructure/openai_responses_client.py src/mycli/services/session_service.py src/mycli/application/runtime/agent_runtime.py tests/unit/schemas/test_responses_protocol.py tests/unit/infrastructure/test_responses_request_builder.py tests/unit/infrastructure/models/test_responses_adapter.py tests/unit/infrastructure/test_openai_responses_client.py tests/unit/services/test_session_service.py tests/unit/application/test_agent_runtime.py`

额外跑过一轮本地 smoke：

- continuation 正常 turn 会把 `response_id` 更新为新值并保持 `eligible=True`
- failure turn 会把 state 标记为不可续接，并写入 `failure_reason`

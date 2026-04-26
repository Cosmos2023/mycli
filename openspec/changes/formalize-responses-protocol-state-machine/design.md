## Context

当前 `mycli` 已经具备一条基本可工作的 Responses 主链：

- CLI 默认协议是 `responses`
- `OpenAIResponsesClient` 负责 HTTP 与 SSE
- `ResponsesModelAdapter` 负责在 runtime blocks 与 Responses 事件之间做映射
- `AgentRuntime` 负责消费流式事件并执行 tool loop

这条主链已经能支持一般的对话、流式工具调用和部分 provider 兼容补丁，但它离 Codex 风格的 Responses 运行时还有明显差距：

- 协议建模层过薄，裸字典与字符串分支过多
- runtime 没有把 `Responses` 当成连续协议，只是把它当成一种可流式返回的单次调用
- provider 差异没有收敛成显式能力矩阵
- tool output 没有正式的结构化抽象
- streaming failure 与 continuation fallback 仍是局部修补

Codex 在 `/tmp/openai-codex` 中体现出的关键方法是：

- `ResponseItem` 级别的强类型协议模型
- `ModelClient` / `ModelClientSession` 分离 session 与 turn 状态
- 用 `LastResponse`、`last_request`、`previous_response_id` 驱动增量续接
- 根据模型/ provider 能力决定请求字段，而不是固定请求体
- 把 `response.completed`、`response.failed`、断流、重连、fallback 视为正式状态机

本设计决定借鉴这些结构方法，但不照搬 Codex 的 Rust 实现细节，也不一次性引入 websocket transport。

## Goals / Non-Goals

**Goals:**

- 为 `mycli` 建立正式的 Responses 协议模型层
- 引入 session/turn 级的 continuation state，支持 `previous_response_id`
- 让 provider capability 成为显式对象，而不是一串兼容补丁
- 建立 tool output payload 的正式抽象
- 统一 stream completion / failure / disconnect / fallback 的状态机语义
- 保持这套能力服务于通用 agent，而不是任务专用协议链

**Non-Goals:**

- 本变更不要求一次性复刻 Codex 的 websocket prewarm / sticky routing / beta headers
- 不要求一次性支持 Codex 所有 `ResponseItem` 变体
- 不在本变更中引入 task-specific prompt routing
- 不在本变更中重写全部 runtime loop，只重构 Responses 适配边界

## Decisions

### 1. 引入显式 Responses 协议模型层

本变更决定新增一层 typed models，用于表达：

- request input item
- response output item
- stream event
- function call output payload
- provider capability profile
- continuation snapshot

建议放置位置：

- `src/mycli/schemas/responses_protocol.py`
- 或 `src/mycli/infrastructure/responses_protocol.py`

第一版不追求完全覆盖 Codex 的 `ResponseItem` 枚举，而是优先覆盖 `mycli` 当前实际使用的集合：

- `message`
- `reasoning`
- `function_call`
- `function_call_output`
- `response.completed`
- `response.failed`
- `output_text.delta`
- `reasoning_summary_text.delta`

这样做的原因是：

- 当前 `responses_adapter` 和 `openai_responses_client` 对协议字符串的直接判断过多
- 后续如果继续支持多 provider，裸字典分支会越来越难维护

未采用方案：

- 继续在 adapter/client 中用裸 `dict[str, object]` 演进。否决，因为边界会继续脆弱。

### 2. continuation state 必须成为 session/runtime 的正式部分

本变更决定让 `response continuity` 正式进入 session state。至少需要保存：

- `last_response_id`
- `last_normalized_request_input`
- `last_response_output_items`
- `continuation_eligibility`

当以下条件同时满足时，client MAY 使用 `previous_response_id`：

- provider capability 支持
- 当前请求与上一轮请求在非 input 字段上等价
- 当前 input 是上一轮 baseline 的严格扩展
- 上一轮以可续接的 completed 状态结束

否则 MUST 回退到 full create。

这样做的原因是：

- `response_id` 如果不参与后续请求，就只是日志字段
- Codex 的优势之一正是把 Responses 当连续协议来用

未采用方案：

- 仅记录 `response_id` 但不上升为 continuation state。否决，因为收益太低。

### 3. provider/model capability profile 负责 request shaping

本变更决定新增 capability profile，至少包括：

- `supports_reasoning`
- `supports_reasoning_summaries`
- `supports_parallel_tool_calls`
- `supports_previous_response_id`
- `requires_assistant_output_text`
- `disallows_empty_function_call_output`

`OpenAIResponsesClient` 不再直接假设所有 provider 都接受同一组字段，而是根据 capability profile 构造请求。

这样做的原因是：

- DashScope 兼容层已经证明 provider 虽然宣称兼容 Responses，但行为不完全一致
- 如果没有 capability profile，兼容补丁会继续散落

未采用方案：

- 每发现一个 provider 问题就继续加 if/else。否决，因为它不可扩展。

### 4. function_call_output 引入正式 payload 抽象

本变更决定让 tool result 不再只是一段文本，而是抽象为：

- `text body`
- `structured content items`
- `success/is_error` 元信息

第一版可以仍然默认渲染为文本，但内部模型必须支持 richer payload。

这样做的原因是：

- Codex 的 `FunctionCallOutputPayload` 已经证明 tool output 本质上应该是协议对象，而不是拼接字符串
- 这对未来的通用助手场景也重要，例如图片、结构化结果、多段文本

未采用方案：

- 继续把所有 tool result 都规约成单一字符串。否决，因为这会卡死后续扩展。

### 5. stream failure / completion / fallback 建立正式状态机

本变更决定把以下事件统一建模：

- `in_progress`
- `output_text.delta`
- `reasoning delta`
- `tool_call ready`
- `completed`
- `failed`
- `stream disconnected`
- `fallback to full create`

`response.failed` 不再是“未知事件”，而是协议终止态；  
断流也不再只是 transport 错误，而应被 runtime 识别为 continuation/fallback 决策输入。

这样做的原因是：

- 通用 agent 的稳定性不能建立在“最好别出错”的假设上
- Codex 在这点上更接近真正的 runtime，而不是简单 client wrapper

## Proposed Architecture

```text
AgentRuntime
  -> ResponsesTurnCoordinator
      -> ResponsesContinuationState
      -> ResponsesCapabilityProfile
      -> ResponsesRequestBuilder
      -> ResponsesTransportClient
      -> ResponsesStreamInterpreter
      -> ResponsesEventMapper
```

职责建议：

- `ResponsesTurnCoordinator`
  - 决定 full create / continuation create
  - 更新 continuation state
- `ResponsesRequestBuilder`
  - 基于 typed input + capability profile 构建请求体
- `ResponsesTransportClient`
  - 只负责 HTTP/SSE 传输，不做 runtime 语义判断
- `ResponsesStreamInterpreter`
  - 把原始 SSE payload 变成 typed stream events
- `ResponsesEventMapper`
  - 把 typed events 映射为 `ModelTurnResult` / runtime blocks

## Migration Plan

1. 建立 typed Responses protocol models。
2. 让 `responses_adapter` 先消费 typed event，而不是 provider 原始字典。
3. 引入 capability profile，并把现有 DashScope 兼容补丁收敛进去。
4. 为 session service 增加 continuation snapshot 持久化。
5. 引入 `previous_response_id` 请求路径与 full-create fallback。
6. 补齐 runtime / client / adapter 回归和真实 smoke。

## Risks / Trade-offs

- [风险] 新增一层 typed models 会提高初期代码量。  
  缓解：第一版只覆盖当前实际使用的协议子集。

- [风险] continuation 判断实现不严谨会造成请求错续接。  
  缓解：先要求“非 input 字段完全等价 + input 严格扩展”，宁可保守回退。

- [风险] provider capability profile 初期不完整。  
  缓解：默认 profile 走最保守路径，并把特殊兼容项显式测试化。

- [风险] 结构化 tool output 会影响现有日志与测试断言。  
  缓解：第一版保留文本渲染兼容层，对外行为尽量不破坏。

## Open Questions

- 第一版 continuation state 是只在内存中保存，还是同步落盘到 session 文件
- capability profile 是按 provider 粗粒度定义，还是允许 provider+model 双层覆盖
- 第一版是否只支持 HTTP Responses，还是提前为 websocket 结构预留接口

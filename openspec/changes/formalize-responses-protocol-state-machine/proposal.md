## Why

`mycli` 现在已经能以 `responses` 协议运行，但整体适配仍偏“可用的兼容客户端”，还没有升级成真正理解 Responses 协议的通用 agent runtime。

当前主要问题有：

- `Responses` 输入输出主要仍以裸 `dict` 和事件字符串判断为主，协议边界不够稳定
- `response_id` 虽然已经出现在 runtime 与 session 中，但还没有真正用于 `previous_response_id` 驱动的连续请求
- provider / model 差异目前主要通过兼容补丁处理，缺少显式 capability profile
- tool output 目前基本退化成文本摘要，尚未形成对 `function_call_output` 结构化 payload 的正式建模
- streaming error、provider failure、continuation fallback 还没有成为统一状态机，只是零散分支

在 `/tmp/openai-codex` 中，Codex 对 Responses 的借鉴重点不是某个 prompt，而是：

- 强类型协议模型
- session/turn 分层的连续状态
- `previous_response_id` 驱动的增量续接
- provider capability-aware request building
- 对流式失败、完成、续接和 fallback 的正式状态机

如果 `mycli` 要追赶 Codex，并且目标是通用型个人助手 agent，而不是任务特化型仓库分析器，那么 Responses 适配层必须从“兼容实现”升级为“协议状态机”。

## What Changes

- 为 `mycli` 引入正式的 Responses 协议模型层，而不是让 adapter/client 长期直接操作 provider 原始字典。
- 定义 `response continuity` 主链：保存上轮可续接状态，并在条件满足时使用 `previous_response_id + delta input`，失败时自动回退到完整 create。
- 引入 provider/model capability profile，用于控制：
  - 是否支持 reasoning / reasoning summaries
  - 是否支持 parallel tool calls
  - 是否支持 `previous_response_id`
  - 是否接受 assistant `output_text`
  - 是否允许空 `function_call_output`
- 把 Responses streaming 的完成、失败、断流、provider failure、fallback 与 continuation 统一为正式状态机，而不是零散分支。
- 为 `function_call_output` 引入结构化 payload 抽象，使 tool result 不再只能退化为单一字符串。
- 保持设计目标是通用 agent runtime 升级，不为仓库分析、代码修改、debug 等某一类任务单独定制协议主链。

## Capabilities

### New Capabilities
- `responses-protocol-state-machine`: 定义 Responses 请求、流式事件、tool output payload、continuation state 和 provider capability profile 的正式边界与状态迁移。

### Modified Capabilities
- `upgrade-responses-agent-runtime`: 从“让 runtime 支持 Responses”升级为“让 runtime 理解 Responses 连续协议”。
- `layered-instruction-contract`: 后续可以与 typed Responses input item 对接，而不是只渲染成单一 prompt 字符串。
- `agent-runtime-decision-policy`: 后续可以利用 response continuity 和 provider capability 状态作更稳健的运行时决策。

## Impact

- 受影响代码：
  - `src/mycli/infrastructure/openai_responses_client.py`
  - `src/mycli/infrastructure/models/responses_adapter.py`
  - `src/mycli/application/runtime/agent_runtime.py`
  - `src/mycli/services/session_service.py`
  - 新的 Responses 协议模型 / capability profile / continuation state 模块
- 受影响行为：
  - Responses 请求体构造
  - streaming error 与 completion 的处理方式
  - tool result 如何映射为 `function_call_output`
  - 是否以及何时使用 `previous_response_id`
  - provider 兼容策略的表达方式
- 受影响测试：
  - responses client / adapter 单测
  - runtime continuation / fallback 回归
  - session state round-trip
  - 至少一轮真实 provider smoke

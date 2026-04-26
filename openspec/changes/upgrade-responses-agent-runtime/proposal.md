## Why

`mycli` 现在虽然已经默认走 OpenAI Responses API，但对 Responses 返回内容的适配仍然停留在“最小可运行”层面。`reasoning`、`summary`、更完整的 `message`/`function_call` 语义还没有真正进入 runtime 和 CLI，这导致模型明明已经返回了 agent 过程信息，前台却看不到，runtime 也无法稳定利用这些信息做更像 agent 的执行。

现在补这一层是合理的，因为 `mycli` 已经具备 Responses-first 链路、activity stream 和工作区日志，缺的不是基础设施，而是把 Responses 真正当作 agent 协议来消费。只有把这一步做好，`mycli` 才能从“能调 Responses”升级为“按 Responses 语义工作的 agent”。

## What Changes

- 扩展 `ResponsesModelAdapter`，正式适配 `reasoning`、`summary`、`function_call`、`message.output_text` 等 agent-native output item。
- 扩展 runtime block/result 契约，保留必要的 Responses provider metadata，并让 runtime 能把 reasoning 作为一等执行信号消费。
- 为 Responses client 增加 streaming 能力，使 runtime 和 CLI 不必等待完整 response 结束后才知道模型正在做什么。
- 扩展 CLI 活动流与前台输出，让用户能看到模型正在分析、规划、决定调用工具以及逐步形成答案的过程。
- 增加 Responses item / streaming event 的日志与测试，确保未知 item、非流式路径和流式路径都可诊断、可回归验证。

## Capabilities

### New Capabilities
- `responses-agent-runtime`: 定义系统如何将 OpenAI Responses 返回的 agent-native item 映射到 `mycli` 的 runtime block 和执行语义中。
- `responses-agent-streaming`: 定义系统如何消费 Responses streaming 事件，并将 agent 执行过程和逐步形成的答案展示到 CLI。

### Modified Capabilities
- None.

## Impact

- 受影响代码：`src/mycli/infrastructure/openai_responses_client.py`、`src/mycli/infrastructure/models/responses_adapter.py`、`src/mycli/domain/runtime/*`、`src/mycli/application/runtime/agent_runtime.py`、`src/mycli/cli/main.py`
- 可能受影响的辅助层：活动流渲染、工作区日志、Responses 调试路径
- 受影响测试：Responses client 测试、Responses adapter 测试、runtime 测试、CLI 渲染测试
- 外部 API 和依赖：继续使用 OpenAI Responses API，不新增第三方依赖
- 用户可见影响：`mycli` 会更像一个真正的 agent，能够更完整地展示模型分析过程、工具调用决策和逐步形成的答案

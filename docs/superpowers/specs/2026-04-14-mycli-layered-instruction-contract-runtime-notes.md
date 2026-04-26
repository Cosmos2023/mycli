## Layered Instruction Contract Runtime Notes

`mycli` 现在将模型输入主链拆成了四个职责明确的部分：

- `base instructions`：稳定、低频变化的通用代理契约
- `developer instructions`：turn-scoped 的 runtime policy、tool exposure 等运行时约束
- `contextual user fragments`：workspace instructions、environment context、capability bodies、dynamic tool context、memory/plan/conversation context
- `conversation messages`：真实对话与工具交互历史

这套结构的目标是让 `mycli` 更接近通用 agent runtime，而不是继续围绕某种单一任务堆 prompt patch。

### Current Boundaries

- `TurnContextAssembler` 继续负责来源装配
- `InstructionContractAssembler` 负责把 `TurnContext` 转成模型可消费的分层契约
- `AgentRuntime`、`TurnService` 和 `ReactAgent` 现在消费 `InstructionContract`，而不是直接把 `system.py`、`react.py` 和 capability 特判硬拼在一起
- prompt scaffolding 片段带有 `include_in_memory` 语义，方便后续 memory/summary 过滤继续演进

### Why This Matters

- 后续接入更多 capability、dynamic tools、Responses-style provider 或多 surface 时，不需要再新增任务专用 prompt 主链
- runtime policy 可以继续通过 developer layer 表达差异，而不是退回到关键词硬编码
- trace / log 已经能看到 `instruction_contract` 的装配摘要，便于调试“模型这一轮到底看到了什么”

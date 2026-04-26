## Why

`mycli` 现在已经有了 memory、plan、skill、runtime reminder、conversation summary 和 tool list，但这些内容仍然分散在 `ExecutionContext`、`AgentRuntime` 和 `build_react_prompt()` 的不同层里，以“先收集字段，再直接拼成 prompt 字符串”的方式工作。这样虽然能跑，但它还不是一条正式的 turn 主链，也缺少稳定的插槽来承接后续的 capability injection、tool exposure 和 surface 语义收敛。

随着 `productize-agent-runtime` 和 `improve-agent-exploration-discipline` 的推进，这个缺口已经越来越明显：如果没有正式的 turn-time context assembly 层，后续继续叠加 skills、MCP、dynamic tools、workspace instructions 或 runtime policy，只会让 prompt 变得更大、更散、更难验证。现在补这一层，正好可以把下一阶段路线图里的第一块骨架落下来。

## What Changes

- 引入正式的 `turn-context-assembly` 能力，定义一轮 turn 在调用模型前如何从多个来源收集、整理并排序上下文。
- 将当前零散的上下文来源拆分为清晰的 section/slot，例如 base instructions、workspace/project instructions、conversation context、memory、plan、runtime reminders、capability sections、environment/tool exposure。
- 让 prompt 生成逻辑消费“已装配好的 turn context”，而不是直接读取扁平 `ExecutionContext` 并自行拼接字符串。
- 保持当前 `Responses` runtime、activity stream 和 turn protocol 不被推翻，第一版只重构 turn 上下文进入模型前的装配边界。
- 为后续 `skills` 产品化、MCP/dynamic tools 暴露和更丰富 surface 提前建立稳定接入点。

## Capabilities

### New Capabilities
- `turn-context-assembly`: 定义 `mycli` 如何在每一轮模型调用前，从 runtime、workspace、conversation、memory、plan 与 capability 来源装配确定性的上下文结构。

### Modified Capabilities
- None.

## Impact

- 受影响代码：`src/mycli/domain/runtime/__init__.py`、`src/mycli/application/runtime/agent_runtime.py`、`src/mycli/prompts/react.py`，以及后续新增的 context assembly 服务或 schema 模块
- 受影响能力：prompt shaping、runtime reminder 注入、skill/context 注入、tool exposure summary
- 受影响测试：prompt 组装测试、runtime context 构建测试、repo-analysis/exploration discipline 相关回归测试
- 用户可见影响：短期主要体现在 agent 行为更稳定、探索过程更一致；长期为 skills、MCP、dynamic tools 和多 surface 打下统一主链基础

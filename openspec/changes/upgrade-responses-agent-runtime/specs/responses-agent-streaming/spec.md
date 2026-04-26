## ADDED Requirements

### Requirement: 系统必须支持 Responses streaming 事件消费
系统必须支持消费 OpenAI Responses 的 streaming 事件，以便在 response 完整结束前就能逐步获得 reasoning、工具决策和答案文本。

#### Scenario: streaming reasoning 被尽早消费
- **WHEN** provider 在 streaming 响应中发出 reasoning 相关事件
- **THEN** 系统必须在本轮 response 完整结束前消费这些事件，并将其归一化为 runtime 可用的执行语义

#### Scenario: streaming function call 被尽早消费
- **WHEN** provider 在 streaming 响应中发出 function call 完成或可执行事件
- **THEN** 系统必须在不等待完整 response 结束的情况下识别该调用并推进后续执行链路

### Requirement: CLI 必须显示基于 Responses 的执行过程
CLI 必须将 Responses-derived reasoning 和工具决策转换为用户可见的执行活动，让用户知道 agent 正在分析什么、准备做什么和正在执行什么。

#### Scenario: 前台显示模型分析过程
- **WHEN** runtime 在一轮处理中收到 Responses reasoning 语义
- **THEN** CLI 必须显示对应的 `thinking` 或 `planning` 活动，而不是只在工具执行时才有可见输出

#### Scenario: 前台显示工具决策与执行
- **WHEN** runtime 因 Responses function call 准备执行工具
- **THEN** CLI 必须显示对应工具活动，并保持与现有 activity stream 风格兼容

### Requirement: CLI 必须能展示逐步形成的答案
系统必须允许 CLI 在流式模式下逐步展示 assistant 文本形成过程，而不是只能等待完整 assistant_message 返回后一次性显示。

#### Scenario: streamed answer chunk 被渲染
- **WHEN** streaming 响应中产生新的 assistant 文本片段
- **THEN** CLI 必须能够按顺序渲染这些片段，并在最终答案完成后保持一致的最终文本

#### Scenario: streamed output 不破坏现有渲染顺序
- **WHEN** 一轮 turn 同时包含 activity、error、plan、decision 或 streamed answer
- **THEN** CLI 必须保持稳定的输出顺序，而不能因为 streamed answer 加入而破坏现有交互

### Requirement: 系统必须记录 Responses streaming 的诊断信息
系统必须为 streaming 路径保留基本诊断日志，以便在“模型返回了流式内容但前台没显示”时可以快速定位问题边界。

#### Scenario: streaming 生命周期写入日志
- **WHEN** 系统开始、推进或结束一轮 Responses streaming
- **THEN** 它必须记录足够的生命周期信息，用于区分 client、adapter、runtime 和 CLI 哪一层丢失了内容

#### Scenario: streaming 解析异常不会静默吞掉
- **WHEN** streaming 路径发生可捕获的解析异常或不支持事件
- **THEN** 系统必须记录诊断信息，而不能静默忽略该问题

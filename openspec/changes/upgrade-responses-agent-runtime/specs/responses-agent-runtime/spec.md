## ADDED Requirements

### Requirement: 系统必须完整消费 Responses 的 agent-native 输出项
系统必须将 OpenAI Responses 返回中的 agent-native output item 映射为 `mycli` 可消费的 runtime 语义，而不能只处理最基础的 `function_call` 和文本输出。

#### Scenario: reasoning summary 映射为 runtime reasoning block
- **WHEN** Responses 返回一个 `type: "reasoning"` 的 output item，且其中包含 `summary` 文本
- **THEN** 系统必须把该 summary 文本映射为至少一个 `reasoning` 类型的 runtime block

#### Scenario: function call 保留完整调用语义
- **WHEN** Responses 返回一个 `type: "function_call"` 的 output item
- **THEN** 系统必须保留 tool name、arguments、call_id 和可用的 provider metadata，并将其映射为可执行的 tool-call runtime block

#### Scenario: message output text 映射为最终文本块
- **WHEN** Responses 返回 `message` 或 `output_text` 类型的文本内容
- **THEN** 系统必须将其映射为 runtime text block，以便后续形成最终 assistant 答案

### Requirement: 系统必须保留 Responses provider 元数据
系统必须为 runtime 和调试路径保留必要的 Responses provider metadata，例如 response id、item status 和 usage，而不能在适配过程中全部丢失。

#### Scenario: response 级元数据挂在 turn result 上
- **WHEN** Responses 返回 response id、status 或 usage 等顶层元数据
- **THEN** 系统必须在本轮模型结果中保留这些元数据，供 runtime、日志或前台后续使用

#### Scenario: item 级元数据挂在 runtime block 上
- **WHEN** Responses output item 提供 item id、status 或原始 item type
- **THEN** 系统必须把这些信息保留到对应 runtime block 的 metadata 中

### Requirement: 系统必须将 Responses reasoning 作为运行时执行信号
系统必须把 Responses reasoning 视为 agent 执行过程的一等信号源，而不是只把工具调用作为执行过程来源。

#### Scenario: reasoning 驱动 thinking activity
- **WHEN** runtime 消费到一段 Responses reasoning 文本
- **THEN** 它必须生成用户可见的 `thinking` 或 `planning` 执行活动，而不是静默忽略该内容

#### Scenario: reasoning 与工具执行共同构成执行链路
- **WHEN** 同一轮模型响应同时包含 reasoning 和 function call
- **THEN** 系统必须同时保留 reasoning 活动和对应工具执行，而不能在消费 tool call 时丢弃 reasoning 语义

### Requirement: 系统必须对未知 Responses item 保持韧性
系统在遇到第一版未正式支持的 Responses output item 时，必须优先保持运行链路可继续，而不能因为未知 item 直接导致整轮 turn 失败。

#### Scenario: 未知 item 被记录并忽略
- **WHEN** Responses 返回一个当前未支持的 output item type
- **THEN** 系统必须记录 warning 级诊断信息，并在安全前提下忽略该 item

#### Scenario: 已知 item 继续被正常消费
- **WHEN** 同一 response 同时包含未知 item 和已知 item
- **THEN** 系统必须继续消费已知 item，并保持这一轮 turn 可继续推进

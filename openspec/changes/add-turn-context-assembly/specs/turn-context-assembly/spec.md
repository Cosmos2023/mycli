## ADDED Requirements

### Requirement: 系统必须在每轮模型调用前装配正式的 turn context
`mycli` MUST 在每一轮调用模型前，将来自 runtime、conversation、memory、plan、workspace 和 capability 的上下文来源装配为正式的 turn context，而不是让 prompt 构建逻辑直接读取零散字段。

#### Scenario: 装配发生在 prompt 渲染之前
- **WHEN** runtime 准备为当前用户请求构建模型输入
- **THEN** 系统 MUST 先生成一份 turn context 对象，再由 prompt renderer 或 provider adapter 消费它

#### Scenario: 装配结果与原始来源分离
- **WHEN** runtime 收集 memory、conversation、plan、tool list 或 active skill 等来源
- **THEN** 系统 MUST 区分“原始来源数据”和“已装配的 turn context section”，而不是直接把来源字段拼进 prompt

### Requirement: 系统必须定义确定性的 context section 顺序
`mycli` MUST 为 turn context 定义稳定的 section 类型与装配顺序，以保证同类上下文总是以一致位置进入模型输入。

#### Scenario: 核心 section 顺序稳定
- **WHEN** turn context 被装配
- **THEN** 系统 MUST 至少为 base instructions、workspace/project instructions、conversation context、memory/plan、runtime reminders、capability sections、tool exposure 和 current user request 提供稳定顺序

#### Scenario: 新上下文类型通过标准挂点接入
- **WHEN** 后续新增 capability injection、workspace instruction 或 tool exposure 增强
- **THEN** 系统 MUST 通过既有 section 挂点接入，而不是任意修改 prompt 拼接顺序

### Requirement: Prompt 生成必须消费 assembled context
`mycli` 的 prompt 生成路径 MUST 以 assembled context 为输入，而不是继续直接依赖扁平 `ExecutionContext` 中的各个字段自行决定渲染方式。

#### Scenario: React prompt 从 assembled context 渲染
- **WHEN** 当前 runtime 仍采用现有 react-style prompt renderer
- **THEN** renderer MUST 从 assembled context 中读取 section 内容，而不是直接访问 memory、plan、tool list 或 conversation 字段

#### Scenario: Provider 适配层可以复用相同上下文
- **WHEN** 后续需要为不同 provider 或 surface 渲染模型输入
- **THEN** 系统 MUST 能在不重新收集上下文来源的前提下复用同一份 assembled context

### Requirement: Turn context 必须为能力注入和工具暴露预留显式扩展点
`mycli` MUST 在 turn context 中为 capability injection 和 tool exposure 提供正式 section 或等价扩展点，以支持后续 `skills`、MCP 和 dynamic tools 收敛到统一主链。

#### Scenario: Active skill 进入 capability section
- **WHEN** 当前 turn 命中某个 active skill 或其他能力注入来源
- **THEN** 系统 MUST 通过 capability section 记录和渲染这类上下文，而不是把它作为特殊 prompt 分支散落在 runtime 中

#### Scenario: Tool summary 进入 tool exposure section
- **WHEN** 当前 turn 需要向模型暴露可见工具面
- **THEN** 系统 MUST 通过专门的 tool exposure section 提供工具摘要或等价表示，而不是让工具列表以 ad hoc 文本散落在 prompt 中

### Requirement: Turn context 装配必须可调试和可验证
`mycli` MUST 让 turn context 的装配结果具备基本可观测性，使测试、trace 或调试日志能够验证本轮实际注入了哪些 section。

#### Scenario: 测试可断言 section 内容与顺序
- **WHEN** 为 prompt shaping 或 runtime context 编写测试
- **THEN** 测试 MUST 能断言装配出的 section 类型、启用状态、主要内容和顺序

#### Scenario: 调试路径可以查看装配结果
- **WHEN** 需要排查“为什么模型拿到的上下文不对”
- **THEN** 系统 MUST 能通过 trace、调试日志或等价手段查看当前 turn context 的装配结果摘要

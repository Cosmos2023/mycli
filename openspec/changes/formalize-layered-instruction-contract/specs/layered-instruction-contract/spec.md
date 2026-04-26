## ADDED Requirements

### Requirement: Runtime SHALL define a layered instruction contract for model input
`mycli` MUST 在 `TurnContext` 之后定义正式的分层指令契约，用于表达哪些模型输入属于稳定基础规则、哪些属于 turn-scoped runtime guidance、哪些属于上下文化环境片段，而不是继续依赖零散 prompt 拼接与 runtime 特判。

#### Scenario: Instruction contract is assembled after turn context
- **WHEN** runtime 已经收集完 conversation、memory、plan、capability、tool exposure 与 runtime policy 等来源
- **THEN** 系统 MUST 先生成 `TurnContext`
- **THEN** 系统 MUST 再基于该 `TurnContext` 生成正式的 `InstructionContract`

#### Scenario: Renderers consume instruction contract instead of raw context fields
- **WHEN** runtime 需要构建 legacy prompt、Responses-style messages 或其他 provider 输入
- **THEN** 渲染器 MUST 消费 `InstructionContract`
- **THEN** 渲染器 MUST NOT 继续直接从原始 `ExecutionContext` 中自行拼接同类信息

### Requirement: Stable base instructions SHALL be separated from turn-scoped developer instructions
`mycli` MUST 将稳定、低频变化的代理通用规则与当前 turn 的 runtime/developer 约束分层表达，而不是让两者长期混在同一个 system prompt 字符串中。

#### Scenario: Base instructions remain stable across turns
- **WHEN** 当前 session 没有发生全局代理契约变化
- **THEN** `base instructions` MUST 保持稳定
- **THEN** runtime policy、tool exposure 或 capability readiness 的波动 MUST NOT 直接改写 base instructions 本体

#### Scenario: Runtime guidance enters developer instructions
- **WHEN** 当前 turn 存在 runtime decision policy、tool exposure、approval/safety 或 capability policy 提醒
- **THEN** 系统 MUST 将这些内容放入 `developer instructions`
- **THEN** 这些内容 MUST 保留 turn-scoped 语义与来源信息

### Requirement: Environment and capability context SHALL be represented as contextual user fragments
`mycli` MUST 将 workspace/project instructions、environment context、capability bodies 与等价的动态环境片段作为 contextual user fragments 表达，而不是继续把它们视为 system rules 或 runtime developer policy。

#### Scenario: Workspace instructions become contextual fragments
- **WHEN** 当前工作区存在需要注入模型的项目或目录说明
- **THEN** 系统 MUST 将这些说明表示为 `contextual user fragment`
- **THEN** 该 fragment MUST 记录其来源至少为 workspace / project 之一

#### Scenario: Capability bodies become contextual fragments
- **WHEN** 当前 turn 激活了某个 capability 且需要向模型提供其具体使用说明
- **THEN** 系统 MUST 将 capability body 作为 `contextual user fragment` 注入
- **THEN** 系统 MUST NOT 再以 ad hoc system message 特判的方式把它作为主路径注入

### Requirement: Prompt scaffolding SHALL have explicit memory and trace semantics
`mycli` MUST 区分“真实对话内容”和“仅用于本轮模型输入的脚手架型片段”，避免 workspace instructions、capability bodies 或其他 contextual scaffolding 被长期记忆错误吸收。

#### Scenario: Scaffolding fragment can be excluded from memory
- **WHEN** memory 或 summary 系统处理本轮模型输入相关内容
- **THEN** 系统 MUST 能识别哪些 fragments 属于 prompt scaffolding
- **THEN** 系统 MUST 按规则将这些 fragments 排除或降权，而不是无差别当作普通对话内容

#### Scenario: Trace shows injected instruction layers
- **WHEN** 需要调试“模型这一轮到底看到了什么结构化指令”
- **THEN** trace、debug summary 或等价路径 MUST 能展示本轮的 `base`、`developer` 与 `contextual user` 注入摘要
- **THEN** 展示结果 MUST 包含关键 fragment 的类型或来源

### Requirement: Layered instruction contract SHALL remain general-purpose
这套分层指令契约 MUST 服务于通用 agent runtime，而不是绑定在仓库总结、代码修改、debugging 或其他单一任务类型上。

#### Scenario: No task-specific prompt layer is required
- **WHEN** 用户请求的是代码分析、代码修改、验证实现、日常助手任务或其他通用任务
- **THEN** runtime MUST 复用同一套 layered instruction contract
- **THEN** 系统 MUST NOT 依赖任务专用 prompt 主链才能表达基础层级语义

#### Scenario: Runtime policy refines behavior without task hardcoding
- **WHEN** 不同任务在探索深度、证据要求或工具偏好上存在差异
- **THEN** 系统 MAY 通过 developer instructions 中的 runtime policy 状态表达这些差异
- **THEN** 系统 MUST NOT 为此引入按任务关键词硬编码的独立指令层

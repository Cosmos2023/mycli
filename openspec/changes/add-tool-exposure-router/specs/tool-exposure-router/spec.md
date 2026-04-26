## ADDED Requirements

### Requirement: Runtime SHALL plan turn-scoped tool exposure
`mycli` MUST 在每轮 turn 中生成正式的 `ToolExposure` 结果，而不是继续默认将整个静态工具 registry 直接暴露给模型。

#### Scenario: Exposure is planned before model tool rendering
- **WHEN** runtime 开始处理一轮新的用户请求
- **THEN** runtime MUST 在模型调用前生成本轮 `ToolExposure`
- **THEN** 该 exposure MUST 至少区分 direct、deferred 与 dynamic 三类工具暴露

#### Scenario: Exposure reflects the current task context
- **WHEN** 当前任务只需要部分基础工具即可完成
- **THEN** runtime MUST 能仅将相关工具规划为 direct tools
- **THEN** 其余已注册工具 MUST NOT 被默认全部直接暴露给模型

### Requirement: Tool exposure SHALL distinguish direct, deferred, and dynamic tools
`mycli` MUST 为本轮工具面提供正式分类语义，以支持数量控制、按需暴露和 task-scoped dynamic tools。

#### Scenario: Direct tools are immediately callable
- **WHEN** 某个工具被规划为 direct tool
- **THEN** runtime MUST 将该工具渲染为模型可调用的 tool definition
- **THEN** 模型在本轮中 MUST 可以直接调用该工具

#### Scenario: Deferred tools remain visible but not directly callable
- **WHEN** 某个工具被规划为 deferred tool
- **THEN** runtime MUST 在 turn context 或 trace 中保留该工具被识别但未直接开放的事实
- **THEN** 该工具 MUST NOT 直接出现在本轮模型可调用的 tool definitions 中

#### Scenario: Dynamic tools are turn-scoped callable tools
- **WHEN** runtime 为当前 turn 生成了 dynamic tool
- **THEN** 该工具 MUST 作为本轮 callable tool 暴露给模型
- **THEN** 其生命周期 MUST 受当前 turn 或当前任务范围约束

### Requirement: Dynamic tools SHALL support runtime and capability sources
`mycli` MUST 支持至少两类 dynamic tool 来源：runtime 生成的 task-scoped tools，以及 capability activation 贡献的额外工具。

#### Scenario: Runtime contributes a task-scoped dynamic tool
- **WHEN** runtime 根据当前任务判断需要生成临时工具
- **THEN** planner MUST 能将该工具纳入本轮 `ToolExposure.dynamic`
- **THEN** router MUST 能执行该工具而无需绕过统一主链

#### Scenario: Capability activation contributes a dynamic tool
- **WHEN** 某个已激活 capability 声明本轮额外提供工具
- **THEN** planner MUST 能将该工具纳入本轮 `ToolExposure.dynamic`
- **THEN** runtime MUST 将其视为正式的 callable tool，而不是 prompt 旁路能力

### Requirement: Callable tools SHALL be executed through a unified tool router
`mycli` MUST 通过统一 `ToolRouter` 执行本轮 callable tools，而不是根据工具来源拆分多条执行路径。

#### Scenario: Static direct tool is routed through the same execution path
- **WHEN** 模型调用一个 direct tool
- **THEN** runtime MUST 通过统一 router 执行该工具
- **THEN** router MUST 负责调用前校验与执行器分发

#### Scenario: Dynamic tool uses the same router as static tools
- **WHEN** 模型调用一个 dynamic tool
- **THEN** runtime MUST 通过与 direct tool 相同的 router 主链执行该工具
- **THEN** runtime MUST NOT 为 dynamic tools 额外创建独立旁路执行流程

### Requirement: Tool router SHALL reserve namespaced routing for future provider tools
`mycli` MUST 为 future hosted/provider-specific tools 预留统一 namespaced routing 边界，使后续 `MCP` 或其他 provider tools 不需要绕过既有主链。

#### Scenario: Provider-specific route keys can be represented
- **WHEN** 某个工具来源属于未来 provider-specific namespace
- **THEN** exposure / router 模型 MUST 能表示其 namespaced route identity
- **THEN** runtime MUST 不要求这类工具伪装成静态本地 registry tool 才能进入主链

### Requirement: Tool exposure SHALL be visible in turn context and turn history
`mycli` MUST 将本轮 tool exposure 决策作为正式运行时对象暴露给 turn context、trace 与 session history，而不是只保留一份临时工具名列表。

#### Scenario: Turn context renders structured exposure information
- **WHEN** turn context 被组装
- **THEN** tool exposure section MUST 根据本轮 `ToolExposure` 渲染
- **THEN** 渲染结果 MUST 至少体现 direct、deferred 与 dynamic 的分类信息

#### Scenario: Turn history records exposure decisions
- **WHEN** runtime 完成本轮 tool exposure planning
- **THEN** turn history MUST 记录结构化的 exposure 决策项
- **THEN** 该记录 MUST 让 trace 或 surface 能知道本轮实际暴露了哪些工具以及哪些被延迟

### Requirement: Model tool definitions SHALL be rendered from planned exposure only
模型侧实际可调用的 tool definitions MUST 从本轮 exposure 渲染，而不是继续直接读取 registry 全量工具定义。

#### Scenario: Registry contains extra tools not exposed this turn
- **WHEN** 静态 registry 中存在未被本轮 exposure 选中的工具
- **THEN** 这些工具 MUST NOT 自动出现在模型调用参数中的 tool definitions 里
- **THEN** runtime MUST 只下发本轮 exposure 允许调用的 direct 与 dynamic tools

## ADDED Requirements

### Requirement: Runtime SHALL resolve capabilities as turn-scoped activations
`mycli` MUST 将 capability 解析为“本轮实际生效的 activation”，而不是只依赖静态 skill 定义或单个 `active_skill` 字段。

#### Scenario: Trigger hints activate a capability
- **WHEN** 用户请求命中某个 capability 的 `trigger_hints`
- **THEN** runtime MUST 生成该 capability 的 turn-scoped activation
- **THEN** activation MUST 记录激活来源为 `trigger_hint`

#### Scenario: Explicit mention activates a capability
- **WHEN** 用户输入中显式提到某个 capability
- **THEN** runtime MUST 生成该 capability 的 turn-scoped activation
- **THEN** activation MUST 记录激活来源为 `explicit_mention`

### Requirement: Capability activations SHALL be recorded in turn history
每个 turn 中实际激活或尝试激活的 capability MUST 进入结构化 turn history，而不是只作为 prompt 文本存在。

#### Scenario: Successful capability activation becomes a turn item
- **WHEN** runtime 成功激活某个 capability
- **THEN** turn history MUST 记录独立的 `TurnItemType.CAPABILITY`
- **THEN** 该 item MUST 至少包含 capability name、activation source 与 dependency status

#### Scenario: Missing dependencies still produce a capability item
- **WHEN** capability 被识别但缺少前置依赖
- **THEN** runtime MUST 仍然记录独立的 capability turn item
- **THEN** 该 item MUST 标明 capability 未就绪及缺失依赖类别

### Requirement: Capability injection SHALL support dependency checks
`mycli` MUST 在 capability activation 时执行正式依赖检查，而不是假设所有 capability 都天然可用。

#### Scenario: Environment dependency is required
- **WHEN** 某个 capability 声明需要特定环境变量
- **THEN** runtime MUST 检查该环境变量是否存在
- **THEN** 若缺失，activation MUST 标记为未就绪并记录缺失原因

#### Scenario: Workspace resource dependency is required
- **WHEN** 某个 capability 声明需要工作区中的文件或路径资源
- **THEN** runtime MUST 检查对应资源是否存在
- **THEN** 若缺失，activation MUST 标记为未就绪并记录缺失原因

### Requirement: Turn context SHALL render capability sections from activations
turn context 中的 capability section MUST 从本轮 capability activation 集合渲染，而不是继续只依赖单个 `active_skill` 特判。

#### Scenario: Multiple activations render into the capability section
- **WHEN** 同一轮 turn 有多个 capability activation
- **THEN** turn context MUST 能基于 activation 集合渲染 capability section
- **THEN** 渲染结果 MUST 保留 capability name、instructions 和 activation metadata

#### Scenario: Disabled activation is not silently dropped
- **WHEN** 某个 capability 因依赖缺失而未就绪
- **THEN** turn context MUST NOT 将其静默忽略
- **THEN** runtime MUST 让模型和 trace 至少能看见该 capability 被识别但未就绪的事实

### Requirement: Explicit mentions SHALL take precedence over implicit activation
当显式 capability mention 与 trigger hint 自动激活同时出现时，runtime MUST 采用显式激活作为更高优先级来源。

#### Scenario: Explicit mention overrides implicit source
- **WHEN** 同一个 capability 同时被显式 mention 和 trigger hint 命中
- **THEN** runtime MUST 只保留一个 activation
- **THEN** 该 activation MUST 记录来源为 `explicit_mention`

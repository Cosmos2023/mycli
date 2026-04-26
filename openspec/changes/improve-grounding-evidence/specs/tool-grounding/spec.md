## ADDED Requirements

### Requirement: 工具必须暴露结构化 grounding evidence
系统必须为工具结果提供一套共享的结构化 evidence 契约，使 grounded 上下文能够同时穿过 schema-first 的工具执行路径和旧版工具结果消费路径。

#### Scenario: evidence 从 `ToolResultV2` 转换到旧版 `ToolResult` 时仍然保留
- **WHEN** 一个工具在 `ToolResultV2` 中产出一个或多个 evidence 项
- **THEN** 将该结果转换为旧版 `ToolResult` 时，必须保留相同的 evidence 项，且不能丢失路径、行区间或 snippet 字段

#### Scenario: 没有 evidence 的工具结果仍然有效
- **WHEN** 一个工具只返回 summary 文本和 raw payload，而不包含 evidence
- **THEN** runtime 仍然必须接受该结果，且不能要求工具立即采用新的 evidence 契约

### Requirement: 搜索与文件读取工具必须产出可用于工作流的 evidence
系统必须让 `search_text`、`read_file` 和 `read_file_range` 产出支持 `search -> read -> answer` 工作流的结构化 evidence。

#### Scenario: `search_text` 返回 grounded 的匹配 evidence
- **WHEN** `search_text` 在工作区文件中找到匹配行
- **THEN** 结果必须包含 `search_match` evidence 条目，并带有相对路径、匹配行号和匹配行 snippet

#### Scenario: `read_file` 返回文件 excerpt evidence
- **WHEN** `read_file` 成功读取一个 UTF-8 文件
- **THEN** 结果必须包含一个 `file_excerpt` evidence 条目，其中带有相对路径和返回的文件内容 snippet

#### Scenario: `read_file_range` 返回带行区间的 excerpt evidence
- **WHEN** `read_file_range` 成功读取一个闭区间行范围
- **THEN** 结果必须包含一个 `file_excerpt` evidence 条目，其中带有相对路径、实际返回的行区间以及返回的文本 snippet

### Requirement: 工具 transcript 渲染必须优先使用结构化 evidence
系统必须将带有 evidence 的工具结果渲染成 agent 可见的 transcript 文本，并优先使用稳定的路径、行区间和 snippet 格式，而不是优先回退到 payload-specific preview 逻辑。

#### Scenario: 存在 evidence 时使用 evidence-first 渲染
- **WHEN** 一个工具结果包含一个或多个 evidence 项
- **THEN** 渲染后的工具消息必须包含一个 `Evidence:` 区块，并用 evidence 的 kind、location 和 snippet 来格式化每一项

#### Scenario: 未改造工具仍可使用现有 payload 渲染
- **WHEN** 一个工具结果不包含 evidence
- **THEN** 渲染后的工具消息必须继续沿用现有 payload preview 行为，以确保旧工具仍然可用

### Requirement: grounded evidence 必须在后续推理中持续可用
系统必须在 transcript 中保留富含 evidence 的工具消息，使后续模型轮次能够继续基于同一份 grounded 搜索和文件读取上下文推理。

#### Scenario: 搜索 evidence 会在后续轮次中被保留
- **WHEN** agent 先执行一次搜索，再在同一轮里继续发起另一个工具调用或直接回答
- **THEN** 后续模型输入中仍然必须包含此前工具消息里的 grounded 搜索 evidence 文本

#### Scenario: 行区间读取 evidence 会在后续轮次中被保留
- **WHEN** agent 在搜索之后继续读取一个行范围，并继续推理
- **THEN** 后续模型输入中仍然必须包含此前范围读取工具消息里的 grounded 文件 excerpt evidence 文本

### Requirement: prompt 必须强化基于 evidence 的推理
system prompt 必须在工具结果中包含路径、行号和 snippet evidence 时，明确指示模型应直接基于这些信息推理。

#### Scenario: system prompt 提到 grounded evidence 的使用方式
- **WHEN** runtime 构建 system prompt
- **THEN** prompt 必须明确告诉模型，应将路径、行号和 evidence snippet 作为 grounded 后续推理的依据

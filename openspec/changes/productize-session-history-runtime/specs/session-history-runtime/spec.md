## ADDED Requirements

### Requirement: 系统必须以结构化 session、thread、turn 与 history item 维护会话真值
`mycli` MUST 将每个会话表示为正式的 session、thread、turn 与 history item 对象，而不能仅依赖 conversation 文本或零散辅助状态作为运行时真值。

#### Scenario: 新 turn 进入结构化生命周期
- **WHEN** 用户在一个已有 session 中发起新的请求
- **THEN** 系统 MUST 创建新的 turn 记录，并将本轮新增的用户输入、assistant 输出和运行时项关联到该 turn

#### Scenario: 历史真值可跨 turn 读取
- **WHEN** runtime 为下一轮模型调用构建输入
- **THEN** 系统 MUST 从结构化 history item 中读取可见历史，而不是只拼接 legacy conversation 文本

### Requirement: tool activity 必须进入原生 history 主链
`mycli` MUST 将 tool call、tool result 和关键文件变更痕迹记录为正式 history item，使其能够参与后续推理、trace 和恢复。

#### Scenario: 工具调用和输出被记录为 history item
- **WHEN** assistant 发起一次 tool call 且工具返回结果
- **THEN** 系统 MUST 至少记录一个 tool call history item 和一个 tool result history item，并保留 call id、turn id 与来源 metadata

#### Scenario: 文件写入保留模型可见痕迹
- **WHEN** 工具执行导致工作区文件被创建、修改或删除
- **THEN** 系统 MUST 记录与该操作对应的模型可见 history 痕迹，而不能只把变化留在磁盘或低层日志中

### Requirement: 历史项必须具备稳定标识与来源信息
每个进入会话真值的 history item MUST 具备稳定标识、所属 turn、item 类型和来源信息，以便 trace、prompt 组装和恢复流程共享同一语义。

#### Scenario: 历史项拥有可引用标识
- **WHEN** runtime、trace 或 reconstruction 读取某个 history item
- **THEN** 该 item MUST 具备稳定 id 和所属 turn/thread 标识，供其他组件引用

#### Scenario: 提示词装配复用相同历史语义
- **WHEN** turn context 或 instruction contract 需要注入历史内容
- **THEN** 系统 MUST 复用同一份 history item 语义，而不是重新发明另一套 conversation 中间表示

## ADDED Requirements

### Requirement: Runtime SHALL model Responses protocol as typed domain objects
`mycli` MUST 将 Responses 请求项、响应项、流式事件和 tool output payload 建模为正式类型，而不是继续主要依赖裸字典和事件字符串分支。

#### Scenario: Adapter consumes typed stream events
- **WHEN** provider 返回 Responses SSE 事件
- **THEN** 系统 MUST 先将原始 payload 解析为 typed stream event
- **THEN** runtime adapter MUST 基于 typed event 再做后续映射

#### Scenario: Tool output uses formal payload model
- **WHEN** 本地工具执行完成并需要写回 `function_call_output`
- **THEN** 系统 MUST 通过正式的 output payload 抽象表示结果
- **THEN** 该抽象 MUST 支持至少文本 body 和成功/失败语义

### Requirement: Runtime SHALL maintain Responses continuation state
`mycli` MUST 将 `response continuity` 视为正式运行时能力，并维护可用于后续 Responses 请求的 continuation state。

#### Scenario: Completed response stores continuation snapshot
- **WHEN** 一轮 Responses 请求以可续接的 completed 状态结束
- **THEN** 系统 MUST 保存上一轮的 `response_id`
- **THEN** 系统 MUST 保存用于判断后续是否可增量续接的请求/输出快照

#### Scenario: Failed response invalidates continuation
- **WHEN** 一轮 Responses 请求出现 `response.failed`、stream disconnect 或其他不可续接终止态
- **THEN** 系统 MUST 将当前 continuation state 标记为不可续接
- **THEN** 下一次请求 MUST NOT 直接沿用该失败 response 的 `previous_response_id`

### Requirement: Responses client SHALL use previous_response_id only when safe
`mycli` MUST 仅在明确满足续接条件时使用 `previous_response_id`，否则必须回退到完整 create。

#### Scenario: Safe continuation uses previous_response_id
- **WHEN** provider capability 支持 continuation
- **AND** 当前请求与上一轮请求在非 input 字段上等价
- **AND** 当前 input 是上一轮 baseline 的严格扩展
- **AND** 上一轮存在有效 `response_id`
- **THEN** 系统 MUST 使用 `previous_response_id` 发起续接请求

#### Scenario: Non-equivalent request falls back to full create
- **WHEN** 当前请求与上一轮请求在关键字段上不等价，或 input 不是严格扩展
- **THEN** 系统 MUST 回退到完整 create
- **THEN** 系统 MUST NOT 为了节省 token 而强行续接

### Requirement: Provider capability profile SHALL shape Responses requests
`mycli` MUST 通过显式 capability profile 决定 Responses 请求的构造方式，而不是依赖散落的 provider 特判。

#### Scenario: Request builder omits unsupported fields
- **WHEN** 当前 provider/model 不支持某个 Responses 能力
- **THEN** 请求构造器 MUST 不发送对应字段
- **THEN** 系统 MUST 使用 capability profile 解释该决策

#### Scenario: Provider-specific compatibility is expressed declaratively
- **WHEN** 某 provider 需要 assistant content、tool output 或其他字段形式的兼容处理
- **THEN** 该差异 MUST 能通过 capability profile 或等价配置表达
- **THEN** 系统 MUST NOT 仅依赖散落的 ad hoc if/else 来表达该兼容性

### Requirement: Responses stream termination SHALL be explicit and observable
`mycli` MUST 将 Responses 的 completed、failed、断流和 fallback 视为正式终止状态，而不是把失败事件当成未知事件忽略。

#### Scenario: response.failed becomes provider error
- **WHEN** stream 中出现 `response.failed`
- **THEN** 系统 MUST 将其视为协议终止错误
- **THEN** 错误信息 MUST 被上抛并进入可观测日志或等价路径

#### Scenario: Stream disconnect is distinguishable from provider failure
- **WHEN** SSE 流在 `response.completed` 之前断开
- **THEN** 系统 MUST 能区分“provider 明确 failed”和“stream transport disconnect”
- **THEN** runtime MAY 根据该差异决定重试、fallback 或终止

### Requirement: Responses protocol adaptation SHALL remain general-purpose
这套 Responses 适配层 MUST 服务于通用 agent runtime，而不是围绕仓库分析、代码修改或其他单一任务写死行为。

#### Scenario: Same protocol layer supports multiple task families
- **WHEN** 用户请求是代码编辑、项目分析、验证实现或日常助手任务
- **THEN** runtime MUST 复用同一套 Responses 协议状态机
- **THEN** 系统 MUST NOT 为每类任务建立单独的 Responses 适配分支

#### Scenario: Runtime policy can consume continuation state without task hardcoding
- **WHEN** runtime decision policy 需要参考当前是否可续接、是否应 fallback、是否已明确失败
- **THEN** 它 MAY 读取 Responses continuation / termination 状态
- **THEN** 这些决策 MUST 不依赖任务关键词硬编码

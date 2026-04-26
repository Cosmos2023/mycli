## ADDED Requirements

### Requirement: Runtime SHALL derive a decision profile from request and evidence signals
`mycli` MUST 将探索策略视为通用 agent runtime stabilization 的正式决策层，而不是继续只依赖通用 overview heuristic 或 prompt 中的宽泛提醒。Runtime MUST 根据用户请求、近期证据、失败模式和工具历史推导一个当前 decision profile，而不是要求显式的硬任务分类器主导整个 turn。

#### Scenario: Verification-style request uses a source-first verification profile
- **WHEN** 用户请求检查某个实现是否已经接入某些模块、层次或行为
- **THEN** runtime MUST 推导出偏 source-first verification 的 decision profile
- **THEN** runtime MUST 对该类 turn 使用专门的探索与收口策略

#### Scenario: Debugging-style request uses a failure investigation profile
- **WHEN** 用户请求定位错误原因、解释异常行为或排查失败路径
- **THEN** runtime MUST 推导出偏 failure investigation 的 decision profile
- **THEN** runtime MUST 允许与 repository overview 不同的证据优先级与工具偏好

### Requirement: Exploration SHALL prioritize source and config paths over noise
对于默认的代码证据型请求，`mycli` MUST 优先沿源码 / 配置主路径探索，并降低 `log/`、`model-raw/`、无关 docs 的默认优先级。

这里的代码证据型请求包括但不限于：

- 代码库分析
- 实现验收
- 运行时接入检查
- 失败路径排查

这些场景是当前高信号样本任务，而不是产品目标边界本身。

#### Scenario: Change name does not become the primary source path
- **WHEN** 用户请求中包含 change 名、proposal 名或其他非源码主标识
- **THEN** runtime MUST NOT 仅因为该字符串匹配而优先沿日志或原始 request/response 文件继续探索
- **THEN** runtime MUST 引导搜索转向源码模块名、运行时对象名或已知接入点文件

#### Scenario: Source evidence outranks model-raw hits
- **WHEN** 搜索结果同时包含源码命中与 `log/model-raw` 命中
- **THEN** runtime MUST 默认优先消费源码命中
- **THEN** `model-raw` 结果 MUST 仅作为辅助诊断上下文，除非当前任务显式属于日志/协议排查

### Requirement: Truncated file reads SHALL trigger range-read routing
当 `read_file` 结果已提示截断或建议范围读取时，`mycli` MUST 将其视为正式换路信号，而不是仅作为普通文本提示。

#### Scenario: Re-reading a truncated file switches to range reads
- **WHEN** 最近一次 `read_file` 结果表明文件已截断，且 agent 准备继续读取同一路径
- **THEN** runtime MUST 优先提醒或引导 agent 使用 `read_file_range`
- **THEN** runtime MUST 降低继续对同一路径执行完整 `read_file` 的优先级

### Requirement: Evidence sufficiency SHALL be profile-specific
`mycli` MUST 为不同 decision profile 定义不同的 enough-evidence 判定，以稳定 agent 的任务推进与回答时机，而不是继续共享单一的 sufficiency heuristic。

#### Scenario: Source-first verification requires multi-layer evidence
- **WHEN** 用户请求验证某项实现是否已经接入多个层次，例如 turn context、runtime 与 trace
- **THEN** runtime MUST 要求来自这些层次中相关代码路径的实际证据
- **THEN** 仅凭 change 名、日志命中或单一模块片段 MUST NOT 被视为 sufficient evidence

#### Scenario: Sufficient evidence allows concise answer
- **WHEN** runtime 已判定当前 decision profile 所需的核心证据已经满足
- **THEN** runtime MUST 允许 agent 收口回答
- **THEN** runtime MUST 避免继续进行低价值工具探索

### Requirement: Repeated exploration SHALL prefer reroute or answer before hard stop
对于重复探索，`mycli` MUST 在触发 hard stop 前优先引导 agent 换路或回答，而不是直接把 stop policy 作为唯一兜底。

#### Scenario: First repeated read triggers reroute reminder
- **WHEN** agent 开始重复读取同一文件或重复执行相同探索路径
- **THEN** runtime MUST 优先发出换路提醒
- **THEN** 该提醒 MUST 指向更精确的 sibling path，例如 `read_file_range`、不同源码路径或基于已知事实的回答

#### Scenario: Hard stop only happens after repeated low-value exploration
- **WHEN** agent 在没有获得足够新证据的情况下持续重复相同探索
- **THEN** runtime MAY 触发 `loop_detected`
- **THEN** 在 hard stop 之前 runtime MUST 已经尝试过提醒换路或建议收口

### Requirement: Exploration policy state SHALL be visible in context and trace
`mycli` MUST 让 exploration policy 的关键状态成为 turn context、activity 或 trace 的正式可见对象，以支撑通用 agent runtime stabilization 的可解释性。

#### Scenario: Strategy state is visible during implementation audit
- **WHEN** 当前 turn 进入 source-first verification 或 source-first overview 等 profile
- **THEN** runtime reminders 或 activity/trace MUST 能表达当前 decision profile 与关键策略约束
- **THEN** 这些信息 MUST 让 surface 或调试者理解 agent 为什么优先走某条探索路径

#### Scenario: Sufficiency transition is visible when agent should answer
- **WHEN** runtime 判定 evidence 已足够
- **THEN** activity 或 trace MUST 记录进入“可以回答/应收口”的状态
- **THEN** 该状态 MUST 能被后续 surface 渲染消费

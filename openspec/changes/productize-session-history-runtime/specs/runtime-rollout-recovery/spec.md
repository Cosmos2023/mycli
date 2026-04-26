## ADDED Requirements

### Requirement: 系统必须为每个 turn 持久化正式 rollout
`mycli` MUST 为每个 turn 持久化足够的 rollout 信息，以表达执行过程、关键状态转换和恢复所需快照，而不是只保存最终对话结果。

#### Scenario: turn 执行过程被写入 rollout
- **WHEN** runtime 在一轮 turn 中完成模型调用、工具调用或状态更新
- **THEN** 系统 MUST 将这些关键步骤追加到该 turn 的 rollout 记录中

#### Scenario: turn 完成状态进入 rollout
- **WHEN** turn 以 completed、failed、interrupted 或 waiting_approval 等状态结束
- **THEN** 系统 MUST 在 rollout 中记录最终状态、stop reason 和完成时间

### Requirement: 系统必须能够从持久化数据重建活跃线程状态
`mycli` MUST 能从持久化 history、baseline 和 rollout 中重建 session 的活跃线程状态，以支持 resume、replay 或中断恢复。

#### Scenario: 进程重启后恢复 session
- **WHEN** 运行中的 session 因进程退出或异常中断而被重新打开
- **THEN** 系统 MUST 能根据持久化数据恢复该 session 的最新线程状态，而不要求用户重新提供整个上下文

#### Scenario: 重建结果与最后持久化状态一致
- **WHEN** reconstruction 完成
- **THEN** 系统 MUST 还原最近已持久化的 turn 状态、历史可见窗口和 baseline 状态

### Requirement: 持久化恢复边界必须区分 durable state 与临时 transport state
恢复设计 MUST 区分需要长期保存的 durable runtime state 和可以丢弃或重新协商的临时 provider / transport 状态。

#### Scenario: durable runtime state 被保留
- **WHEN** session 持久化到磁盘
- **THEN** 系统 MUST 保留 history、baseline、rollout 和恢复所需的 continuation 快照

#### Scenario: 临时 transport 状态不阻塞恢复
- **WHEN** 上一轮 provider connection、stream transport 或等价临时状态已经失效
- **THEN** 系统 MUST 仍能基于 durable state 恢复 session，而不是因为缺少临时连接状态而判定不可恢复

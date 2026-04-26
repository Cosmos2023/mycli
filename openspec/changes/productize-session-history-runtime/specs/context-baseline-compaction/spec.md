## ADDED Requirements

### Requirement: 系统必须维护独立于多 turn history 的 context baseline
`mycli` MUST 维护一条独立的 context baseline 主链，用于表达稳定但可更新的会话级上下文，而不是在每轮模型调用时全量重灌相同脚手架内容。

#### Scenario: baseline 在多轮之间被复用
- **WHEN** 同一 session 连续执行多轮 turn
- **THEN** 系统 MUST 能在不重复构造整包脚手架文本的前提下复用上一轮有效的 context baseline

#### Scenario: baseline 更新以结构化变更记录
- **WHEN** 工作区说明、developer 约束或其他会话级上下文发生变化
- **THEN** 系统 MUST 以结构化 baseline update 记录该变化，而不是仅覆盖一段最终文本

### Requirement: compaction 必须作为历史替换事务执行
`mycli` MUST 将 compaction 设计为对历史窗口执行可追踪的替换，而不是简单附加一段 summary 文本。

#### Scenario: compaction 替换历史窗口
- **WHEN** runtime 对某个历史窗口执行 compaction
- **THEN** 系统 MUST 记录被替换窗口的边界、替换后的 compacted item 以及与之关联的 metadata

#### Scenario: 后续 turn 消费 compacted history
- **WHEN** compaction 已成功完成
- **THEN** 后续 turn MUST 基于 compacted history 与当前 baseline 构建输入，而不是继续读取已被替换的原始窗口作为默认主路径

### Requirement: compaction 与 baseline 变更必须可重建和可审计
compaction 与 baseline update MUST 保留足够的来源与关联信息，以支持恢复、调试和行为审计。

#### Scenario: 调试路径可以解释当前上下文来源
- **WHEN** 需要分析某轮模型输入为什么包含某段 compacted 或 baseline 内容
- **THEN** 系统 MUST 能追溯它来自哪个 compaction item 或 baseline update item

#### Scenario: 恢复流程识别 compacted 状态
- **WHEN** session 在 compaction 之后中断并尝试恢复
- **THEN** reconstruction 流程 MUST 能识别当前线程已处于 compacted 状态，并基于替换后的历史与 baseline 重建运行态

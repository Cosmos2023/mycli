## Context

`mycli` 最近几轮改造已经补上了不少关键能力：

- `Responses` 协议状态机与 continuation
- `turn context assembly`
- `layered instruction contract`
- dynamic tool contract / tool exposure
- runtime decision policy

这些能力让 `mycli` 从“只能出字”的 CLI 更像一个可工作的 agent，但和 `/tmp/openai-codex` 相比，最关键的差异已经不再是“少某个功能”，而是运行时真值仍然不够原生。当前 `mycli` 仍主要围绕 conversation 文本、prompt 装配结果和 session 辅助字段工作，而 Codex 的主链更接近：

- 结构化 `session / thread / turn / history item`
- 模型可见历史与稳定 context baseline 分层
- tool call / tool output 原生进入历史
- compaction 作为历史替换
- rollout + reconstruction 支撑 resume / replay

这份设计不试图照搬 Codex 的 Rust 实现，也不把 engineering 提案扩成“所有平台能力一次重写”。它聚焦一个更有杠杆的目标：先把 `mycli` 的 session/history/runtime 主链产品化，让已有 responses、prompt、tooling 和 future multi-agent 演进都建立在可持续会话的基础上。

## Goals / Non-Goals

**Goals:**

- 建立 `session / thread / turn / history item` 的正式对象模型和持久化边界
- 让模型后续推理依赖结构化 history item，而不是只依赖 conversation 文本
- 让 tool call、tool result、关键文件变更痕迹进入统一 history 主链
- 引入显式 `context baseline` 与 diff 更新机制
- 把 compaction 设计成可重建的历史替换事务
- 为 rollout、reconstruction、resume/replay 建立正式存储与恢复边界
- 保持整套设计服务于通用 agent，而不是某类任务的专用 shortcut

**Non-Goals:**

- 不在本变更中一比一复刻 Codex 的 websocket sticky routing 或 guardian 实现
- 不在本变更中一次性完成多 agent 线程树、memory pipeline、network approval orchestrator 的全部落地
- 不要求第一版就支持所有 provider item 类型或完整 undo/rollback UI
- 不以“减少 prompt 长度”作为主要目标；第一目标是 runtime 真值和恢复能力

## Decisions

### 1. 用结构化 `HistoryItem` 主链替代“conversation 文本 + 辅助状态”的真值模型

本变更决定新增正式的会话对象关系：

- `AgentSession`
- `AgentThread`
- `AgentTurn`
- `HistoryItem`

其中 `HistoryItem` 表达模型后续推理真正依赖的统一历史项，第一版至少覆盖：

- user / assistant message
- reasoning summary
- function call
- function call output
- approval item
- compaction item
- context baseline update item

这样做的原因是：

- 当前 `mycli` 的 continuation、prompt rendering 和 session persistence 分别依赖不同形态的数据，真值分散
- 如果没有统一 item history，后续 compaction、resume、fork、tool-native history 都会继续依赖字符串拼接和特殊状态字段
- Codex 的工程稳定性很大程度上来自“历史真值是结构化 item，而不是 transcript 文本”

考虑过的替代方案：

- 继续沿用当前 conversation 文本，再附加更多 metadata。否决，因为这只会让状态越来越碎，无法支撑历史替换和恢复。

### 2. 将“模型可见历史”和“稳定上下文 baseline”分成两条主链

本变更决定明确区分两类长期输入：

- `history items`：代表多 turn 对话、工具交互和关键运行时结果
- `context baseline`：代表稳定但可更新的 developer/contextual scaffolding 与会话级上下文基线

后续 turn 构建模型输入时，必须显式组合这两部分，而不是每轮重新装配一份整包 prompt 再把它当成全部真值。

这样做的原因是：

- `layered instruction contract` 解决的是“当前这轮如何分层输入”，但还没有解决“哪些输入应该跨 turn 稳定复用”
- 如果没有 baseline，developer/contextual scaffolding 仍会在每轮重灌，难以做 diff 更新和 compaction
- 这也是 Codex `reference_context_item` 最值得借鉴的点之一

考虑过的替代方案：

- 仅保留 assembled context 快照。否决，因为快照不表达“哪些内容是稳定基线，哪些是当轮增量”。

### 3. tool call、tool result、文件变更痕迹必须进入原生 history，而不是只写日志

本变更决定把工具相关真值纳入 `HistoryItem` 主链。第一版至少要求：

- tool call 保留 name、arguments、call id、turn id、provider/runtime provenance
- tool result 保留 success / error、structured payload 摘要和面向模型的可见内容
- 关键文件写入事件保留“模型可见痕迹”，但不把整个磁盘快照塞进 history

这样做的原因是：

- tool 输出如果只存在于日志或某个临时 runtime block，就无法自然参与 continuation、compaction 和 recovery
- 文件系统真值和模型可见痕迹不是同一层，需要分层处理
- 通用 agent 不是“会调用工具”就够了，而是要让工具结果成为之后推理的正式上下文

考虑过的替代方案：

- 继续把 tool result 压成 assistant 文本摘要。否决，因为这会丢失结构、来源和恢复语义。

### 4. compaction 必须建模为“历史替换事务”

本变更决定：compaction 不是在 session 里附加一个 summary 字段，而是用正式的 `compaction item` 替换一个历史窗口，并记录：

- 被替换窗口的范围
- 替换后保留的 compacted history item
- 对 reconstruction 必要的元数据

这样做的原因是：

- 松散 summary 只能减少显示文本，不能真正改变后续 turn 的历史基线
- 如果不记录“替换了什么”，恢复和调试都无法解释当前上下文从何而来
- Codex 的 compaction 之所以可用，是因为它本质上重写的是历史，不是写个旁注

考虑过的替代方案：

- 继续维护 session summary。否决，因为它无法提供可验证的历史替换语义。

### 5. rollout 必须成为恢复主链的一等公民

本变更决定把每个 turn 的执行过程持久化为正式 rollout，至少记录：

- turn metadata 与 stop reason
- 请求输入和响应输出的结构化摘要
- 工具调用与工具结果
- context baseline 更新
- continuation / compaction / recovery 所需的状态快照

session 恢复时，系统必须能从持久化 history + rollout 重建活跃线程状态，而不是只依赖“上一轮 conversation 文本还在”。

这样做的原因是：

- 没有 rollout，session 文件只能表达“结果”，无法表达“执行中断时系统处于哪里”
- resume / replay / reconstruction 本质上都需要事件级轨迹
- 这也是 Codex 区别于普通 CLI agent 的关键工程化能力之一

考虑过的替代方案：

- 仅扩展现有 session transcript。否决，因为 transcript 不能可靠承载恢复与重建。

### 6. 安全编排器作为 follow-up，但当前对象模型必须为其预留挂点

本变更不直接实现完整的 approval / sandbox / network orchestrator，但要求：

- approval 相关决策能进入 `HistoryItem`
- rollout 能记录执行策略与审批结果
- tool provenance 能容纳未来的 sandbox / network policy metadata

这样做的原因是：

- 统一治理是 Codex 工程化的重要部分，但现在最缺的仍是会话主链和恢复基础
- 如果当前对象模型不预留挂点，后续再加安全编排器会再次产生旁路状态

考虑过的替代方案：

- 把安全编排也一起纳入本变更。否决，因为会显著拉大范围，影响落地节奏。

## Risks / Trade-offs

- [风险] session/history schema 升级会增加实现复杂度和兼容成本。  
  缓解：第一版采用兼容迁移，保留 legacy conversation 字段作为派生视图，而不是立即彻底移除。

- [风险] 如果 `HistoryItem` taxonomy 设计过宽，会让第一版难以落地。  
  缓解：先覆盖当前 `mycli` 已真实使用的 item 子集，并为扩展预留枚举空间。

- [风险] compaction 若实现不严谨，可能导致上下文缺失或恢复失败。  
  缓解：第一版只允许在明确边界上执行 compaction，并要求保留替换窗口元数据与重建测试。

- [风险] rollout 记录过多原始数据会带来存储和日志膨胀。  
  缓解：区分 durable history、recovery snapshot 和 raw provider log，各自承担不同职责。

- [风险] 改造过程中 runtime、prompt、session 三条主链可能短期并存双轨。  
  缓解：明确 `HistoryItem` 和 baseline 是主路径，legacy transcript 只作为兼容输出与调试视图。

## Migration Plan

1. 定义新的 session/thread/turn/history item 领域模型和持久化 schema。
2. 为 session service 增加 history item、context baseline、rollout 的读写接口，并保留对旧 session 文件的兼容读取。
3. 改造 runtime 与 responses 适配层，使其在 turn 执行过程中记录结构化 history item 和 rollout 事件。
4. 让 turn context / instruction contract 从结构化 history 与 baseline 生成模型输入，而不是继续直接依赖 legacy conversation。
5. 引入 compaction 事务与 reconstruction 流程，并补齐 resume / replay 测试。
6. 在验证稳定后，将 legacy conversation 降级为派生视图或导出格式。

回滚策略：

- 每一步都保持 session 读取兼容，必要时可以继续从 legacy conversation 路径运行
- compaction 与 reconstruction 在启用前由 feature flag 或等价开关保护
- rollout 写入可先采用追加式旁路存储，稳定后再收敛为默认主链

## Open Questions

- 第一版 `thread` 是否与现有 `session` 一一对应，还是预留多线程结构但先只启用单线程
- `HistoryItem` 是否直接复用现有 runtime block 的部分字段，还是完全独立建模后再做映射
- compaction 的触发条件第一版由 runtime heuristics 决定，还是仅提供显式入口
- rollout 是写入 session 文件内嵌结构，还是独立成 `jsonl`/sidecar 文件更利于重建与调试

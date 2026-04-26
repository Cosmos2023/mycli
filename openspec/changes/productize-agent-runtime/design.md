## Context

`mycli` 最近已经完成了一轮 Responses API 接入、CLI activity stream、workspace logging 与基础 trace 能力建设，但真实运行暴露出更深一层的问题：当前系统虽然能接住部分 Responses 内容，也能驱动工具调用，却还没有形成稳定的 agent runtime 协议和执行纪律。典型表现是模型会因为缺乏 grounded planning 和 sufficiency judgment 而反复读取并不存在的路径，最后以工具错误结束，而不是基于已知证据给出答案。

来自 `openai/codex` 与 `voocel/codebot` 的调研也说明，成熟 agent runtime 的关键不只是“能调工具”，而是：

- 先有稳定 protocol，再有 CLI/TUI/App surface
- provider event 先归一化，再进入 runtime
- runtime orchestration 与 runtime policy 分层
- approval、exec policy、stop reason、compaction 是主链能力

这次变更的目标，是把这些结论落进 `mycli` 的 OpenSpec 契约里，为后续实现建立一个更高层的统一方向，并和已经存在的 `upgrade-responses-agent-runtime` 形成上下游关系。

## Goals / Non-Goals

**Goals:**
- 定义独立于 provider 的内部 runtime protocol，并让 CLI、trace、session 都围绕它收敛
- 明确 runtime orchestration 与 runtime policy 的分层职责
- 为 `grounded planning`、`loop detection`、`exploration budget`、`sufficiency judge`、`stop policy` 建立正式约束
- 将工具失败改造为可恢复的结构化结果，避免因为单次路径猜错导致整轮 turn 崩溃
- 为后续继续完善 Responses completeness、session state、surface 复用建立稳定演进路径

**Non-Goals:**
- 不在本轮直接重写全部 runtime 代码或一次性完成所有 provider 兼容
- 不在本轮设计完整 TUI、IDE 扩展或 App Server
- 不在本轮引入新的第三方依赖或更换日志系统
- 不要求本轮就实现 thread fork / rollback / interrupt 等全部高级能力
- 不扩展到图像、音频、多模态 hosted tools 的完整覆盖

## Decisions

### 1. 先建立内部 protocol，再继续补 provider 兼容

本轮将 `thread`、`turn`、`turn item`、`approval lifecycle`、`stop reason` 提升为正式运行时协议实体。Responses 及其兼容 provider 的 raw item / stream event 必须先映射成内部事件，再进入 runtime、CLI 和 session。

为什么这样做：
- 可以防止 provider 细节继续渗透到 CLI 和 runtime 主链
- 让 trace、session persistence 和 surface 渲染建立在同一套稳定语义上
- 为后续增加其他 provider 或 surface 降低耦合

考虑过的替代方案：
- 继续在 `ResponsesModelAdapter` 上渐进补逻辑：否决，因为这样只能缓解当前问题，无法解决 runtime 状态和协议不清晰的问题。

### 2. 将 orchestration 与 discipline policy 分成两个层次

`Runtime Orchestration` 负责驱动一轮 turn 的生命周期，包括模型调用、工具调用、审批等待、turn 完成；`Runtime Discipline Policy` 负责判断“下一步该不该继续探索”“是否已经有足够证据”“是否命中循环”“应当以什么 stop reason 收束”。

为什么这样做：
- 当前 `AgentRuntime` 既在调度，又在承受越来越多策略判断，已经接近单体膨胀
- `codebot` 的 runtime policy 与 Codex 的 exec policy 都证明，执行纪律必须成为正式模块

考虑过的替代方案：
- 仅通过 prompt 强化自约束：否决，因为 prompt 只能提醒模型，无法形成可观察、可回归验证的停止策略。

### 3. stop reason 成为一等运行时结果

每个 turn 完成、失败、等待审批或因预算/循环停止时，都必须记录正式 `stop_reason`，例如：
- `assistant_completed`
- `sufficient_evidence`
- `loop_detected`
- `max_steps_reached`
- `approval_required`
- `runtime_error`
- `model_error`

为什么这样做：
- 现在 CLI 和 trace 很难解释“为什么这轮结束了”
- stop reason 是调试 agent 行为、建立产品可观测性的基础

考虑过的替代方案：
- 继续使用隐式完成状态：否决，因为它无法表达 agent 的决策质量，也无法支撑后续产品化。

### 4. 文件与目录工具失败必须是可恢复结果

对 `read_file`、`read_file_range`、`list_directory` 等工具，运行失败时不应直接抛异常中止 turn，而应返回结构化失败结果，至少包含：
- `success`
- `summary`
- `error`
- `raw_payload`

为什么这样做：
- 模型读取不存在路径是 agent 探索中的正常失误，不应升级为系统崩溃
- 可恢复工具结果更符合 Responses agent 模式，也更利于 loop detection 和 grounding analysis

考虑过的替代方案：
- 保留异常抛出，仅靠 runtime try/except 包装：否决，因为这会丢失明确的工具语义，也不利于模型继续推理。

### 5. 任务预算和 grounded planning 采用“先简单启发式，再逐步增强”

第一版不引入复杂分类器，而是基于任务意图和最近证据数量做轻量策略，例如：
- overview / summary 任务使用更低探索预算
- debugging / implementation 任务允许更高预算
- 对未被证据证明存在的路径访问记为 ungrounded 尝试

为什么这样做：
- 当前最紧迫的是让 agent 学会收敛，而不是追求完美分类
- 启发式更容易快速落地和验证

考虑过的替代方案：
- 一开始就做复杂任务分类与学习型策略：否决，因为复杂度高，且缺少足够观测数据支撑。

## Risks / Trade-offs

- [内部 protocol 抽象过早，导致实现成本上升] → 先围绕现有 Responses 主链和现有 block/item 模型演进，避免一次性设计过宽。
- [runtime policy 过强导致 agent 过早停止] → 先用 reminder + 柔性 stopping，保留可调预算和调试日志。
- [recoverable tool result 掩盖真正系统错误] → 区分工具语义错误与 runtime/model 错误，只把可预期的工具失败转成结构化结果。
- [新旧 change 边界重叠] → 将 `upgrade-responses-agent-runtime` 视为 provider/runtime completeness 子项，本 change 聚焦更高层契约与分层。
- [CLI 仍然持有部分状态理解] → 在实现阶段优先把事件源收敛到 runtime protocol，分阶段清理 CLI 特有逻辑。

## Migration Plan

1. 先定义 runtime protocol 对象和 stop reason 语义，并让 trace / session / CLI 能消费这些对象。
2. 从 `AgentRuntime` 中拆出 runtime policy，先落 grounded planning、loop detection、exploration budget 和 sufficiency/stop judgment 的最小版本。
3. 改造文件/目录类工具契约，返回结构化失败结果，并补齐日志与测试。
4. 将 Responses provider 事件进一步归一化到新 protocol，减少 provider 细节向上渗透。
5. 逐步把 CLI 从“理解 runtime”收敛为“渲染 runtime 事件”的 thin surface。

回滚策略：
- 各阶段改动都应以可独立回滚的小步提交推进
- 第一版不要求 session schema 破坏性迁移，必要时可以保留兼容字段并逐步切换

## Open Questions

- `thread` 与现有 `session` 是否先做别名兼容，还是直接升级命名与持久化结构
- `turn item` 是否继续复用现有 `RuntimeBlock` 作为过渡表示，还是尽快切换为更严格的新对象
- `stop policy` 的第一版是否仅用于 overview 类任务，还是默认覆盖全部 turn
- recoverable tool result 是否需要统一错误码，以便后续 trace、metrics、CLI 有更稳定的分类

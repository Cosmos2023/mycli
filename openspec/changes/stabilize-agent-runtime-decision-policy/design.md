## Context

`mycli` 已经走完了三条关键主链建设：

- `add-turn-context-assembly` 把 prompt 组装升级成正式 turn context
- `productize-capability-injection` 让能力注入进入 turn history
- `add-tool-exposure-router` 把工具面收敛成 exposure / router 主链

但真实使用与 smoke 说明，仅仅把这些接入点搭出来还不够。当前 agent 仍会在证据型任务中暴露明显的不稳定性：

- 把 change 名、日志名或 raw request/response 名当成源码检索入口
- 在已拿到正确源码路径后，仍然继续做低价值搜索或重复读取同一文件
- `read_file` 提示已截断后，不会稳定切换到 `read_file_range`
- 对 “evidence 已足够” 没有稳定、可操作的判定，导致要么过早收口，要么过晚停机
- `loop_detected` 目前更多是在兜底打断，而不是主动引导 agent 换路或回答

换句话说，现在缺的已经不是“有没有主链”，而是：

`主链里的任务推进与收口决策层是否足够稳定。`

## Goals / Non-Goals

**Goals:**

- 将这条 change 明确定位为 `general-agent runtime stabilization` 的第一阶段，而不是单纯的 repo exploration 优化
- 将 exploration policy 产品化为正式 runtime 决策层的一部分，而不是继续依赖 prompt 中的零散提醒
- 用软性的 decision profile 与 policy signals 表达当前 turn 的推进风格，而不是引入强 task classifier
- 优先源码 / 配置主路径，正式降低 `log/`、`model-raw/`、说明文档等噪音路径的默认权重
- 为 evidence sufficiency 建立更明确的 runtime 判定，并能驱动“回答 now / 继续探索 / 改变路径”
- 在 `read_file` 截断或大文件场景下，引导 agent 切换到 `read_file_range`
- 把 repeated exploration 从单纯 stop condition 升级为“提醒 + 换路 + 收口”的完整策略链

**Non-Goals:**

- 不在本变更中接入新的外部工具来源或 MCP
- 不在本变更中重做 tool exposure / router 协议本身
- 不在本变更中产品化完整多任务 capability 市场
- 不新增复杂 UI surface；仅增强现有 CLI / trace 对探索策略的可见性

## Decisions

### 1. 将 exploration policy 升级为 decision profile，而不是硬 task classification

本变更决定不再只围绕 “repo analysis” 追加规则，但也不把 runtime 做成显式任务分类器，而是把 exploration policy 提升为更广义的 decision profile 层，并把它视为通用 agent runtime stabilization 的一部分。

第一版重点支持三种推进画像：

- source-first overview
- source-first verification
- failure investigation

这些 profile 可以由用户请求、近期证据、失败模式和工具历史共同推导，而不是要求 runtime 先给当前 turn 贴一个强任务标签。

这样做的原因是，Codex 更接近“统一主链 + 软引导 + 工具面约束”的模式，而不是显式 task classifier。`mycli` 如果要向这个方向靠拢，应优先稳定 decision profile，而不是稳定 task taxonomy。

这里还需要额外强调：

- codebase analysis 只是当前最容易暴露问题的样本任务
- 它不应继续主导 `mycli` 的产品叙事
- 本变更产出的 decision profile 需要能自然扩展到 debugging、research、writing 与 assistant automation

未采用的方案：

- 继续在 `repo-analysis-discipline` 上追加 if/else。否决，因为这会让 verification、debugging 之类请求继续夹在错误的 heuristic 里，难以稳定扩展，也会继续强化“mycli 的主目标是仓库分析”这一错误叙事。
- 把 repository analysis / implementation audit / debugging 固化为对外可见的强分类。否决，因为这会把 runtime 过早锁死成“先分类、再执行”的结构，偏离通用 agent 主链。

### 2. 搜索主路径优先级必须进入 runtime，而不是只靠 prompt 提醒

本变更决定对搜索和读取路径增加正式优先级：

- 源码 / 配置主路径优先
- `src/`、`tests/`、关键配置文件优先
- `log/`、`model-raw/`、普通 docs 在默认情况下仅作为辅助证据

对于实现验收型问题，change 名或 proposal 名不应直接作为源码检索主词，而应引导到：

- 运行时对象名
- 相关模块名
- 已知接入点文件

这样做的原因是，这次 smoke 中真正的问题不是“模型不会搜索”，而是“第一跳搜索走进了错误路径后被坏证据回灌”。

未采用的方案：

- 继续完全相信模型自己选择检索词。否决，因为现有实际 evidence 已说明模型会把 change 名和日志名误当源码主入口。

### 3. `read_file` 截断不是小提示，而应成为正式换路信号

本变更决定把 `context_manager` 中的截断提示提升为 runtime policy 可消费信号。

具体来说：

- 若最近一次 `read_file` 输出带有 “excerpt truncated” 或 “use read_file_range” 信号
- 且模型仍准备继续读取同一文件
- runtime 应优先提醒或约束 agent 切换到 `read_file_range`

这样做的原因是，当前 agent 已经能收到截断提示，但仍可能重复 `read_file` 同一文件三次，说明仅靠提示文本不够。

未采用的方案：

- 只保留提示，不做策略联动。否决，因为这正是当前失败案例中的直接问题之一。

### 4. Evidence sufficiency 必须按 decision profile 建模

本变更决定不再沿用“概览类请求共用一个 sufficiency heuristic”的做法，而改为：

- source-first overview 有自己的 sufficiency 判定
- source-first verification 有自己的 sufficiency 判定
- failure investigation 有自己的 sufficiency 判定

例如，对 source-first verification：

- 仅命中 change 名或日志命中，不算 sufficient
- 至少需要接入点模块 + 实际调用方 / 消费方中的一组证据
- 若结论涉及 turn context / runtime / trace 三层，至少应覆盖每一层中的实际代码证据

这样做的原因是，“enough evidence” 本质上是决策画像语义，不是通用常量；它直接决定 agent 何时继续探索、何时给出回答、何时承认仍有缺口。

未采用的方案：

- 用统一工具次数或统一文件数阈值表达 enough evidence。否决，因为这会让不同任务继续共享错误门槛。

### 5. Repeated exploration 应先换路和收口，再 loop stop

本变更决定保留现有 `loop_detected` 兜底，但在 stop 之前增加更明确的中间层：

- 第一次重复：提醒换路
- 第二次重复：强提醒总结已知事实或切换到更精确读取
- 只有在仍然重复且没有新证据时，才触发 loop stop

同时，repeated exploration 不只看工具签名重复，也应参考：

- 最近是否已有新的成功证据
- 当前是否已满足某个任务的 sufficiency 条件
- 是否存在更精确的 sibling tool（例如 `read_file_range`）

这样做的原因是，当前 stop 机制能止损，但不能帮助 agent 更高概率地“优雅收口”。

### 6. 策略状态应进入 turn context / activity / trace

本变更决定 runtime stabilization 相关的策略状态不只是内部判断，还应体现在：

- runtime reminders
- structured activity
- trace 事件

例如：

- 当前 decision profile：source-first verification
- 当前主路径：source-first
- 当前状态：enough evidence reached
- 当前约束：prefer read_file_range over repeated read_file

这样做的原因是，只有策略状态可见，后续 CLI、多 surface 和调试工作才能真正理解 agent 当时为什么继续探索、为什么开始收口、以及为什么没有继续调用工具。

## Risks / Trade-offs

- [风险] decision profile 变多后，runtime policy 会更复杂。  
  缓解：第一版只覆盖 3 种高频推进画像，不试图一次产品化所有任务类型。

- [风险] 对 `log/`、`model-raw/` 的降权过强，可能影响某些真正需要日志排查的任务。  
  缓解：将“日志优先”作为特定 debugging 子策略，而不是全局禁止。

- [风险] 更强的换路/收口策略可能让 agent 显得更保守。  
  缓解：优先输出“确认事实 + 缺失验证点”，而不是简单拒答。

- [风险] profile-specific sufficiency 判定不好设计，容易出现误收口或迟迟不收口。  
  缓解：先从 smoke 暴露最明显的 verification、overview 与 debugging-like 样例切入，并通过测试固定回归样例。

## Migration Plan

1. 定义 exploration policy 的 decision profile、policy signals 与 runtime decision 结构。
2. 在 runtime policy 中加入 source-first / noise-deprioritization / truncation-routing / sufficiency 判定。
3. 让 context shaping 与 activity/trace 能表达当前策略状态。
4. 为 overview、verification、debugging-like 请求添加 focused regression tests 和 smoke。
5. 以默认开启方式落地；若误判明显，可通过配置或特征开关逐步收敛。

回滚时可先撤回 task-specific sufficiency 与换路逻辑，恢复到当前较轻量的 runtime policy。

## Open Questions

- implementation audit 的 sufficiency 规则，第一版是否要求“调用方 + 被调用方”双证据，还是允许单层证据加明确 inference
- `log/`、`model-raw/` 降权规则是否应做成 task-specific，而不是全局 source-first
- repeated exploration 的中间态是否需要独立 turn item，还是先只通过 activity / trace 表达

# mycli Phase 2 产品化路线图

**日期：** 2026-04-06

**状态：** 路线图已确认，待进入分项设计与实施计划阶段

**目标：** 在不引入正式 sandbox 的前提下，把 `mycli` 从“runtime 主链已成型的 v1 agent”推进为“可持续扩展、可追踪、可调试、可完成真实 coding 工作流”的 Phase 2 产品化版本。

---

## 1. 路线图结论

当前 `mycli` 不应该立刻把重心转向 sandbox 或容器级隔离，而应该先把 agent 的产品基础打稳。

本路线图采用以下核心判断：

- 先打基础，再引入 sandbox
- 先补“靠谱执行”，再补“强交互”和“多代理”
- 先把工具、task、trace、grounding 做扎实，再考虑更重的隔离层
- sandbox 在架构上应作为独立 execution layer，而不是当前阶段的主线阻塞项

一句话总结：

`Phase 2 的目标不是把 mycli 变成沙箱产品，而是把它变成一个真正可靠的 coding agent。`

---

## 2. 当前定位

当前 `mycli` 已经具备了一个方向正确的 agent 内核：

- Responses-first 模型协议主线
- block/item-first runtime 抽象
- schema-first tools
- session 持久化
- 基础 memory / skills / planning
- risk decision / approval pause-resume

但它仍然处在“runtime 已成型、产品层未完善”的阶段。

与更完整的 coding agent 产品相比，当前最明显的缺口不在单个功能点，而在以下几类系统性能力：

- 工具结果的 grounding 还不够强
- 缺少真正的 task/subagent runtime
- 缺少更完整的 trace / replay / audit 能力
- 缺少成熟的终端交互层
- 缺少独立 execution policy / sandbox layer

---

## 3. Phase 2 目标边界

### 3.1 Phase 2 要完成什么

Phase 2 重点完成：

- 让工具调用结果更可信、更可追踪
- 让任务执行从“单轮 agent 循环”升级为“可管理的 task 流程”
- 扩展工具体系，减少对 `run_shell` 的依赖
- 增强 session trace / audit / debug 能力
- 稳定 provider/runtime 行为边界

### 3.2 Phase 2 暂不做什么

- 不把 sandbox 作为主线交付项
- 不做容器级或虚拟化级隔离
- 不把 subagent 平台化做到很深
- 不追求一次性做完整 TUI 产品
- 不为了“功能看起来多”而引入过度工程化

---

## 4. 已有基础

当前仓库里已经有几项非常值得保留和继续演进的基础：

### 4.1 Runtime 主链

- 已切换到 Responses-first
- 内部按 block 驱动，不再被旧 completion/message 结构深度绑死
- approval / resume 已能贯通运行时

### 4.2 Tool 基础设施

- tool registry 已 schema-first
- 本地文件与搜索工具已经开始细化
- `run_shell` 已被明确定义为高风险兜底路径

### 4.3 持久化与状态

- session 已可持久化
- memory 已区分 preference / project / session summary
- plan 已从静态字段升级为运行时能力

这些能力说明：

`mycli` 不需要从头推倒重来，而是需要把已有内核外面那一圈产品能力长出来。`

---

## 5. Phase 2 的五个核心工作流

## 5.1 Tool Result Grounding

这是当前最优先的方向。

问题不在于 agent “不会用工具”，而在于：

- 工具结果经常只回注 summary
- 模型拿不到足够多的真实证据
- 后续容易脑补

Phase 2 要实现的目标：

- 搜索工具返回真实匹配片段
- 文件读取工具返回稳定的内容预览
- 编辑工具返回更有用的 diff / affected region 摘要
- tool result 注回 transcript 时保留更多可供推理的真实上下文

成功标志：

- agent 在“搜索 -> 阅读 -> 总结”链路上显著减少幻觉
- 工具结果可用于调试和重放

---

## 5.2 Task / Plan Runtime 升级

当前已有 `update_plan`，但还不是完整任务系统。

Phase 2 应把它升级为更明确的 task runtime，包括：

- task state
- task status transition
- 当前任务与计划项的绑定
- 任务完成标记
- 任务级 checkpoint

要解决的问题：

- 当前计划是“有 plan”，但不是真正“按 task 驱动工作”
- agent 完成某项工作后，缺乏稳定的 task 闭环

目标不是立刻复制复杂项目管理系统，而是让 agent 至少对这几个问题有稳定答案：

- 当前正在做什么
- 为什么在做
- 做完了没有
- 下一步该做什么

---

## 5.3 工具体系扩展

Phase 2 不应继续把大量操作退回 `run_shell`。

应优先扩展高频、结构化、本地 coding 工作流工具：

### 文件管理

- `create_file`
- `mkdir`
- `move_path`
- `copy_path`
- `delete_path`
- `stat_path`

### 搜索与阅读

- `search_text` 底层优先真实 `rg`
- 更好的 `read_file_range`
- 更强的路径/模式过滤

### Git

- `git_status`
- `git_diff`
- `git_log`
- `git_show`

原则是：

- 能结构化就不要先退回 shell
- 能低风险就不要先走高风险工具
- 保留 `run_shell`，但尽量让它只承担真正无法结构化的兜底任务

---

## 5.4 Session Trace / Replay / Audit

当前有 session 存储，但还没有真正的运行时追踪体系。

Phase 2 应该补的不是“更多日志文件”，而是更有意义的 trace 资产：

- 每轮模型调用输入输出概况
- 每次工具调用参数与结果摘要
- 每轮 task / plan 的变化
- approval 决策点与恢复点

后续可以逐步演进为：

- session replay
- session fork
- turn checkpoint
- debug timeline

这会直接提升：

- 调试效率
- 问题复现能力
- 产品可信度

---

## 5.5 Provider / Runtime 稳定性

当前 `mycli` 在主线方向上已经押注 Responses，这个判断是对的。

Phase 2 的重点不是再换协议，而是把协议与 provider 之间的运行时差异收敛住：

- 不同 provider 的响应差异要被 adapter 吸收
- runtime 不应继续泄漏 provider shape
- 配置项和 fallback 路径要更清晰
- 对 provider 不稳定行为要有更可读的错误表现

目标是让用户感受到：

- “换模型”是配置层变化
- 而不是“换模型就像换一套 runtime”

---

## 6. Phase 2 的实施顺序

建议按以下顺序推进：

1. Tool result grounding
2. task / plan runtime 升级
3. 工具体系扩展
4. session trace / audit
5. provider/runtime 稳定性收敛

原因：

- grounding 直接决定 agent 回答是否可信
- task runtime 决定 agent 是否真正可持续工作
- 工具扩展决定 agent 是否能少依赖 shell
- trace 决定后续调试和产品化效率
- provider 收敛适合在主链更稳定后统一打磨

---

## 7. Phase 3 再做什么

在 Phase 2 打稳之后，再推进这些更重的能力更合适：

### 7.1 Subagent Runtime

- 子任务拆分
- 子代理调用
- 汇总结果
- 子任务失败恢复

### 7.2 更成熟的终端交互

- 流式 activity view
- task panel
- tool activity panel
- 更强的 ask/choice 交互

### 7.3 更完整的 session 产品能力

- replay
- fork
- timeline
- 比较不同执行路径

这些能力的重要性很高，但依赖前面 Phase 2 的基础更稳之后再做，整体收益会更大。

---

## 8. Sandbox 的定位

这是当前路线图里非常关键的结论。

sandbox 不应在当前阶段混进 runtime 主线，而应被视为未来的独立 execution layer。

也就是说，后续引入 sandbox 时，最好具备这些特征：

- 可替换的 tool executor
- 可配置的文件访问策略
- 可配置的 shell/network 权限策略
- 可切换的执行模式，例如：
  - local
  - restricted
  - sandboxed

这样 sandbox 会成为：

- runtime 的下层能力边界
- 而不是上层 agent 逻辑里到处散落的条件判断

---

## 9. 成功标准

如果 Phase 2 完成，`mycli` 应达到以下状态：

- 工具结果明显更 grounded，幻觉显著减少
- 任务执行可被 plan/task 状态稳定追踪
- 高频 coding 操作大多能走结构化工具
- session 能用于调试、审计和后续 replay
- 切换 provider 时运行时行为更稳定
- 为 Phase 3 的 subagent 和 Phase 4 的 sandbox 留出清晰边界

---

## 10. 风险与原则

### 风险 1：过早追求“大而全”

缓解：

- 只做对 Phase 2 有直接价值的能力

### 风险 2：把 sandbox 提前混进主线

缓解：

- sandbox 单独设计，不阻塞当前 runtime 产品化

### 风险 3：继续依赖 `run_shell` 掩盖工具缺口

缓解：

- 优先补齐结构化工具
- 明确 `run_shell` 只做兜底

### 风险 4：session 存了很多数据，但不可调试

缓解：

- 优先做 trace 资产，而不只是堆 JSON 文件

---

## 11. 最终判断

`mycli` 当前最需要的不是“更重的隔离层”，而是“更强的执行可信度与产品基础设施”。`

因此，Phase 2 的核心任务应该是：

- 把 agent 的执行链路做扎实
- 把工具和任务系统做完整
- 把可追踪性做出来
- 再为后续 sandbox、subagent 和更强交互留出接口

这条路线会比现在立刻引入 sandbox 更稳，也更符合项目当前阶段。

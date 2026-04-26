## Context

当前 `mycli` 已经完成了 turn context assembly、exploration discipline 与 capability injection，但工具面仍停留在相对早期的形态：

- `ToolRegistryV2.render_for_model()` 会把 registry 中的所有工具直接暴露给模型
- `ExecutionContext.available_tool_names` 目前只是静态工具名列表
- `TurnContextAssembler` 的 tool exposure section 也只是把 `available_tool_names` 拼成一行字符串
- runtime 没有显式区分哪些工具应直接暴露、哪些只应延迟可见、哪些是本轮临时生成的工具
- capability activation 已经能进入 turn history，但还不能正式参与本轮工具面的规划

这套机制的问题不是“工具不能用”，而是随着 agent runtime 继续产品化，它很难承载更复杂的工具生态：

- 工具数量继续增加后，模型上下文会被全量工具定义挤占
- task-scoped dynamic tools 没有正式入口，只能通过旁路临时拼接
- capability 与工具面之间没有主链级联动
- 未来接入 `MCP` 或 provider-specific hosted tools 时，没有统一 router 归口

路线图的阶段三已经明确，下一步不是继续堆工具，而是把工具进入 turn 的过程正式建模成 `tool exposure / router` 主链。

## Goals / Non-Goals

**Goals:**

- 定义 turn-scoped `ToolExposure` 运行时对象，区分 `direct`、`deferred`、`dynamic` 三类工具暴露
- 引入 `ToolExposurePlanner`，让每轮 turn 基于当前任务、capability activation 与静态 registry 规划本轮工具面
- 引入统一 `ToolRouter`，让静态工具与动态工具走同一条校验、执行与结果回写路径
- 支持两类动态工具来源：
  - runtime 生成的 task-scoped dynamic tools
  - capability activation 注入的额外工具
- 让 turn history / turn context 能看到结构化的 exposure 决策，而不再只看到全量工具名列表
- 为未来 `mcp.*` 或其他 provider-specific tool namespace 预留稳定路由边界，但不在本变更中完成 MCP 集成

**Non-Goals:**

- 不在本变更中直接接入完整 MCP client 或远程 connector 生命周期
- 不在本变更中实现完整的检索式 tool catalog / ranking 系统
- 不在本变更中引入复杂的 tool approval / permission matrix
- 不在本变更中重写已有每个具体工具的执行实现，只收敛其暴露与路由方式

## Decisions

### 1. 将“工具注册”与“工具暴露规划”分离

本变更决定保留静态 `ToolRegistryV2` 作为已安装工具的基础注册层，但不再让它直接决定模型看见什么。新增一层 `ToolExposurePlanner`，在 turn 开始时综合：

- 静态工具 registry
- 当前用户请求
- 已激活 capability
- runtime 提供的 task-scoped dynamic tools

生成本轮的 `ToolExposure`。

这样做的原因是：

- registry 适合表达“系统拥有哪些工具”，不适合表达“本轮应该暴露哪些工具”
- exposure 规划是 turn-scoped 决策，需要与任务上下文绑定
- 把规划从 registry 中拆出来，后续才容易接入 dynamic tools、MCP 和按需暴露策略

未采用的方案：

- 继续在 `ToolRegistryV2.render_for_model()` 中增加过滤参数。否决，因为这仍把“注册”和“本轮决策”耦合在一起，后续难以承载多来源工具。

### 2. 用结构化 `ToolExposure` 区分 `direct` / `deferred` / `dynamic`

本变更决定正式定义 `ToolExposure` 及其条目对象，而不是继续只传一个 `available_tool_names` 元组。

三类暴露语义如下：

- `direct`：本轮直接进入模型工具定义，可立即调用
- `deferred`：本轮被识别为相关，但暂不直接暴露；会进入 context/trace 摘要，帮助 runtime 和 surface 解释“为什么没全量开放”
- `dynamic`：由 runtime 或 capability activation 在本轮临时生成，可像 direct tool 一样被调用，但生命周期受当前 turn 约束

这样做的原因是：

- 它为“控制工具面大小”提供了正式语义
- 它让动态工具不再是特殊旁路，而是本轮工具面的一部分
- 它能让 surface 与 trace 更准确解释工具暴露决策

未采用的方案：

- 只增加 `dynamic tools`，不引入 `deferred`。否决，因为阶段三明确要建立工具数量控制和按需暴露机制，没有 deferred 就难以表达“已识别但未直接开放”。

### 3. 所有可调用工具统一走 `ToolRouter`

本变更决定引入统一 `ToolRouter`，负责：

- 根据 exposure 中的 route key / tool id 查找对应执行器
- 对 direct tool 与 dynamic tool 使用一致的校验与执行流程
- 为未来 provider-specific namespace 预留路由分发边界

第一版中，`ToolRouter` 至少覆盖：

- 本地静态 registry 工具
- runtime task-scoped dynamic tools
- capability 注入的 dynamic tools

并为未来预留类似 `mcp.<provider>.<tool>` 的 namespace 归口。

这样做的原因是：

- 当前 “谁能被调” 与 “谁来执行” 仍然几乎等同于 registry，自然无法扩展到多来源工具
- 统一 router 后，runtime 不必再关心工具来源差异，只关心 exposure 是否允许调用
- 这与 agent-native protocol 的方向一致，provider/hosted item 不应污染 CLI 主链

未采用的方案：

- 静态工具继续走 registry，动态工具单独走另一套 dispatcher。否决，因为这会把未来 MCP 再次逼成旁路。

### 4. capability activation 可以贡献动态工具，但 capability 本身不直接等同于工具

本变更决定 capability injection 作为 stage two 的上游输入，可以参与本轮 tool exposure planning，但不把 capability 本身当成工具。

也就是说：

- capability activation 可以声明“本轮额外提供哪些 dynamic tools”
- planner 会把这些工具并入 `ToolExposure.dynamic`
- router 会把这些工具与 runtime-generated dynamic tools 一视同仁地执行

这样做的原因是：

- capability 是“能力进入 turn”的语义，tool 是“动作进入工具面”的语义，两者应关联但不混同
- 这能复用阶段二成果，同时保持层次清晰

未采用的方案：

- 把每个 capability 直接映射为一个工具。否决，因为 capability 往往包含 instructions、依赖和注入行为，不一定天然是 callable tool。

### 5. Tool exposure 决策要进入 turn history 与 context

本变更决定 tool exposure 不只用于模型调用，还应作为正式 turn 过程的一部分进入结构化运行时协议。

第一版将至少提供：

- `ExecutionContext.tool_exposure` 之类的结构化对象
- 独立的 tool exposure turn item，用于记录 direct/deferred/dynamic 决策及来源
- `TurnContextAssembler` 根据 `ToolExposure` 渲染 tool exposure section，而不是继续只输出工具名列表

这样做的原因是：

- 只有把 exposure 决策记录下来，trace 和 surface 才能解释 agent “为什么这样暴露工具”
- 这与前面 capability activation 的产品化方向一致

未采用的方案：

- 只在日志里记录 exposure 结果。否决，因为这样无法进入统一 turn 协议与 CLI surface。

### 6. 模型侧只消费 exposure 渲染后的 callable tools

本变更决定模型调用侧不再直接读取 registry 全量工具定义，而改为：

- `ToolExposure.direct`
- `ToolExposure.dynamic`

共同渲染成本轮模型侧 callable tool definitions。

`deferred` 只进入 context/trace 摘要，不直接作为 callable tool definition 下发。

这样做的原因是：

- 它能立即收缩模型可见工具面
- 它让 deferred 分类有清晰、可测试的行为边界
- 它能防止未来动态工具引入后，模型仍只能看见静态 registry

## Risks / Trade-offs

- [风险] 新增 exposure planner 与 router 后，runtime 主链会比现在多一层抽象。  
  缓解：保持 registry 继续做基础注册层，不在第一版同时重构全部工具实现。

- [风险] direct/deferred 的规划策略第一版可能仍较粗糙，出现工具暴露过多或过少。  
  缓解：先把分类和可见性主链搭起来，策略上保持保守默认，并通过 trace 暴露决策结果。

- [风险] capability 贡献动态工具会增加 capability 与工具面的耦合。  
  缓解：明确 capability 只贡献工具描述，不直接接管 router；路由仍统一走 tool exposure 主链。

- [风险] turn protocol 新增 exposure item 会影响 session/trace 兼容。  
  缓解：扩展协议读写与回归测试，保持旧记录向后兼容。

- [风险] 预留 provider namespace 但尚未接入 MCP，可能让边界看起来“未完成”。  
  缓解：在 spec 中明确这是稳定入口预留，而不是 MCP 功能承诺。

## Migration Plan

1. 定义 `ToolExposure`、exposure entry 与 tool router 的领域模型和 runtime 协议扩展。
2. 引入 `ToolExposurePlanner`，先基于静态 registry、用户请求和 capability activation 生成本轮 exposure。
3. 让 runtime 的模型调用、工具校验和执行从 exposure/router 主链读取，而不再直接依赖 registry 全量输出。
4. 更新 turn context / trace / session，让 tool exposure 决策进入结构化可见对象。
5. 为 runtime-generated dynamic tools 与 capability-contributed tools 增加最小接入口，并保留未来 provider namespace 的扩展点。

回滚时可撤回 exposure planner / router / protocol 扩展，恢复为 registry 全量暴露与直接执行路径。

## Open Questions

- direct 与 deferred 的默认分配策略，第一版是否仅做保守白名单，还是允许基于任务类型做轻量启发式分组
- capability-contributed dynamic tools 的声明形式，是由 capability metadata 静态声明，还是允许 resolver/runtime 在激活后动态生成
- provider namespace 第一版是否只保留内部 route key 语义，还是同时在 trace / context 中显式展示

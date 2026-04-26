## Context

阶段三前半段的 `add-tool-exposure-router` 已经让 `mycli` 拥有了 `ToolExposurePlanner`、`ToolRouter` 与 `direct / deferred / dynamic` 的基本分类能力，但 dynamic tools 目前仍然更像一种“允许接进来”的特殊情形，而不是正式的 runtime 对象。

当前主要问题包括：

- dynamic tools 的 descriptor 还不稳定，缺少统一 identity 与 route key 语义
- runtime-generated tools 与 capability-contributed tools 只是都能进入 exposure，但没有统一的契约模型
- dynamic tools 缺少正式 lifecycle，很多状态只存在于执行瞬间
- 缺少 turn/thread scoped 生命周期边界，导致“本轮临时工具”和“可跨轮继续可见的工具”还没有正式区分
- surface 与 trace 目前更容易看到“工具被调用了”，而不是“工具何时被声明、何时过期、为什么被替换”

如果继续在这个基础上直接接 provider tools 或 MCP bridge，会把动态工具再次分裂成不同来源的隐式协议。

因此，本变更的核心不是新增更多工具，而是把 dynamic tools 正式产品化为可被 runtime、session、surface 共同消费的协议对象，并把它作为通用 agent runtime 的能力承载层来建设。

## Goals / Non-Goals

**Goals:**

- 将这条 change 明确定位为 general agent runtime 的能力承载层稳定化，而不是单独的工具实现重构
- 定义统一 `DynamicToolDescriptor` 契约，承载 dynamic tool 的 identity、source、scope、route、schema 与 display metadata
- 定义 `DynamicToolLifecycleState`，让 dynamic tools 从声明到过期拥有可追踪的正式状态流转
- 统一 runtime-generated 与 capability-contributed dynamic tools 的注册入口与协议表达
- 为 dynamic tools 增加 turn/thread scoped 生命周期语义与 conflict handling 规则
- 让 turn context、trace、session persistence 与 CLI activity 能消费结构化的 dynamic tool 信息
- 为后续 provider / MCP / hosted tools 以及多任务 capability profile 预留复用同一 contract 的扩展点

**Non-Goals:**

- 不在本变更中直接接入完整 provider tool bridge 或 MCP client
- 不在本变更中实现 dynamic tool 的搜索排序或 discoverability ranking 系统
- 不在本变更中重写所有静态工具执行逻辑
- 不在本变更中引入新的 approval / sandbox 策略系统，只为后续桥接保留契约边界

## Decisions

### 1. 引入独立的 `DynamicToolDescriptor`，而不是继续复用松散字典

本变更决定将 dynamic tools 升级为正式 descriptor 对象，至少包含：

- `tool_id`
- `display_name`
- `source_type`
- `scope`
- `route_key`
- `input_schema`
- `description`
- `origin_metadata`

这样做的原因是：

- 只有 descriptor 稳定，router、trace、session 才能在不同阶段引用同一工具对象
- 这能让 provider tool bridge 与未来更广义的通用 agent 能力只需实现 descriptor 映射，而不是重新造一套工具对象

未采用的方案：

- 延续当前“把 dynamic tool 当成普通 tool spec 加一点额外字段”。否决，因为这会继续把生命周期和来源语义藏在边上，后续扩展时仍然不透明。

### 2. 用显式 lifecycle state 管理 dynamic tools

本变更决定 dynamic tools 至少经历以下正式状态：

- `declared`
- `exposed`
- `invoked`
- `completed`
- `failed`
- `expired`

其中：

- `declared` 表示工具已进入 runtime contract，但未必已向模型暴露
- `exposed` 表示工具已进入当前模型可调用集合
- `expired` 表示工具不再可调用，但仍可保留历史记录供 trace / replay 使用

这样做的原因是：

- 它能解释“工具出现过，但为什么现在不可用了”
- 它能让 session replay 和 surface 展示具备更完整的时序语义
- 它能让通用 agent 在不同任务中按需装配、复用和回收能力，而不是把能力视为一次性 prompt 附件

未采用的方案：

- 只在调用前后记录 begin/end。否决，因为这无法描述大量关键状态，例如声明未暴露、暴露未调用、调用后过期等。

### 3. scope 只先做 `turn` 与 `thread` 两级

本变更决定第一版只正式支持两种 scope：

- `turn`
- `thread`

原因是：

- 当前 `mycli` 的运行时边界主要仍围绕 turn / thread 展开
- 先把这两级做好，已经足够承载 capability-contributed tools 与后续 provider bridge 的大部分需求

未采用的方案：

- 一次性引入 session / workspace / global 等更多 scope。否决，因为当前 thread/session 边界本身还在演进，过早扩 scope 会显著放大复杂度。

### 4. 冲突处理必须成为协议的一部分，而不是 fallback 逻辑

本变更决定对以下冲突建立明确规则：

- 同名不同来源工具
- 相同 `route_key` 的多工具竞争
- 新工具声明覆盖已有同 scope 工具
- turn-scoped 工具与 thread-scoped 工具在同名时的优先关系

第一版建议规则为：

- `route_key` 冲突优先判定为协议冲突，而不是静默覆盖
- 同名工具允许并存，但必须保留稳定 `tool_id`
- turn-scoped 工具在当前 turn 内可覆盖 thread-scoped 的同名展示，但不能破坏其历史记录

这样做的原因是：

- 动态工具一旦来源变多，冲突不再是例外，而是常态
- 不把冲突纳入契约，后续 trace 与 surface 根本无法解释“为什么调用的是这个工具”

未采用的方案：

- 简单按“最后注入者生效”。否决，因为这虽然实现简单，但会让行为不可解释，也不利于后续 provider 统一接入。

### 5. dynamic tool 生命周期要进入 session persistence

本变更决定 dynamic tools 不只存在于内存态，而要作为正式运行时对象写入 session / trace：

- descriptor 快照
- lifecycle state 变更
- exposure 记录
- invocation / completion / failure / expiration 事件

这样做的原因是：

- 没有持久化，就无法在 turn 之后追溯工具是如何出现、如何消失的
- 后续 provider / hosted item 生命周期也需要相似的记录方式
- 通用 agent 的能力回放、诊断与多 surface 可解释性也依赖同样的记录方式

未采用的方案：

- 只在 activity stream 做临时展示，不进 session。否决，因为这会让 replay、debugging 与 smoke 分析再次失去依据。

### 6. 让 provider / MCP 未来复用同一 contract，但本次只做扩展点

本变更决定在 descriptor 中保留来源与 origin metadata 语义，并在 router / lifecycle 中预留 provider-style route，但不在本变更中真正完成 bridge。

这样做的原因是：

- 能确保下一步 provider / MCP bridge 是在现有 contract 上扩展，而不是另起炉灶
- 同时避免把当前 change 扩大成“动态工具协议 + provider bridge”双重重构
- 也能保证后续新增 writing、research、automation 等任务能力时，仍然进入同一条主链

未采用的方案：

- 把 provider bridge 直接并入这次变更。否决，因为这会把当前 change 的重点从“协议建模”拉回“接入更多外部能力”，风险过大。

## Risks / Trade-offs

- [风险] 新增 descriptor、lifecycle 与 persistence 后，runtime 状态模型会变复杂。  
  缓解：第一版只覆盖 dynamic tools，静态工具继续沿现有主链运行，不做一次性全量统一。

- [风险] turn/thread 双 scope 的边界处理不清会导致工具可见性回归。  
  缓解：增加 scope 优先级与过期规则测试，并在 trace 中显式展示 scope。

- [风险] 冲突处理规则太严格会让某些旧行为失效。  
  缓解：第一版对冲突优先选择显式报错与记录，避免静默覆盖；必要时在后续 change 放宽策略。

- [风险] session 持久化格式扩展可能影响旧记录读取。  
  缓解：通过可选字段与向后兼容读取路径演进，不要求旧 session 立即具备完整 lifecycle 数据。

- [风险] 设计过早面向 provider 可能引入抽象过度。  
  缓解：只保留最小扩展点，不在本变更中实现 provider-specific handler。

## Migration Plan

1. 定义 dynamic tool descriptor、scope、lifecycle state 与冲突模型。
2. 更新 planner / router / runtime，让所有 dynamic tools 通过统一 contract 进入 turn。
3. 扩展 turn context、trace 与 session persistence，记录 descriptor 与 lifecycle 事件。
4. 为 capability-contributed tools 与 runtime-generated tools 接入新 contract。
5. 保持现有静态工具行为不变，确保 change 可渐进落地。

如需回滚，可移除新 descriptor / lifecycle / persistence 字段，恢复 dynamic tools 仅作为 exposure 阶段的临时对象。

## Open Questions

- thread-scoped dynamic tools 在新一轮 turn 中是否默认重新 `exposed`，还是仅在被 planner 再次选中时暴露
- provider-origin dynamic tools 将来是直接复用 `route_key` 语义，还是需要单独的 namespace 字段
- capability-contributed tools 的 origin metadata 是否应保留 capability activation snapshot，便于后续诊断

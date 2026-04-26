## Context

`mycli` 当前已经有一条可运行的 CLI REPL 和 Responses-first runtime，也能通过 `/trace` 事后查看工具执行痕迹。但在实际交互中，用户在等待答案时往往看不到 agent 当前正在做什么，尤其是在搜索、读文件、等待审批或模型请求较慢时，前台体验更接近“沉默”而不是“执行中”。

现有系统里已经有两个接近可复用的信号源：
- `progress_updates`：主要承载模型显式输出的 reasoning/progress 文本
- trace：主要承载事后调试和审计事件

它们都还不适合直接承担实时活动流：
- `progress_updates` 太依赖模型会不会主动说自己在做什么
- trace 更偏落盘审计，不适合直接拿来做前台实时 UI

这次变更的目标，是在 runtime 和 CLI 之间增加一层结构化活动事件，让前台可以稳定显示 thinking / planning / tool activity / waiting approval / model error，而不需要先重做整个终端 UI。

约束：
- 第一版保持纯文本活动流，不做复杂 TUI
- 保持现有 `progress_updates`、`/trace` 和最终 assistant answer 的兼容性
- 活动流应由 runtime 主动产出，而不是由 CLI 猜测

## Goals / Non-Goals

**Goals:**
- 增加一个 runtime 产出的结构化 `ActivityEvent` 模型
- 扩展 `TurnResponse`，让 CLI 能收到活动事件并在前台渲染
- 覆盖 thinking / planning / tool_started / tool_finished / waiting_approval / model_error 这几类核心状态
- 为高频工具生成可读的活动文案，例如 `Reading`、`Searching`、`Editing`
- 保持现有 `progress_updates` 和 `/trace` 工作正常

**Non-Goals:**
- 不在本次变更里实现真正的 TUI、多栏布局或状态栏
- 不做 token 级流式展示
- 不把模型原始返回全文实时暴露到前台
- 不重做 `/trace` 系统
- 不在第一版里引入颜色主题或复杂终端样式控制

## Decisions

### 1. 使用独立的 `ActivityEvent` 模型，而不是复用字符串型 `progress_updates`

这次变更会增加结构化活动事件模型，并通过 `TurnResponse.activity_events` 传给 CLI。

为什么这样设计：
- `progress_updates` 更适合承载模型自发 reasoning，不适合稳定表示工具动作
- 结构化事件更便于 CLI 渲染，也更适合未来复用到 richer UI

考虑过的替代方案：
- 只增强 `progress_updates`：否决，因为它过度依赖模型是否主动输出执行状态
- 让 CLI 从 trace 或最终消息里反推活动：否决，因为职责会混乱，而且不稳定

### 2. 让 runtime 成为唯一活动事件源

活动事件只由 runtime 在关键节点主动发出，CLI 只负责渲染。

为什么这样设计：
- runtime 最了解当前阶段是在请求模型、调用工具、等待审批还是报错
- 避免 CLI 自行推断造成不一致

考虑过的替代方案：
- 让 CLI 通过工具名和最终输出拼接活动流：否决，因为会复制 runtime 语义

### 3. 第一版只做纯文本 `[activity]` 行

CLI 先输出简单的 `[activity] Thinking: ...` / `[activity] Reading: ...` 样式。

为什么这样设计：
- 改动小，验证快
- 与当前 CLI 输出风格兼容
- 测试成本低

考虑过的替代方案：
- 直接做更像 Codex CLI 的复杂状态 UI：否决，因为范围会迅速扩大成终端前端重构

### 4. 工具活动文案做显式映射，不直接展示全部参数

为高频工具定义可读的活动文案映射，例如：
- `read_file` → `Reading: <path>`
- `read_file_range` → `Reading: <path>:<start>-<end>`
- `search_text` → `Searching: query=<query>`

为什么这样设计：
- 用户最关心的是“正在做什么”，不是完整参数结构
- 可以减少噪音，同时保留后续扩展空间

考虑过的替代方案：
- 直接显示完整参数字典：否决，因为可读性太差

### 5. 活动流和 trace 保持分层，不直接耦合

这次变更不会让 CLI 直接消费 trace 文件来做前台渲染。

为什么这样设计：
- trace 面向事后调试和审计
- activity 面向实时用户体验
- 两者虽然信息相关，但职责不同

考虑过的替代方案：
- 直接把 trace 变成实时前台显示源：否决，因为会让前台展示和落盘日志耦合过深

## Risks / Trade-offs

- [活动流过吵，掩盖最终答案] → 第一版只显示高价值动作，不显示完整 payload 或原始响应
- [活动流和 `progress_updates` 重复] → 结构化事件优先表达“正在做什么”，`progress_updates` 继续承载模型自发 reasoning
- [runtime 增加事件后，CLI 输出顺序变复杂] → 保持固定顺序：`[activity]` 在前，`assistant_message` 在后
- [第一版看起来仍然不够像完整 TUI] → 有意控制范围，先验证事件模型和交互价值，再演进终端 UI

## Migration Plan

1. 在 runtime/domain 层定义 `ActivityEvent`
2. 扩展 `TurnResponse` 以承载 `activity_events`
3. 在 runtime 关键节点发出 thinking / planning / tool / approval / error 事件
4. 在 CLI 中增加 `[activity]` 渲染
5. 补充 CLI 和 runtime 测试，确认兼容性和顺序

回滚策略：
- 直接回滚该变更即可；第一版不涉及持久化 schema 迁移，也不影响已有 session 数据结构

## Open Questions

- 后续是否需要把模型原始返回摘要也作为活动流的一部分显示
- 将来如果做更强的终端 UI，是否沿用同一套 `ActivityEvent`，还是再细分事件类型

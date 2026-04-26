# mycli Agent Runtime 产品化设计

**日期：** 2026-04-11

**状态：** 设计收敛，可进入计划阶段

## 1. 设计结论

`mycli` 下一阶段不应继续被理解为“补几个 Responses 兼容 bug”，而应被理解为：

`把 mycli 从一个能调用工具的本地 CLI agent，升级成一个协议完整、状态清晰、具备自约束执行纪律的 agent runtime。`

本设计的核心判断有两条：

1. 当前 `mycli` 的短板不是单点功能缺失，而是 **Responses runtime completeness** 和 **agent discipline runtime** 两层都还不完整
2. 如果不先把 runtime 协议层和执行纪律层做起来，继续增加工具、日志或 UI 只会让系统更复杂，而不会让 agent 更成熟

因此，本轮产品化设计选择的总体路径是：

- 继续以 OpenAI Responses 为主协议
- 建立内部稳定的 runtime protocol，而不是让 provider event 直接泄漏到 CLI
- 将 runtime loop、session/thread、policy、prompt、state、UI 进一步拆层
- 把“什么时候继续探索、什么时候应该停止并回答”升级成正式策略层

一句话概括：

`先把 mycli 的 agent runtime 做对，再把体验做强。`

---

## 2. 当前问题

结合近期真实 smoke test、日志和调研资料，`mycli` 目前主要存在四类问题。

### 2.1 Responses 协议适配仍不完整

当前系统已经能消费部分 Responses 内容，但仍然停留在“能跑”的阶段，还没有进入“稳定 runtime protocol”的阶段。

已经接住的能力包括：

- 非流式 `reasoning`
- 非流式 `function_call`
- 非流式 `message.output_text`
- 一部分 streaming tool call 事件

但还存在以下缺口：

- Responses streaming event 还没有被完整归一化
- provider 兼容层还比较脆弱
- 一部分 item lifecycle 仍依赖临时推断，而不是正式状态机
- CLI / trace / session persistence 还没有完全建立在同一套 turn/item 协议上

这意味着：

- `mycli` 现在还没有真正拥有一层“稳定的 agent-native Responses runtime”

### 2.2 agent 会调用工具，但不会自约束

当前 `mycli` 最突出的问题，不是不会工具调用，而是：

- 不会判断什么时候信息已经足够
- 不会识别自己在重复探索
- 不会约束自己只基于已知证据继续规划
- 不会主动收敛到“给出答案”

这使得它表现出来更像：

- “模型说继续读，我就继续读”

而不像：

- “我已经有足够证据，可以回答了”

### 2.3 状态与生命周期建模还不够成熟

当前 `mycli` 已经有：

- session
- conversation
- pending approval
- trace
- workspace logs

但还没有像成熟 agent runtime 那样正式区分：

- thread
- turn
- item
- approval lifecycle
- compaction lifecycle
- stop reason

所以当前的很多逻辑仍然依赖隐式约定，而不是显式状态。

### 2.4 CLI 承担了过多“运行时理解”责任

当前 CLI 已经能渲染：

- activity
- progress
- plan
- decision
- stream chunks

这是很好的基础，但从产品化角度看：

- CLI 应该是 runtime 的 surface
- 不应该成为协议、provider 差异和状态机的实际承载者

如果继续沿着当前方向演进，后面做 TUI、IDE、Web surface 时会越来越难拆。

---

## 3. 设计目标

本轮产品化设计希望达到以下目标：

1. `mycli` 对 Responses 形成稳定、可演进的 runtime protocol
2. `mycli` 拥有正式的 agent discipline 层，而不是把执行纪律完全交给模型“自觉”
3. `mycli` 的会话和执行过程建立在清晰的 thread / turn / item / approval / tool lifecycle 之上
4. CLI 成为 surface，而不是 runtime 主体
5. 后续无论接 TUI、IDE 还是 Web，都能复用同一套 runtime 与协议层

---

## 4. 设计原则

### 4.1 协议优先

先定义稳定内部协议，再做 provider 适配、runtime 消费和 UI 渲染。

### 4.2 分层清晰

runtime、policy、state、session、UI、provider compatibility 各自负责一件事。

### 4.3 安全与执行纪律内建

approval、exec policy、sandbox policy、stop policy 不属于边角逻辑，而属于主链能力。

### 4.4 基于证据，而不是基于猜测

agent 的下一步规划应优先基于已获取证据，而不是模型对常见项目结构的先验。

### 4.5 先保证正确，再保证花哨

协议完整性和执行纪律优先于复杂 UI 和“看起来很聪明”的展示。

---

## 5. 总体架构

建议将 `mycli` 的未来运行时明确拆成以下几层：

### 5.1 Provider Compatibility Layer

职责：

- 对接 OpenAI Responses 及兼容 provider
- 吸收不同 provider 的 wire-level 差异
- 将 raw response / stream event 转成统一的 normalized provider event

不应负责：

- session 管理
- CLI 渲染
- runtime policy

### 5.2 Runtime Protocol Layer

职责：

- 定义 `thread / turn / item / approval / compaction / stop reason`
- 定义内部稳定事件模型
- 让 runtime、trace、CLI、state 都消费同一套协议对象

这一层是后续最关键的新抽象。

### 5.3 Runtime Orchestration Layer

职责：

- 驱动一轮 turn 的执行
- 协调模型调用、工具调用、审批等待、turn 完成
- 管理 turn 的生命周期与状态迁移

### 5.4 Runtime Policy Layer

职责：

- grounded planning
- loop detection
- evidence sufficiency
- exploration budget
- stop policy

这一层决定 `mycli` 像不像 Codex/Claude Code。

### 5.5 Session / State Layer

职责：

- thread/session 持久化
- turn history
- resume / fork / rollback 的未来基础
- approval 状态、plan 状态、tool timeline、stop reason 持久化

### 5.6 Surface Layer

职责：

- CLI/TUI/IDE/Web 仅负责交互与渲染
- 不承担 provider 差异处理
- 不承担 runtime 主状态机

---

## 6. 内部协议设计

本轮建议把以下对象提升为正式协议实体。

### 6.1 Thread

表示一个长生命周期 agent 会话容器。

建议负责：

- thread id
- source workspace
- model/provider identity
- 当前配置快照
- 历史 turn 列表

### 6.2 Turn

表示一次用户请求驱动的一段 agent 工作。

建议包含：

- turn id
- user request
- turn status
- turn started / completed timestamp
- stop reason
- item 列表

turn status 建议至少支持：

- `in_progress`
- `waiting_approval`
- `completed`
- `failed`
- `interrupted`

### 6.3 TurnItem

建议至少包含：

- `user_message`
- `assistant_message`
- `reasoning`
- `tool_call`
- `tool_result`
- `approval_request`
- `approval_resolution`
- `plan_update`
- `context_compaction`
- `warning`

这比当前只有 `RuntimeBlock` 更适合长期演进，因为它能显式表达“运行时发生了什么”。

### 6.4 StopReason

这是当前 `mycli` 缺失但非常关键的一项。

建议至少支持：

- `assistant_completed`
- `sufficient_evidence`
- `loop_detected`
- `max_steps_reached`
- `approval_required`
- `runtime_error`
- `model_error`

这会直接改善：

- CLI 可解释性
- trace 调试能力
- 产品可观测性

---

## 7. Responses Runtime Completeness 设计

### 7.1 目标

让 Responses 不再只是“模型接口”，而是 `mycli` agent runtime 的正式主协议。

### 7.2 设计要点

建议新增一层正式 `event_mapping`：

- raw Responses item / stream event
  ->
- normalized provider event
  ->
- runtime protocol item

### 7.3 需要完整覆盖的能力

至少应正式支持：

- `message`
- `reasoning`
- `summary`
- `function_call`
- `function_call_output`
- `output_text`
- `response.completed`
- streaming item lifecycle
- streaming text/message parts
- tool call state assembly

### 7.4 provider compatibility

这一层需要接受一个现实：

- OpenAI 原生 Responses
- DashScope 兼容 Responses
- 未来可能的其他兼容层

不会严格同构。

因此需要单独的 provider compatibility 逻辑吸收差异，例如：

- 某些事件缺少 `call_id`
- 某些事件通过 `output_item.added` 先给出框架，再通过 delta/done 补全
- 某些 provider 会提供重复 completion
- 某些 provider 会额外产生 `content_part.added`

这部分逻辑不应继续散落在 CLI 或 runtime loop 中。

---

## 8. Agent Discipline Runtime 设计

这是 `mycli` 下一阶段最重要的能力层。

### 8.1 Grounded Planning

要求：

- 模型下一步动作应优先基于已经获取的真实工具证据
- 对未被工具证明存在的路径、文件、模块，不应先假设存在

落地方向：

- 在 prompt 中显式提醒
- 在 runtime policy 中检测“未grounded路径访问”
- 在 trace 中记录 grounding basis

### 8.2 Sufficiency Judge

要求：

- agent 要能判断“当前信息是否已经足够回答”

尤其对以下任务类型要更激进收敛：

- 仓库结构概览
- 入口文件分析
- 简短总结
- 模块职责梳理

建议策略：

- 当已经获取入口配置 + 主模块目录 + 核心入口文件时，优先尝试回答
- 不要在“概览型任务”中继续扩展探索到过多次级目录

### 8.3 Exploration Budget

不是所有任务都应共享同一个 `max_steps`。

建议在 runtime 内引入任务预算概念，例如：

- overview / summary：低预算
- debugging / analysis：中预算
- implementation / migration：高预算

第一版不一定要做复杂分类器，但至少要支持基本任务类型 heuristic。

### 8.4 Loop Detector

当前 `mycli` 最需要这一层。

建议检测：

- 重复读同一文件
- 重复列同一路径
- 重复寻找入口
- 连续多轮没有获得新证据

命中后策略：

- 先注入 runtime reminder
- 再要求模型总结已知信息和缺失点
- 再不收敛则主动停止并返回当前最佳答案

### 8.5 Stop Policy

runtime 应负责定义什么时候停，而不只是等模型偶然输出最终答案。

建议 stop 条件包括：

- 已获取足够证据
- 命中 loop detector
- 达到任务预算
- 等待审批
- 运行时错误

---

## 9. Tool Runtime Contract 设计

当前 `mycli` 的一个实际问题是：

- 工具失败时常常会直接抛异常

这会把模型的规划错误直接升级为整轮 turn 的运行错误。

### 9.1 设计目标

让工具错误尽量成为**可恢复、可继续推理的结构化结果**，而不是 runtime 崩溃。

### 9.2 建议

对文件/目录工具统一改成：

- `success=False`
- `summary=<简明错误>`
- `error=<结构化错误文本>`
- `raw_payload` 明确说明失败原因

例如：

- 文件不存在
- 路径不是目录
- 编码不支持
- 权限不足

这样即使模型访问了不存在的 `src/mycli/main.py`，它也会收到：

- “该文件不存在”

而不是直接炸 turn。

### 9.3 价值

- agent 可以从错误中恢复
- trace 更稳定
- runtime 更接近成熟产品行为

---

## 10. Session / State 设计

### 10.1 从 session 快照走向 event-sourced state

当前 `mycli` 已经有：

- session 文件
- trace 文件
- raw model log

这很好，但长期建议演进到：

- append-only event log

至少应把以下内容逐步变成一等事件：

- turn started/completed
- item started/completed
- tool started/finished
- approval requested/resolved
- compaction happened
- stop reason chosen

### 10.2 为什么需要这个

这样可以更好支持：

- replay
- resume
- fork
- rollback
- UI 恢复
- 调试与审计

---

## 11. Prompt System 设计

当前 prompt 仍然偏简单：

- system prompt
- react prompt
- conversation

建议后续拆成：

- identity / role
- stable instructions
- runtime overlays
- skill overlays
- approval/safety overlays
- grounding reminders
- stop / loop reminders

这会更接近成熟 agent runtime 的 prompt 架构，也更适合与 runtime policy 联动。

---

## 12. CLI / Surface 设计

CLI 的目标不再是“自己理解所有运行时细节”，而应是：

- 渲染 runtime events
- 处理用户输入
- 处理审批交互
- 展示 thread / turn / item 状态

后续可逐步增加但不应提前耦合：

- turn stop reason 展示
- 当前证据摘要展示
- 当前 active budget 展示
- loop warning 展示

---

## 13. 分阶段落地建议

### Phase 1：Responses Completeness

目标：

- 建立 normalized event mapping
- 补齐 Responses item lifecycle
- 吸收 provider compatibility

### Phase 2：Tool Failure Contract

目标：

- 让工具失败尽量可恢复
- 避免模型规划错误直接炸 turn

### Phase 3：Runtime Policy

目标：

- grounded planning
- sufficiency judge
- exploration budget
- loop detector
- stop policy

### Phase 4：State / Session Upgrade

目标：

- turn/item lifecycle 持久化
- 更好的 replay / resume / fork

### Phase 5：Surface 解耦

目标：

- CLI 只做 surface
- 为未来 TUI / IDE / Web 做准备

---

## 14. 风险与权衡

### 风险 1：短期会增加系统复杂度

这是必然的，但如果不拆层，复杂度只会以更难维护的方式堆积在 `AgentRuntime` 中。

### 风险 2：协议设计过早抽象

要避免“先做一个大而全 protocol”，应从当前已知高价值对象开始：

- thread
- turn
- reasoning
- tool_call/result
- approval
- compaction
- stop_reason

### 风险 3：runtime policy 过强会压制模型

这点要靠设计边界解决：

- policy 负责约束探索
- 不是替代模型思考
- 优先提醒与引导，再做强制停止

---

## 15. 结论

`mycli` 的下一阶段，不应继续理解为“修更多兼容问题”或“补更多工具”，而应理解为：

`建立一个以 Responses 为主协议、具备自约束执行纪律、具备清晰状态与生命周期的 agent runtime。`

真正值得优先做的，是这四件事：

1. 建立内部稳定 protocol
2. 补齐 Responses completeness
3. 建立 runtime policy
4. 让工具失败可恢复、会话状态可追踪

完成这一步后，`mycli` 才会真正从一个“本地 coding agent demo”进入“可持续产品化演进的 runtime 系统”阶段。

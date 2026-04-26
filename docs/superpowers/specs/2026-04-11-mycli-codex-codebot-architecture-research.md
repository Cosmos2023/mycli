# mycli 对标 Codex 与 codebot 的架构调研

日期：2026-04-11

## 背景

当前 `mycli` 已经具备了一个可运行的本地 coding agent 雏形：

- 有基于 Responses 的模型接入
- 有 runtime loop
- 有工具系统
- 有 activity stream / trace / workspace logging
- 有 session、approval、plan 的基础能力

但从最近的真实 smoke test 来看，`mycli` 仍然存在两个核心短板：

1. Responses 协议还没有被完整适配成稳定的 agent runtime 语义层
2. agent 还缺乏类似 Codex 或 Claude Code 的高自主、高自约束执行纪律

这份文档的目标不是做“产品功能对比”，而是调研两个值得借鉴的参照：

- OpenAI Codex：重点看其 harness / App Server / stable protocol 思路
- `voocel/codebot`：重点看其 execution kernel 与 harness/runtime 的分层

然后提炼出对 `mycli` 最有价值的架构原则与落地方向。

## 调研对象

### 1. OpenAI Codex

从 OpenAI 官方资料看，Codex 的关键不是“模型更强”本身，而是它把 agent 体验做成了一个可复用的系统层：

- Codex 不只存在于一个界面，而是同时存在于 web、CLI、IDE extension、桌面端
- 这些表层产品共享同一套 Codex harness
- 为了支撑多客户端复用，OpenAI 又在 harness 外层抽象出了 App Server

这说明 Codex 的架构重点是：

- 把 agent loop 从具体 UI 中剥离
- 把 conversation lifecycle 抽象成稳定协议
- 把 approval、tool execution、streaming progress、persistence 变成可复用的 runtime 能力

### 2. codebot

`codebot` 的 README 和代码非常明确地表达了一个核心思想：

- `agentcore` 负责 execution kernel
- `codebot` 负责 harness/runtime layer

这是一种非常值得借鉴的分层：

- kernel 解决：模型调用、工具执行、事件流、消息状态
- harness 解决：prompt composition、session persistence、approval flow、context compaction、runtime reminders、TUI orchestration

这和 `mycli` 当前“runtime、工具、UI、session、协议适配部分混在一起长”的趋势相比，更利于长期演进。

## Codex 可借鉴的点

### 1. 先有稳定 conversation primitives，再有 UI

OpenAI 在 App Server 里没有把协议建立在“某个具体界面如何显示”上，而是建立在三个稳定对象上：

- Thread
- Turn
- Item

其中：

- Thread 是持久会话容器
- Turn 是一次用户请求驱动的一段 agent 工作
- Item 是原子输入/输出单元，拥有明确生命周期：
  - `item/started`
  - `item/*/delta`
  - `item/completed`

这对 `mycli` 的启发非常直接：

- 当前 `mycli` 已经有 `TurnResponse`、`RuntimeBlock`、`RuntimeItem` 的雏形
- 但这些对象还没有被提升成“稳定 runtime protocol”
- 目前 CLI、adapter、runtime 之间仍然共享了不少隐式假设

`mycli` 后续应该把 Responses-native 语义统一沉淀成自己的一套稳定 conversation primitives，而不是让 UI 和 provider event 紧耦合。

### 2. 把 harness 做成可被多个 surface 复用的运行时

Codex 的 App Server 不是“额外多做一层”，而是为了解决一个根问题：

- 同一个 agent harness 要被 CLI、IDE、桌面端、Web Runtime 重复使用

其本质是：

- agent 逻辑不属于 UI
- UI 只是消费 runtime events 的客户端

这点对 `mycli` 的意义是：

- 当前 `mycli` 还比较像“CLI 内嵌 agent”
- 未来如果要做 TUI、IDE plugin、Web 控制台或多 agent orchestrator，最好尽早把 runtime 与界面解绑

建议方向：

- `mycli-core` 或等价的 runtime kernel
- `mycli-cli` 作为一个 thin client
- 后续如果有 IDE/TUI，也只消费同一套 runtime protocol

### 3. Streaming 不能只是 token 流，而要是稳定事件流

Codex App Server 强调的不是“模型能流式输出文本”，而是：

- 一个 client request 会对应 many event updates
- 这些 updates 被转换成稳定、UI-ready 的 notifications

这和当前 `mycli` 的差异很明显：

- 现在 `mycli` 更偏向“尽量接住 provider streaming”
- 但还没把 streaming 正式变成内部稳定事件模型

对 `mycli` 的启发：

- Responses 适配不该停在 `text_delta` / `reasoning` / `tool_call`
- 应该形成一层正式 runtime event：
  - turn_started
  - item_started
  - item_delta
  - approval_requested
  - tool_started
  - tool_finished
  - assistant_message_delta
  - turn_completed

一旦这一层稳定，CLI 和 trace 就只是订阅者。

### 4. Approval 是 conversation protocol 的一部分，而不是边角逻辑

Codex 的 App Server 把 approval 直接建模成协议里的正式交互：

- server 可以主动发起 request
- client 回复 allow / deny
- turn 在等待审批时暂停

`mycli` 当前也已经有 approval flow，但实现更偏“runtime 中途插一个 pending_decision”

这不是错，但可以更系统：

- approval request 应该是 turn/item lifecycle 的正式状态
- trace、session persistence、CLI rendering、resume/fork 都应该理解这个状态

## codebot 可借鉴的点

### 1. 明确区分 execution kernel 与 harness

这是 `codebot` 最值得借鉴的地方。

从代码结构上看：

- `internal/bootstrap/assemble_runtime.go`
- `internal/agent/session_runtime.go`
- `internal/agent/runtime_policy.go`
- `internal/storage/session_store.go`

说明它不是把“一个大 agent”堆在一起，而是拆成：

- execution kernel：`agentcore`
- harness/runtime：session、runtime policy、prompt、approval、compaction、tool orchestration
- application surface：UI、commands、print mode

这比“把所有 agent 智能都写进一个 runtime 类”更适合产品化。

对 `mycli` 的直接建议：

- 不要继续让 `AgentRuntime` 一路膨胀成单一超级对象
- 应该拆出：
  - protocol adapter
  - runtime policy
  - session orchestrator
  - prompt manager
  - tool execution coordinator
  - ui renderer

### 2. Runtime policy 要成为正式模块

`codebot` 里有一个很重要的文件：

- `internal/agent/runtime_policy.go`

它做的不是工具实现，而是执行纪律：

- 跟踪最近工具调用
- 做 repeated tool call detection
- 在重复调用时注入 runtime reminder
- 在 turn 结束前后做额外校验

这正好击中了 `mycli` 现在最大的痛点。

`mycli` 当前的问题不是“不会调用工具”，而是：

- 不会判断什么时候该停
- 不会判断自己在重复探索
- 不会基于已有证据收敛

所以 `mycli` 需要的不是更多工具，而是一个正式的 `runtime_policy` 层。

建议最少包含：

- repeated call detector
- exploration budget
- evidence sufficiency judge
- stop reason evaluator
- grounded planning reminder / steering

### 3. Context compaction 不是简单截断，而是策略组合

`codebot` 的 `assemble_runtime.go` 和 `compaction_policy.go` 显示，它的上下文压缩不是“一把切 recent messages”，而是策略化的：

- tool result microcompact
- light trim
- full summary
- summary 后再注入恢复消息
- 对关键文件做 post-compact recovery

相比之下，`mycli` 当前的 `ContextManager` 还比较简单：

- recent messages
- older conversation summary

这会带来两个问题：

- 一旦 turns 多了，早期关键事实容易被压扁
- 模型更容易从“真实证据”回退到“先验猜测”

这和当前 `mycli` 在 smoke test 里开始脑补 `src/mycli/main.py`、`src/mycli/cli.py` 的行为是吻合的。

建议：

- 将 compaction 升级为策略层
- 优先保留高价值工具结果
- 对关键工作区事实做恢复注入
- 不要只保留“摘要”，还要保留“grounding anchors”

### 4. 会话持久化做成 append-only event log

`codebot` 的 `session_store.go` 采用 append-only JSONL session store，这一点非常强：

- crash-safe
- human-readable
- 天然适合 replay / resume / fork
- 更接近 agent-native event sourcing

`mycli` 目前已有 session 文件和 trace，但整体更偏“快照持久化”，而不是“事件持久化”。

这会带来几个限制：

- replay 能力弱
- 线程分叉困难
- 很难重建完整 reasoning / tool / approval timeline

建议：

- 长期考虑把 session persistence 向 append-only event log 演进
- 至少让 turn / tool / approval / plan / summary 变成一等事件

### 5. Prompt manager 和 runtime overlays 是独立层

`codebot` 的 `session_prompt.go` 很值得注意：

- tools 的可见性是可控的
- MCP instructions、plan mode prompt、approved plan prompt 都是 overlay
- reminder 不是硬编码在一个大 prompt 字符串里，而是动态重建

这比 `mycli` 当前的 prompt 方式更成熟。

当前 `mycli` 的 prompt 更接近：

- system prompt
- react prompt
- conversation

但缺少 runtime overlays 和动态 steering 机制。

建议 `mycli` 后续把 prompt 系统拆成：

- identity / role
- static instructions
- runtime overlays
- skill overlays
- safety overlays
- stop / loop reminders

这样“像 Codex/Claude Code 那样的自约束”才有工程落点。

## 对 mycli 最有价值的架构结论

### 结论 1：`mycli` 需要一个独立的 harness/runtime 层

当前 `mycli` 更像“CLI + runtime + adapter 的混合体”。

借鉴 Codex 和 codebot 后，更合理的方向是：

- kernel：
  - model protocol normalization
  - tool execution
  - runtime events
- harness：
  - session lifecycle
  - runtime policy
  - context engineering
  - approval orchestration
  - persistence
- surface：
  - CLI/TUI/IDE/Web

### 结论 2：Responses 适配必须升级成稳定 runtime protocol

不能停留在“把 provider event 勉强映射成 block”。

更好的目标是：

- provider event -> normalized internal event
- normalized event -> turn/item lifecycle
- lifecycle -> UI / trace / persistence / approval / replay

也就是说，Responses adapter 应该成为“协议编译层”，而不是“只做字段转换”。

### 结论 3：`runtime_policy` 应该成为下一阶段核心模块

如果不做这一层，`mycli` 很难真正像 Codex / Claude Code：

- 会调用工具，但不会节制
- 会继续探索，但不会判断信息是否已足够
- 会看见目录结构，但仍然可能脑补不存在的路径

这一层应该优先于花哨 UI。

### 结论 4：会话和 trace 应逐步走向 event-sourced

当前 `mycli` 已经有：

- `log/model-raw`
- `log/model-events.jsonl`
- `trace.jsonl`

这是一个很好的起点。

后续应继续把：

- turn started/completed
- item started/completed
- tool start/end
- approval wait/resume
- compaction
- stop reason

都纳入统一事件模型。

## 建议的落地方向

### Phase 1. 补齐 Responses runtime completeness

目标：

- 完整适配 streaming/non-streaming Responses 语义
- 建立 provider compatibility layer
- 建立 item state assembler

产出：

- 稳定 `normalized runtime event`
- 更可靠的日志与 replay 语义

### Phase 2. 新增 runtime policy 层

目标：

- 重复调用检测
- grounded planning 提醒
- evidence sufficiency 判定
- stop policy

产出：

- agent 不再无限探索
- 简单分析任务能更早收敛

### Phase 3. 升级 context compaction 与 session persistence

目标：

- 保留 grounding anchors
- 更强 replay / resume / fork
- 避免压缩后丢失关键事实

### Phase 4. 将 CLI 降级为 surface，而不是 runtime 主体

目标：

- 让 CLI 只负责渲染和交互
- runtime 能被其他 surface 重用

## 对当前 mycli 的具体借鉴清单

最值得直接抄的，不是具体语言实现，而是这 8 个架构点：

1. 借鉴 Codex 的 `thread / turn / item` conversation primitives
2. 借鉴 Codex 的 stable event protocol，而不是直接把 provider event 暴露给 UI
3. 借鉴 Codex 的 approval-as-protocol 思路
4. 借鉴 codebot 的 `kernel vs harness` 明确分层
5. 借鉴 codebot 的 `runtime_policy` 独立模块
6. 借鉴 codebot 的策略式 context compaction
7. 借鉴 codebot 的 append-only session/event store
8. 借鉴 codebot 的 prompt overlays / runtime reminders 机制

## 参考资料

### OpenAI 官方

- OpenAI, “Introducing Codex”  
  https://openai.com/index/introducing-codex/

- OpenAI, “Unlocking the Codex harness: how we built the App Server”  
  https://openai.com/index/unlocking-the-codex-harness/

### codebot 仓库

- 仓库主页  
  https://github.com/voocel/codebot

- README  
  https://github.com/voocel/codebot/blob/main/README.md

- `internal/bootstrap/assemble_runtime.go`
- `internal/agent/session_runtime.go`
- `internal/agent/runtime_policy.go`
- `internal/agent/compaction_policy.go`
- `internal/agent/session_prompt.go`
- `internal/storage/session_store.go`
- `internal/approval/engine.go`
- `internal/provider/stream_wrapper.go`

## 最终判断

对于 `mycli` 来说，真正值得借鉴的不是“做一个更像 Codex 的界面”，而是：

- 学 Codex 的稳定 conversation protocol 和 harness 复用思路
- 学 codebot 的 kernel / harness 分层与 runtime policy 设计

如果这两层不补齐，`mycli` 即使继续增加工具、trace、UI，也仍然会停留在“会用工具的模型壳子”阶段；只有把 protocol completeness 和 runtime discipline 做起来，`mycli` 才会更接近一个成熟的 coding agent runtime。

# mycli 对 openai/codex 开源客户端的架构调研

日期：2026-04-11

## 调研目的

这次调研聚焦的是 `openai/codex` 的**开源客户端代码**，不是仅看产品介绍。

核心问题是：

- Codex CLI 的开源实现里，哪些设计是 `mycli` 真正值得借鉴的？
- 哪些点不是“功能罗列”，而是能帮助 `mycli` 从一个“会调工具的模型壳子”进化成“成熟 agent runtime”的关键架构能力？

## 快速结论

如果只用一句话概括，`openai/codex` 最值得借鉴的不是某个单点功能，而是这套组合：

1. **协议先行**：先定义稳定 conversation / thread / turn / item / approval / sandbox / tool 协议，再让 CLI/TUI/App 去消费
2. **runtime 拆层**：把 `core`、`protocol`、`state`、`execpolicy`、`sandboxing`、`tui` 拆成独立 crate
3. **安全与权限一等公民**：执行策略、沙箱、网络、审批不是附加逻辑，而是主链的一部分
4. **多 surface 复用**：CLI 不是全部，Codex 通过 app server / protocol 支撑不同客户端形态
5. **上下文与状态长期化**：不仅有消息，还显式管理 thread、turn、compaction、history、state

这几件事组合起来，才让 Codex 看起来像“一个成熟 agent 系统”，而不是“一个命令行封装的大模型”。

## 一、从代码结构看 Codex 的核心设计

Codex 的顶层 monorepo 里，客户端实现主体在 `codex-rs/`。  
其中最值得注意的不是“用了 Rust”，而是它把能力拆成了大量职责明确的 crate。

从 `codex-rs/Cargo.toml` 可以直接看到几个关键模块：

- `protocol`
- `app-server`
- `app-server-protocol`
- `core`
- `state`
- `execpolicy`
- `sandboxing`
- `tools`
- `tui`
- `cli`
- `responses-api-proxy`
- `skills`
- `mcp-server`
- `codex-client`

这说明 Codex 的整体架构不是“一个 CLI 程序”，而是：

- 一个协议层
- 一个核心 runtime 层
- 一个状态与持久化层
- 一个安全/沙箱层
- 一个工具层
- 一个 UI 层
- 再叠加 app server / 多客户端接入层

这一点对 `mycli` 的启发非常大：

- 现在 `mycli` 还比较像“runtime 和 CLI 粘在一起”
- Codex 则明显把**agent 运行时**和**界面表现层**分开了

## 二、值得借鉴的 8 个架构点

### 1. `protocol` 独立成正式层，而不是藏在实现细节里

Codex 在 `codex-rs/protocol/src/` 里专门定义了一整套协议对象：

- `items.rs`
- `approvals.rs`
- `permissions.rs`
- `request_permissions.rs`
- `request_user_input.rs`
- `message_history.rs`
- `models.rs`
- `thread_id.rs`

从 `items.rs` 看，它不是简单把模型输出当字符串处理，而是显式建模：

- `TurnItem`
  - `UserMessage`
  - `HookPrompt`
  - `AgentMessage`
  - `Plan`
  - `Reasoning`
  - `WebSearch`
  - `ImageGeneration`
  - `ContextCompaction`

这点非常关键。

它意味着：

- “一轮 turn 中到底发生了什么”是显式、可序列化、可复用的
- 这些对象不是某个 UI 才看得懂的内部细节，而是稳定协议

对 `mycli` 的借鉴：

- 当前 `RuntimeBlock` / `RuntimeItem` 已经是好方向
- 但还不够完整，也还没升级成稳定 protocol
- 后续应该把：
  - user message
  - agent message
  - reasoning
  - tool call
  - tool result
  - approval request
  - context compaction
  - stop reason
  
  统一提升成正式协议对象

### 2. `core` 层负责“编排与策略”，不是只负责“调模型”

Codex 的 `core/src/` 很大，但从文件名就能看出它不是单纯的 API wrapper：

- `event_mapping.rs`
- `thread_manager.rs`
- `compact.rs`
- `exec_policy.rs`
- `message_history.rs`
- `turn_metadata.rs`
- `rollout.rs`
- `context_manager/`
- `tasks/`
- `memories/`

也就是说，Codex 的 `core` 不是“把 prompt 发给模型”那么简单，而是负责：

- 把 provider/model event 映射成内部 turn item
- 管理 thread 生命周期
- 管理 compaction
- 管理执行策略
- 管理 turn metadata
- 管理 rollout/history

对 `mycli` 的借鉴：

- 不要继续把 `AgentRuntime` 当成唯一大脑
- 需要把 runtime 主链拆出更明确的子模块：
  - `event_mapping`
  - `thread/session_manager`
  - `runtime_policy`
  - `context_compaction`
  - `history_rollout`

### 3. model/provider 事件先做 `event_mapping`，再进入 runtime

`codex-rs/core/src/event_mapping.rs` 非常值得 `mycli` 借鉴。

它做的事情是：

- 先把 `ResponseItem` 解析成内部 `TurnItem`
- 对不同类型分别处理：
  - `Message`
  - `Reasoning`
  - `WebSearchCall`
  - `ImageGenerationCall`

这层的价值是：

- provider wire protocol 不直接污染 runtime 其他部分
- 所有 UI、state、history 都只消费内部稳定 item

对 `mycli` 的启发特别直接：

当前 `ResponsesModelAdapter` 虽然已经开始承担这件事，但还只是“适配器”，还没真正升级成一层稳定 `event mapping`。

建议后续明确抽象成：

- provider event / response item
  ->
- normalized runtime event / turn item
  ->
- runtime policy / session / UI

### 4. approval / sandbox / exec policy 是主链能力，不是边角逻辑

在 Codex 里：

- `protocol/src/approvals.rs`
- `core/src/exec_policy.rs`
- `execpolicy/`
- `sandboxing/`
- `linux-sandbox/`
- `shell-escalation/`

这些模块说明一件事：

Codex 不是等到“执行命令时顺手判断一下风险”，而是从协议、策略、执行层到平台沙箱都把安全建成一等公民。

尤其 `exec_policy.rs` 里非常值得注意：

- approval 是否允许出现，是被 policy 约束的
- prompt to user 也要经过 policy 审核
- 有明确的 prefix-rule、network-rule、policy amendment 机制
- 对危险命令、shell 前缀、network 等都有正式规则系统

对 `mycli` 的借鉴：

- 当前 `ApprovalService` 是一个良好的起点
- 但还远没有形成 `exec policy + sandbox policy + network policy + escalation policy` 的完整体系

未来方向应该是：

- `approval` 负责“要不要问用户”
- `exec policy` 负责“执行规则如何表达、匹配、记忆”
- `sandbox policy` 负责“即使执行，也只能在允许边界内执行”

### 5. `thread_manager` 说明 Codex 已经是“长生命周期 agent”，不是单轮聊天

`core/src/thread_manager.rs` 特别重要。

从代码看，它显式管理：

- `ThreadManager`
- `CodexThread`
- `ThreadId`
- loaded threads
- fork / rollback / interrupt
- thread created channel
- skills watcher
- plugin manager
- MCP manager

这说明 Codex 的基本抽象单位不是“某个 prompt”，而是：

- thread
- thread 内的多个 turns
- thread 的 fork / resume / rollback / interrupt

这和 `mycli` 当前的设计差异很大。

现在 `mycli` 虽然也有 session，但还更像：

- 一个 session 文件
- 一个 runtime loop
- 若干消息

而不是完整的 thread runtime。

对 `mycli` 的启发：

- 长期要把 session 提升成真正的 `thread`
- 支持：
  - fork
  - rollback
  - turn boundary
  - thread-level state

### 6. compaction 不是“压缩旧消息”，而是显式 turn 行为

`core/src/compact.rs` 是一个非常有意思的点。

Codex 没把 compaction 视为“内部默默发生的优化”，而是把它显式建模成：

- `ContextCompactionItem`
- compaction prompt
- compaction history rewrite
- analytics / warning / retry
- truncation policy

这有两个价值：

1. compaction 本身成为 traceable 行为
2. compaction 后的上下文恢复有明确策略，而不是“简单摘要一下就完了”

对 `mycli` 的启发：

- 当前 `ContextManager` 过于轻量
- 后续 compaction 应该成为正式 runtime 行为
- 并且要能产生：
  - compaction item
  - compaction reason
  - tokens before/after
  - recovery hints

### 7. `tui` 体量大，但仍然是消费层，不是 agent 核心

`codex-rs/tui/src/` 下面有很多文件：

- `app.rs`
- `streaming/`
- `session_log.rs`
- `status/`
- `slash_command.rs`
- `model_catalog.rs`
- `resume_picker.rs`
- `app_server_session.rs`

这说明 Codex 的 TUI 做得非常厚，但它仍然没有吞掉 runtime。

尤其 `app_server_session.rs` 很关键：

- TUI 并不直接操纵底层模型协议
- 它通过 `AppServerClient` 和 `app-server-protocol` 跟运行时通信

也就是说，UI 是强客户端，但不是 runtime 自身。

对 `mycli` 的借鉴：

- 当前 CLI 不应该继续承载太多业务逻辑
- 最终应该让 CLI/TUI 只做：
  - 输入
  - 渲染
  - 审批交互
  - 历史浏览
  - 状态展示

而不是继续让它直接理解 provider 细节或 runtime 内部状态机

### 8. `app-server` / `app-server-protocol` 是“多 surface 复用”的关键

这是 Codex 对 `mycli` 最有前瞻价值的一点。

`codex-rs` 里单独存在：

- `app-server`
- `app-server-client`
- `app-server-protocol`

而 `app-server-protocol/src/lib.rs` 直接导出：

- JSON schema
- TS types
- initialize / thread / turn / approval / config 等正式协议对象

这意味着 Codex 从一开始就在做：

- runtime 不是只服务当前 CLI
- runtime 可以被：
  - TUI
  - Desktop App
  - IDE
  - 调试客户端
  - 测试客户端
  
  共同复用

对 `mycli` 的启发：

- 短期不一定要上 App Server
- 但从现在开始，就应该把内部协议设计成可远程化、可 schema 化、可被多个 client 消费

## 三、对 mycli 最值得借鉴的架构原则

### 原则 1：把 `Responses completeness` 和 `runtime protocol` 绑定起来做

Codex 的做法说明，协议适配不能只是“字段映射”。

真正正确的方向应该是：

- provider responses / events
  ->
- internal protocol items / events
  ->
- runtime / state / UI

所以 `mycli` 后续补 Responses，不应该停在 adapter 层，而应该直接建设：

- `normalized event protocol`
- `turn item model`
- `approval item model`
- `compaction item model`

### 原则 2：把 runtime strategy 从 runtime loop 里拆出来

Codex 的 `exec_policy`、`compact`、`thread_manager`、`event_mapping` 都说明：

- agent 行为约束不是散落在大循环里的 if/else
- 应该是独立策略模块

对 `mycli` 的直接建议：

- 新增 `runtime_policy` 模块
- 专门负责：
  - exploration budget
  - sufficiency judgement
  - repeated call detection
  - grounded planning reminders
  - stop reason calculation

### 原则 3：安全能力必须产品化，而不是只做“审批弹窗”

Codex 把这条做得很彻底：

- approval
- execpolicy
- sandbox policy
- network policy
- shell escalation

是同一条主链上的不同层。

`mycli` 如果要更像成熟 coding agent，就不能只做：

- “危险命令前问一下”

而要继续演进成：

- 可配置执行策略
- 可记忆 allow rule
- 可表达 prefix/network amendment
- 可审计

### 原则 4：会话要朝 thread/turn 体系演进

Codex 明显不是 message-only agent，而是：

- thread-aware
- turn-aware
- rollback-aware
- fork-aware

这会极大提升：

- 恢复能力
- 调试能力
- 可视化能力
- 多 surface 一致性

`mycli` 现在还偏 session + conversation，后续应逐步升级。

## 四、对 mycli 的具体落地建议

结合 `openai/codex` 的代码结构，`mycli` 下一阶段最值得推进的方向是：

### 1. 建立内部 `protocol` 层

建议新增独立协议模块，统一定义：

- thread
- turn
- turn item
- approval request / response
- tool call / tool result
- compaction
- stop reason

### 2. 建立 `event_mapping` 层

把：

- Responses API
- future legacy / MCP / other provider events

都先映射成内部协议事件，再交给 runtime。

### 3. 建立 `runtime_policy` 层

借鉴 Codex 的策略分离思路，处理：

- grounded planning
- sufficiency judgement
- anti-loop
- escalation discipline
- repetition detection

### 4. 建立 `state/thread_manager` 层

让 `mycli` 不只保存 conversation，而是正式管理：

- thread state
- current turn
- turn history
- rollback/fork
- active approvals

### 5. 将 CLI 降级为 surface

把 CLI 从“主 runtime 容器”调整为：

- input/output surface
- status renderer
- approval interaction client
- session browser

## 五、最值得直接借鉴的点

如果必须只挑最值得 `mycli` 直接借鉴的 5 件事，我会选：

1. `protocol` 独立建模  
   `items.rs` / `approvals.rs` 这种做法非常值得学。

2. `event_mapping` 独立成层  
   provider 事件永远不要直接漏到 UI 和业务层。

3. `runtime strategy` 独立成模块  
   不要把收敛、重复检测、风险控制散落在大循环里。

4. `thread_manager` 取代“单 session loop”思维  
   agent 要有 thread / turn 的生命周期概念。

5. `app-server-protocol` 思维  
   即使现在不做远程 server，也应该先把协议设计成未来可复用。

## 六、结论

`openai/codex` 开源客户端最有价值的地方，不是“功能比 `mycli` 多”，而是它已经把 coding agent 做成了一个**协议化、策略化、可多 surface 复用的系统**。

对 `mycli` 来说，最值得借鉴的不是照抄某个命令或界面，而是这套底层设计原则：

- 协议优先
- 分层明确
- 状态显式
- 安全内建
- 策略独立
- UI 只是客户端

如果 `mycli` 沿着这条路继续做，它就会从“一个能调用工具的 CLI agent”逐步进化成“一个真正可产品化的 agent runtime”。

## 参考资料

- OpenAI Codex 仓库主页  
  https://github.com/openai/codex

- 仓库 README  
  https://github.com/openai/codex/blob/main/README.md

- Rust CLI README  
  https://github.com/openai/codex/blob/main/codex-rs/README.md

- Cargo workspace  
  https://github.com/openai/codex/blob/main/codex-rs/Cargo.toml

- 协议 items  
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/items.rs

- 协议 approvals  
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/approvals.rs

- event mapping  
  https://github.com/openai/codex/blob/main/codex-rs/core/src/event_mapping.rs

- exec policy  
  https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_policy.rs

- thread manager  
  https://github.com/openai/codex/blob/main/codex-rs/core/src/thread_manager.rs

- compaction  
  https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs

- TUI app server session  
  https://github.com/openai/codex/blob/main/codex-rs/tui/src/app_server_session.rs

- app server protocol  
  https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/lib.rs

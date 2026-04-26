# mycli 对 openai/codex 工程化能力的源码级综合研究

**日期：** 2026-04-15

**状态：** 研究完成，作为 `mycli` 后续 runtime、history、tooling、session architecture 演进的上游输入

---

## 1. 研究目标

这份文档不再只回答“Codex 为什么像一个通用 agent”，而是进一步回答：

1. `openai/codex` 的工程化能力，具体是靠哪些源码机制建立起来的
2. 它为什么不仅能“做一件事”，而且能长期稳定地承载复杂、多轮、多工具、多 surface 的工作
3. `mycli` 如果要追赶 Codex，哪些地方应该继续借鉴，哪些地方不能只做表面模仿

这里的“工程化能力”特指下面这些维度：

- runtime 主链是否稳定
- 上下文和历史是否可管理、可恢复、可压缩
- 工具是否是平台能力，而不是临时外挂
- 安全、审批、沙箱、网络是否进入主链
- 多线程 / 多 agent / 多 surface 是否共享统一语义
- 系统是否具备 rollout、重建、调试、回归验证等长期演进基础设施

---

## 2. 研究范围与方法

本次研究直接阅读的是本地 `codex-rs` 源码，而不是产品介绍或二手分析。

重点关注的源码模块包括：

- `core/src/client.rs`
- `core/src/codex.rs`
- `core/src/codex_thread.rs`
- `core/src/thread_manager.rs`
- `core/src/context_manager/history.rs`
- `core/src/tools/orchestrator.rs`
- `core/src/tools/context.rs`
- `core/src/agent/control.rs`
- `core/src/guardian/prompt.rs`
- `core/src/compact.rs`
- `core/src/compact_remote.rs`
- `core/src/state/session.rs`
- `core/src/message_history.rs`
- `core/src/memories/README.md`

研究方法是：

1. 先抽出会话主链、历史主链、工具主链、安全主链
2. 再把这些链路之间的依赖关系串起来
3. 最后从工程能力角度解释“为什么这样设计能工作”

---

## 3. 快速结论

如果只用一句话概括：

**Codex 的工程化能力，不是来自某个强提示词，也不是来自某个单点功能，而是来自一套“会话级状态 + turn 级运行时 + 原生历史项 + 工具平台 + 安全治理 + rollout 可恢复性”共同组成的系统。**

更具体地说，Codex 之所以看起来像一个成熟 agent，而不是“会调工具的模型壳子”，主要因为它同时做对了 8 件事：

1. 把 `session`、`thread`、`turn`、`history`、`item` 当成正式运行时对象
2. 把 provider Responses 协议接到 session-scoped / turn-scoped 双层客户端上
3. 把历史真值建模成 `ResponseItem`，而不是拼接字符串 transcript
4. 把工具调用与工具输出都纳入统一历史和 continuation baseline
5. 把上下文状态做成 `reference_context_item` + diff 更新，而不是每轮全文重灌
6. 把 compaction 设计成“重写历史”，而不是写一段松散 summary
7. 把审批、沙箱、网络策略做成工具编排器的一部分
8. 把 rollout、history、state reconstruction、tests 一起建成可恢复系统

这 8 件事叠在一起，才构成了它的工程化能力。

---

## 4. 总体架构图景

从源码结构看，Codex 不是一个“CLI 程序”，而是一个以 `core` 为中枢、带有清晰 runtime 分层的 agent 系统。

可以把核心结构理解为 6 层：

1. **Provider / transport 层**
   - `core/src/client.rs`
   - 负责 Responses API、WebSocket、HTTP fallback、turn sticky routing、continuation

2. **Session / thread / turn runtime 层**
   - `core/src/codex.rs`
   - `core/src/codex_thread.rs`
   - `core/src/thread_manager.rs`
   - 负责 turn 执行、线程管理、上下文更新、事件发送

3. **History / context 层**
   - `core/src/context_manager/history.rs`
   - `core/src/context_manager/updates.rs`
   - 负责会话历史、上下文基线、diff、压缩、回放

4. **Tool 平台层**
   - `core/src/tools/orchestrator.rs`
   - `core/src/tools/context.rs`
   - `core/src/tools/registry.rs`
   - 负责工具 schema、handler、审批、沙箱、输出适配

5. **安全治理层**
   - `core/src/guardian/prompt.rs`
   - `core/src/exec_policy.rs`
   - `core/src/tools/network_approval.rs`
   - 负责 guardian、审批、网络策略、执行升级

6. **持久化与恢复层**
   - `core/src/rollout.rs`
   - `core/src/codex/rollout_reconstruction.rs`
   - `core/src/message_history.rs`
   - `core/src/state/session.rs`
   - 负责 rollout、历史重建、持久化、恢复

这说明 Codex 的工程能力不是“所有逻辑写在一个 runtime 文件里”，而是每一层都在为“长生命周期 agent”服务。

---

## 5. Session-Scoped Client + Turn-Scoped Session：它为什么能稳定复用 Responses

### 5.1 双层客户端模型

`core/src/client.rs` 的顶部注释已经把设计意图写得很清楚：

- `ModelClient` 是 **session-scoped**
- `ModelClientSession` 是 **turn-scoped**

对应源码：

- `ModelClientState`
- `ModelClient`
- `ModelClientSession`

这层拆分非常关键。

`ModelClient` 持有的是长期稳定状态：

- provider
- auth
- conversation id
- installation id
- websocket fallback state
- cached websocket session

而 `ModelClientSession` 持有的是本轮状态：

- 上一条 request
- 上一条 response 的 `response_id`
- 本 turn 的 `x-codex-turn-state`
- 本 turn 的 websocket connection

也就是说，Codex 从类型层面就把下面两个概念分开了：

- “整个会话共享什么”
- “这一轮执行共享什么”

这比很多 agent runtime 把所有状态都塞进一个大 runtime 里更稳。

### 5.2 continuation 不是字符串猜测，而是结构化增量判定

`client.rs` 中最值得 `mycli` 借鉴的代码之一是：

- `get_incremental_items()`
- `prepare_websocket_request()`
- `map_response_stream()`

关键逻辑是：

1. 记录上一条完整 request
2. 记录上一条 response 的 `response_id`
3. 记录上一条 response 新增的 `items_added`
4. 当前请求来时，比较：
   - 非 `input` 字段是否完全一致
   - 当前 `input` 是否以前一轮 baseline 为严格前缀

这里的 baseline 不是只有旧 `input`，而是：

- `previous_request.input`
- 加上 `last_response.items_added`

然后才决定是否：

- 带 `previous_response_id`
- 只发送 delta `input`

这一点解释了 Codex 为什么 continuation 更稳：

- 它不只看用户文本
- 它把服务端真实返回的 output items 也并入 baseline
- 这让工具调用、工具输出、assistant 输出天然参与 continuation

### 5.3 turn sticky routing 是协议合同的一部分

`ModelClientSession` 里还有一个重要状态：

- `turn_state: Arc<OnceLock<String>>`

源码注释明确说明：

- server 会在 turn start 时返回 `x-codex-turn-state`
- 客户端在同一 turn 的后续请求中必须原样回放
- 不允许跨 turn 复用

这说明 Codex 把“同一 turn 内的多次请求属于一个连续执行单元”提升成了协议级合同，而不是仅靠本地内存猜测。

这也是它在复杂多步 turn 中更稳定的一个原因。

---

## 6. 原生历史模型：Codex 的历史真值是 `ResponseItem`

### 6.1 会话历史不是 transcript 文本，而是结构化 item

`core/src/context_manager/history.rs` 定义的 `ContextManager`，本质上是：

- 一个 session-scoped history manager
- 保存 `Vec<ResponseItem>`
- 附带 `history_version`
- 附带 `reference_context_item`
- 附带 token usage 信息

也就是说，Codex 的历史真值不是：

- 几条拼接好的字符串
- 一段 `conversation summary`
- 或者“最近 N 条消息”

而是：

- provider / runtime 统一语义下的结构化 `ResponseItem`

这样做的直接好处有 4 个：

1. continuation baseline 可以结构化比较
2. compaction 可以结构化重写
3. rollback / undo 可以按 item 粒度操作
4. 多 surface 可以共享同一套历史语义

### 6.2 `record_items()` 只保留模型真正需要的历史项

`ContextManager::record_items()` 会把进入 history 的项做过滤和处理。

重要点在于：

- 不是所有运行时事件都进模型可见历史
- 但所有“对模型后续推理有价值的 item”都会被保留

比如：

- `Message`
- `FunctionCall`
- `FunctionCallOutput`
- `Compaction`
- `GhostSnapshot`

它还会做：

- normalization
- 对应 call/output 的成对维护
- 图像模态过滤
- token usage 估算

这说明 Codex 的历史不是“日志”，而是“准 prompt 历史”。

### 6.3 `for_prompt()` 负责从历史真值生成模型输入

`ContextManager::for_prompt()` 做了最后一步：

- 规范化历史
- 过滤不适合发给模型的项
- 根据 input modality 剔除图像等不兼容内容

也就是说，Codex 的 prompt 构造不是：

> 先拼 prompt，再顺手记一下历史

而是：

> 先维护结构化历史，再从历史导出 prompt

这两者差别非常大。

前者更像“临时 agent”；
后者才像“长期可演进系统”。

---

## 7. 工具调用、工具输出、文件写入：Codex 到底怎么带进下一轮

### 7.1 工具调用和工具输出都进入会话历史

Codex 的工具输出最终会被转换成：

- `ResponseInputItem::FunctionCallOutput`
- 然后进入 `ResponseItem`
- 再被 `record_conversation_items()` 写入 history

关键源码：

- `core/src/tools/context.rs`
- `core/src/codex.rs` 的 `record_conversation_items()`

这意味着：

- 上一轮的 tool call / tool result，不只是终端显示内容
- 它们是下一轮模型历史的一部分
- 也是 continuation baseline 的一部分

这和 `mycli` 现在“tool message 文本摘要 + conversation summary”的方式有本质不同。

### 7.2 工具输出是结构化 payload，不只是“Done”

`core/src/tools/context.rs` 里定义了多种 tool output：

- `FunctionToolOutput`
- `ApplyPatchToolOutput`
- `ExecCommandToolOutput`
- `AbortedToolOutput`

这些输出最终会被包成：

- `FunctionCallOutputPayload`

里面保存的不是简单一句“执行完成”，而是：

- 文本 body
- 多 content items
- success 标记
- 某些情况下的 post-tool-use response
- 对 code mode 可消费的结构化结果

特别是 `ExecCommandToolOutput`，会保留：

- wall time
- exit code
- process/session id
- truncated output
- original token count

这说明 Codex 的工具输出不仅服务当前回答，也服务：

- 下一轮历史
- code mode
- telemetry
- 调试与回放

### 7.3 文件写入的“磁盘真值”和“模型可见痕迹”是分层处理的

Codex 也不会在下一轮自动把“改后的完整文件全文”都塞给模型。

它做的是分层：

1. **磁盘真值**
   - 真正修改发生在 workspace

2. **模型可见痕迹**
   - patch / command / tool output 进入 `FunctionCallOutput`

3. **恢复与撤销痕迹**
   - 某些写入动作还会产生 `GhostSnapshot`

这意味着 Codex 对“写入后的状态”有两个视角：

- 对 agent 执行来说，真实状态在文件系统
- 对模型连续推理来说，历史里保留足够的结构化证据

这是非常成熟的工程思路。

---

## 8. `reference_context_item`：Codex 不会每轮重灌整包上下文

这是另一个非常重要但容易被忽略的设计。

在 `ContextManager` 和 `codex.rs` 中，Codex 明确维护：

- `reference_context_item`

它代表的是：

- 上一轮建立起来的上下文基线
- 下一轮可以据此只发送 context diff

相关主链：

- `build_initial_context()`
- `record_context_updates_and_set_reference_context_item()`
- `build_settings_update_items(...)`

工作方式是：

1. 如果 baseline 缺失，重灌完整 initial context
2. 如果 baseline 存在，只发 settings diff
3. 每个真实 user turn 结束后，刷新新的 `reference_context_item`

这带来 3 个直接收益：

1. prompt 更省 token
2. 上下文更稳定，不容易抖动
3. compaction / resume / rollback 后能重新建立基线

这也是 Codex 比很多 agent 更像“状态机”的原因。

---

## 9. Compaction：Codex 是重写历史，不是写一段松散总结

### 9.1 compaction 是历史替换，而不是附加摘要

Codex 的 `compact.rs` 与 `compact_remote.rs` 说明，它不是简单生成一段 summary 然后继续堆聊天记录，而是：

- 读取当前 history
- 生成 compacted transcript / replacement history
- 必要时重新插入 initial context
- 保留 ghost snapshots
- 最后用 replacement history 替换当前 history

相关函数包括：

- `build_compacted_history(...)`
- `insert_initial_context_before_last_real_user_or_summary(...)`
- `replace_compacted_history(...)`
- `process_compacted_history(...)`

所以 Codex 的 compaction 本质是：

**历史重写**

而不是：

**摘要外挂**

### 9.2 mid-turn compaction 与 pre-turn compaction 都有明确规则

从注释和测试可以看到，Codex 区分：

- pre-turn compaction
- mid-turn compaction
- remote compact
- inline compact

并且对“initial context 插回哪里”有非常明确的训练兼容策略。

这说明它不是“上下文太长了就随便压一下”，而是把 compaction 当成 agent 主链的一部分来做。

这也是它能长期支撑长线程的关键。

---

## 10. 工具平台：Codex 不是工具列表，而是带审批和沙箱的统一编排器

### 10.1 `ToolOrchestrator` 是真正的主控器

`core/src/tools/orchestrator.rs` 顶部注释已经把职责写明：

> approvals + sandbox selection + retry semantics 的 central place

工具执行主链被统一成：

1. approval
2. sandbox 选择
3. attempt
4. denied 时按规则升级重试

这意味着：

- 工具 handler 不负责自己决定审批策略
- 也不自己决定沙箱重试策略
- runtime 有统一工具编排器来做治理

### 10.2 网络审批也被纳入同一主链

`ToolOrchestrator` 还统一处理：

- immediate network approval
- deferred network approval
- managed network requirements

这说明 Codex 对工具执行的治理不是“文件权限一层、网络权限另一层、执行命令再来一层”，而是由 orchestrator 串起来。

这就是工程化能力的一部分：

**不是有安全模块，而是安全逻辑进入了工具主链。**

### 10.3 工具输出协议和工具事件协议是分开的

Codex 还分离了两类东西：

- 工具真正返回给模型的 `FunctionCallOutputPayload`
- 终端/UI/telemetry 用的 `ExecCommandBegin/End`、approval event 等

这意味着：

- UI 不会污染模型 history
- 模型 history 也不会替代审计事件流

这是比很多简单 CLI agent 更成熟的设计。

---

## 11. 安全与审批：Codex 把 guardian 设计成“增量审查者”

`core/src/guardian/prompt.rs` 非常值得单独强调。

它做的不是：

- 每次都把全量对话塞给 reviewer

而是：

- 从主 history 里提取 guardian transcript
- 支持 full prompt
- 也支持 delta prompt
- 用 `GuardianTranscriptCursor` 记录 reviewer 已看过的边界

这说明 Guardian 是一个真正的“审查会话”，不是一次性审批弹窗。

而且它明确把这些东西都视为：

- transcript
- tool call arguments
- tool results
- retry reason
- planned action JSON

并强调它们是：

**untrusted evidence, not instructions**

这体现了 Codex 工程化能力里的另一条主线：

**安全系统也是结构化、有状态、可增量的。**

---

## 12. 多 agent / 多线程：Codex 的通用性还来自可控的线程树

### 12.1 ThreadManager 管的是线程系统，不是单个聊天会话

`core/src/thread_manager.rs` 显示，Codex 显式管理：

- thread registry
- thread creation
- thread fork
- interrupted snapshot
- rollout truncation
- startup prewarm
- plugins / MCP / skills watcher 的共享资源

这意味着 Codex 的基础运行单位不是“当前终端上的一个 loop”，而是：

**线程系统**

### 12.2 sub-agent 不是旁路 hack，而是受控线程分叉

`core/src/agent/control.rs` 里：

- `AgentControl`
- `spawn_agent()`
- `spawn_agent_internal()`
- `SpawnAgentForkMode`

说明 Codex 的 sub-agent 是：

- 由 `ThreadManagerState` 管控
- 受限于 agent registry
- 有 fork mode
- 会控制 fork 后哪些 rollout item 可以保留

特别值得注意的一点是：

`keep_forked_rollout_item()` 明确规定：

- 哪些 user/developer/system 项能继承
- 哪些 assistant final answer 能继承
- 哪些 function call / function output / ghost snapshot / compaction 不能直接带过去

这说明 Codex 并不是盲目把父线程全部上下文复制给子线程，而是有专门的“可继承历史裁剪规则”。

这是成熟多 agent 系统必须具备的东西。

---

## 13. 持久化与恢复：Codex 具备“可回放系统”的特征

### 13.1 rollout 是正式一等公民

`core/src/rollout.rs` 本身只是 re-export，但这说明 rollout 不是边角日志，而是系统核心基础设施。

在 `codex.rs` 中：

- `record_conversation_items()`
- `persist_rollout_response_items()`
- `persist_rollout_items()`
- `replace_compacted_history(...)`

这些都表明：

- conversation history
- rollout persistence
- raw response items

是同时维护的。

### 13.2 rollout reconstruction 说明它可以重建活跃历史

`core/src/codex/rollout_reconstruction.rs` 与大量 reconstruction tests 说明：

- rollout 不是“只能看，不能用”
- 它被设计成可重建 session state 的基础

也就是说，Codex 具备一种非常关键的工程能力：

**把执行过程做成可恢复系统，而不是一次性黑盒过程。**

这点对 `mycli` 很重要，因为通用个人助手如果没有恢复能力，就很难长期可信。

### 13.3 全局 `history.jsonl` 是独立于线程 rollout 的补充通道

`core/src/message_history.rs` 里还有一个全局 append-only 历史：

- `~/.codex/history.jsonl`

它不是主历史真值，但提供：

- 轻量历史持久化
- 全局检索入口
- 跨进程追加能力

说明 Codex 在持久化层不是单一路径，而是：

- thread rollout
- in-memory structured history
- global message history

三者配合。

---

## 14. 记忆系统：Codex 的 memory 不是 prompt patch，而是异步双阶段管线

`core/src/memories/README.md` 很有价值，因为它清晰描述了 memory pipeline。

### 14.1 两阶段设计

Codex 的 memory pipeline 分成：

1. **Phase 1: Rollout Extraction**
   - 从 rollout 提取结构化 memory
   - 并发运行
   - 带 lease / claim / retry backoff

2. **Phase 2: Global Consolidation**
   - 串行 consolidation
   - 刷新 filesystem memory artifacts
   - 运行内部 consolidation sub-agent

这说明它对 memory 的理解不是：

- “每轮多喂几句总结”

而是：

- “把会话执行轨迹转成可长期治理的记忆资产”

### 14.2 memory 和 rollout / thread / sub-agent 都打通了

因为 memory 直接依赖 rollout 和 sub-agent，这说明 Codex 的 memory 并不是独立外挂，而是和整个工程化基础设施打通的。

这也是它看起来更像“系统”而不是“功能集合”的原因。

---

## 15. 测试体系：Codex 的稳定性来自大量行为级测试，而不是只测 util

从 `core/src/` 下的测试文件规模就能看出，Codex 的测试重点不是只放在小函数上，而是覆盖：

- client continuation
- compact / compact_remote
- context_manager history normalization
- agent control
- thread manager
- rollout reconstruction
- tool runtime
- guardian review
- realtime context

这说明它的测试策略是：

- 协议行为测试
- 状态机测试
- 恢复/压缩路径测试
- 多线程/多回合测试

而不只是：

- 某个 parser 返回是否正确

对于 agent 系统来说，这种测试结构非常重要，因为真正容易坏的地方本来就不在单个纯函数，而在：

- 多轮历史是否还成立
- continuation 是否还能复用
- compaction 后上下文是否失真
- fork/resume/rollback 是否还能恢复

Codex 在这方面非常工程化。

---

## 16. 为什么这些机制会汇聚成“强工程化能力”

把前面的源码事实汇总起来，Codex 的工程化能力可以归结成 5 个底层原则。

### 16.1 一切围绕“可持续会话”而设计

Codex 的中心不是一次回答，而是：

- session 持续存在
- thread 可演进
- turn 可恢复
- history 可重写
- context 可重建

这让它天然适合：

- 长任务
- 多轮追问
- 编码改造
- 复杂审批
- 子 agent 协作

### 16.2 历史真值是结构化对象，不是显示文本

这使得 Codex 能同时做到：

- continuation
- compaction
- rollback
- guardian delta review
- fork with filtering

如果历史只是文本，这些能力几乎都会变脆。

### 16.3 工具不只是“可调用”，而是“被治理”

Codex 的工具系统具备：

- schema
- handler
- orchestrator
- sandbox
- approval
- structured output

所以它不是“模型能不能调工具”，而是“系统是否有能力长期承载工具执行”。

### 16.4 安全与恢复不是附加功能，而是第一层约束

从 guardian、network approval、ghost snapshot、rollout reconstruction、undo 可以看出：

- Codex 假设 agent 会出错、会中断、会被拒绝、会需要恢复
- 所以这些路径从一开始就进了主设计

这正是成熟系统和 demo agent 的分水岭。

### 16.5 上下文不是固定 prompt，而是可演化状态

通过 `reference_context_item`、initial context、settings diff、compaction reinjection，Codex 把上下文做成了状态机。

这让它既能节省 token，又能保持长期一致性。

---

## 17. 对 `mycli` 的直接启发

### 17.1 `mycli` 已经在正确方向上，但历史层还不够“原生”

`mycli` 当前已经有：

- `AgentRuntime`
- turn context assembler
- runtime policy
- responses continuation
- tool exposure
- planning
- approval

但跟 Codex 相比，当前最大差异仍然是：

**`mycli` 的运行时真值更偏向“conversation 文本 + turn items + session 辅助状态”，而 Codex 的运行时真值已经是“原生 ResponseItem history + reference context + rollout”。**

这会影响：

- continuation 的稳定性
- compaction 的上限
- fork / replay / undo / resume 的演进空间
- 多 agent 的父子上下文继承

### 17.2 `mycli` 下一步最值得追赶的不是更多功能，而是更强历史层

如果只选一个最关键方向，我的判断仍然是：

**优先升级 `mycli` 的 session/history architecture。**

要追赶的不是“看起来像 Codex 的更多 feature”，而是：

1. 把会话历史从文本 conversation 提升到更原生的 item history
2. 显式维护 turn baseline / context baseline
3. 为 compaction、resume、fork、rollback 预留结构
4. 让 tool call / tool result 成为会话真值的一部分，而不是摘要副本

### 17.3 `mycli` 应避免只学表面机制

需要避免的误区有 3 个：

1. **只学 `previous_response_id`**
   - 这只是 client 端优化，不是历史层设计本身

2. **只学 prompt 写法**
   - Codex 强的不是 prompt 文案，而是 prompt 背后的上下文装配系统

3. **只学 tool 数量**
   - Codex 强的不是“工具多”，而是工具被统一编排和治理

---

## 18. 建议 `mycli` 后续按什么顺序追赶

建议顺序如下。

### 第一优先级：历史与 turn/session 架构升级

目标：

- 从“最近一轮 + conversation 文件”走向“多 turn 历史 + item history 真值”
- 为 future compaction / replay / fork / resume 打底

### 第二优先级：context baseline 机制

目标：

- 引入类似 `reference_context_item` 的概念
- 避免每轮整包重建 developer/contextual user scaffolding

### 第三优先级：tool history 原生化

目标：

- tool call / tool result 从摘要消息升级为统一 runtime item / prompt item
- 让 continuation、审计、恢复、回放都围绕同一真值工作

### 第四优先级：compaction 设计

目标：

- 不只是写 session summary
- 而是明确“历史替换”与“上下文再注入”的语义

### 第五优先级：rollout / reconstruction

目标：

- 让 `mycli` 具备真正的“中断后恢复”和“回放重建”能力

### 第六优先级：安全编排器

目标：

- 把 approval / sandbox / network policy 串成统一 tool orchestrator

---

## 19. 最终结论

Codex 的工程化能力，不是某个单点“特别高级”，而是它把 agent 运行系统真正做成了一个**有状态、可恢复、可治理、可压缩、可审计、可多线程扩展**的系统。

最核心的源码事实可以压缩成下面这句话：

**Codex 不是“围绕 prompt 组织功能”，而是“围绕会话状态组织 prompt、工具、安全和恢复”。**

这就是它能持续承载复杂工作的真正原因。

对于 `mycli` 而言，最重要的不是再证明“我们也能做一次 continuation”，而是继续把这条路走到底：

- 让历史成为真值
- 让上下文成为状态
- 让工具成为平台
- 让安全成为主链
- 让 rollout 成为恢复基础设施

如果这几步继续做下去，`mycli` 才有可能从一个已经出现雏形的个人 agent runtime，真正演进成接近 Codex 级别的通用个人助手系统。

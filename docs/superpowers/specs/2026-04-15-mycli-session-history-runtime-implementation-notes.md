# mycli Session History Runtime 实现说明

**日期：** 2026-04-15

**关联 OpenSpec Change：** `productize-session-history-runtime`

## 1. 当前已经落地的能力

`mycli` 现在已经不再只依赖 legacy conversation transcript 作为唯一运行时真值，而是新增了一条结构化会话主链：

- `HistoryItem`
- `ContextBaseline`
- `TurnRollout`
- `SessionRuntimeSnapshot`

对应代码位置：

- `src/mycli/domain/runtime/session_history.py`
- `src/mycli/services/session_service.py`
- `src/mycli/application/runtime/agent_runtime.py`

## 2. 结构化会话主链现在如何工作

### 2.1 History

每轮 turn 完成时，`AgentRuntime` 会把本轮 `TurnItem` 映射为结构化 `HistoryItem`，并持久化到 session sidecar。

当前已经覆盖的核心类型包括：

- `user_message`
- `assistant_message`
- `reasoning`
- `tool_call`
- `tool_result`
- `approval_request`
- `approval_resolution`
- `warning`
- `context_baseline_update`
- `file_change`

其中 tool result 会额外带上：

- `raw_payload`
- `transcript_content`
- `file_changes`

这让后续的恢复、兼容导出和上下文重建不再只能依赖 activity 文案。

### 2.2 Context Baseline

`InstructionContract` 中稳定、可跨 turn 复用的 developer/contextual 片段会被提炼成 `ContextBaseline`，并持久化到 session sidecar。

当前已经纳入 baseline 的内容包括：

- runtime policy developer fragments
- tool exposure developer fragments
- 非对话型、非 memory 型、非 user-request 型的 contextual fragments

当前明确排除在 baseline 外的内容包括：

- conversation context
- memory
- current plan
- current user request

### 2.3 Rollout

每轮 turn 完成时会额外持久化一份 `TurnRollout`，记录：

- turn id
- status
- stop reason
- per-turn events
- continuation snapshot

当前 rollout 的事件粒度仍偏简化，主要是按 `turn_item` 事件收口，但已经足够支撑 continuation fallback 和等待审批恢复。

## 3. 新主链已经被哪些路径消费

### 3.1 `AgentRuntime._build_context()`

runtime 构建 `ExecutionContext` 时，现在会先尝试加载 `SessionRuntimeSnapshot`，把以下 durable state 注入执行上下文：

- `history_items`
- `context_baseline`

如果 legacy conversation 为空，`ContextManager` 会从 `history_items` 重建 message 视图。

### 3.2 `TurnContextAssembler`

turn context 现在已经具备 history/baseline-aware 行为：

- 当 legacy conversation 稀疏时，conversation section 会从 `history_items` 回填
- workspace instructions 可从 `context_baseline` 回填
- environment context 会合并 baseline 片段和 runtime 环境事实

这意味着模型输入主链已经开始真正消费结构化状态，而不是只消费旧 transcript。

### 3.3 continuation recovery

`responses-state` sidecar 缺失时，`SessionService` 会从最新 rollout 的 durable continuation snapshot 恢复 `ResponsesContinuationState`。

这解决了“continuation 只能靠单一 sidecar 文件恢复”的问题。

### 3.4 suspended turn reconstruction

`suspended.json` 丢失时，只要下面这些 durable state 还在：

- pending decision
- waiting-approval turn record / rollout
- history
- persisted plan state

`SessionService.reconstruct_suspended_turn()` 就可以重建一个可恢复的 `SuspendedTurn`，并让 `AgentRuntime.resolve_pending_approval()` 继续完成批准后的执行。

## 4. legacy transcript 现在是什么角色

legacy conversation 现在已经降级为兼容导出视图，而不是唯一真值：

- `load_conversation()` 在 transcript 缺失时会从 history 重建基础 message 视图
- `sync_conversation_view_from_history()` 会从结构化 history 反向刷新 transcript 文件

这意味着 transcript 仍然对旧 CLI/旧调试路径友好，但它已经不再是会话恢复的唯一来源。

## 5. 还没有完全收口的地方

### 5.1 Responses 适配层还没有显式 history-aware object

当前 `ResponsesModelAdapter` 仍然主要产出 `RuntimeBlock` / `RuntimeItem`，然后由 `AgentRuntime` 在 turn 收口阶段映射到 `HistoryItem`。

这已经能工作，但还不是最理想的终态。后续可以考虑：

- 明确 provider output -> runtime item -> history item 的三段映射
- 让 history-aware metadata 在 adapter 层更显式可见

### 5.2 reconstruction 还偏向“等待审批恢复”

当前重建链最完整的路径是：

- continuation recovery
- waiting approval turn reconstruction

但还没有做到完整的：

- replay
- thread-level active state rebuild
- compaction 后的完整执行恢复

## 6. 已完成的 smoke 验证

### 6.1 real provider smoke

已实际运行一轮真实 `responses` 协议 smoke，请求内容是：

- “请简短总结当前工作区的结构和主要模块”

运行结果表明：

- 真实 provider 已成功走通多步 tool loop
- session sidecar 成功生成：
  - `<session>.json`
  - `<session>-history.json`
  - `<session>-baseline.json`
  - `<session>-rollouts.json`
  - `<session>-turn.json`
  - `<session>-responses-state.json`

其中 `history.json`、`baseline.json`、`rollouts.json` 和 `responses-state.json` 都具备有效内容，说明新的 durable state 主链已经在真实 provider 场景中落盘。

### 6.2 resume smoke

已运行一轮脚本级 resume smoke，验证路径为：

1. 创建需要审批的 pending action
2. 删除 `suspended.json`
3. 调用 `resolve_pending_approval("1")`
4. 依赖 runtime snapshot / history / rollout 重建 suspended turn
5. 成功继续完成批准后的执行

该 smoke 证明当前的 reconstruction/resume 主链已经不再依赖单一的 `suspended.json` sidecar 文件。

## 7. 当前建议的后续顺序

建议继续按下面顺序推进：

1. 进一步收紧 Responses adapter 与 history item 的显式边界
2. 再看是否要继续扩展到：
   - compaction 后 reconstruction
   - multi-thread / sub-agent snapshot
   - security / approval orchestrator 的更完整持久化

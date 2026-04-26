# mycli 对标 Codex 的 turn 生命周期改造计划

## 背景

当前 `mycli` 的 turn 执行主链仍以 `max_steps` 为中心：

- `AgentRuntime.handle_user_turn()` 会先计算 `max_turn_steps`
- 然后执行 `for step_index in range(max_turn_steps)`
- 如果没有在预算内完成，就以 `MAX_STEPS_REACHED` 结束

这套机制在早期便于兜底，但和 Codex 的真实运行方式存在明显差异。

根据 `Codex` 源码：

- `codex-rs/core/src/client.rs`
- `codex-rs/core/src/codex/session.rs`
- `codex-rs/core/src/codex/turn.rs`

Codex 并不是围绕一个显式的“每个 turn 最多 N 步”来调度，而是围绕以下机制组织 turn：

- `Session` 持有会话级稳定状态
- `ModelClientSession` 是 turn 级对象
- 一个 turn 内允许发起多次 Responses 请求
- 同 turn 内复用 websocket 连接、`turn_state` 与 `previous_response_id`
- 主要预算控制点是 transport retry/fallback，而不是 agent 推理步数
- 失败边界更接近 `contextWindowExceeded`、stream disconnect、retry exhausted、approval wait、interrupt

换句话说，Codex 更像：

- 软预算
- 强状态
- 强恢复
- 强 continuation

而 `mycli` 现在更像：

- 硬步数上限
- 单 turn prompt loop
- 超预算直接停机

本计划的目标，就是把 `mycli` 从“固定步数 prompt loop”改造成更接近 Codex 的“turn 生命周期运行时”。

## 目标

- 将 `max_steps` 从主停止条件降级为软预算或兼容配置
- 让 turn 的停止条件以完成态、错误态、审批态、取消态、上下文/重试边界为主
- 建立 turn 级执行对象，而不是只在 `AgentRuntime` 中维护一个裸循环
- 让同 turn 的 continuation、tool call、fallback transport 进入统一状态机
- 为后续 resume、interrupt、turn steering、多轮日常助手任务打基础

## 非目标

- 本轮不复制 Codex 的全部 websocket 细节
- 本轮不一次性重做全部 tool router、session history、compaction
- 本轮不要求引入多线程 thread tree 或 guardian review
- 本轮不把 UI/TUI 层事件体系一并重写

## 现状问题

### 1. `max_steps` 是错误层级的主刹车

当前 `mycli` 把“agent 是否该停下”主要建模成“是否用完 step budget”。这会导致：

- 任务明明还在正常推进，但因为还没来得及收口而被强行截断
- 是否停机取决于 prompt loop 细节，而不是运行时事实
- 同一个任务在不同模型上会表现得非常不稳定

### 2. turn 内 continuation 还不是第一公民

虽然 `mycli` 已经支持 Responses continuation state，但它仍是嵌在现有 loop 里的局部能力，而不是 turn 生命周期的中心。

结果是：

- continuation 能用，但不能决定 turn 的整体推进方式
- transport fallback、response retry、turn completion 之间仍然偏松散

### 3. “失败”与“没做完”没有被严格区分

当前 `MAX_STEPS_REACHED` 其实经常表达的是：

- 还没做完
- 还没收口
- 还在探索

但这三者都不是运行时错误。

Codex 的状态建模更明确：

- `completed`
- `failed`
- `interrupted`
- `inProgress`

错误原因单独挂在 error/notification 上，而不是拿“步数耗尽”充当统一失败理由。

## 对标 Codex 的关键设计

### 1. 引入 turn-scoped executor

新增一个 turn 级执行对象，建议命名：

- `TurnExecutor`
- 或 `ResponsesTurnExecutor`

职责：

- 持有当前 turn 的 continuation state
- 持有当前 turn 的 tool runtime 状态
- 驱动本 turn 内多次模型请求
- 管理 retry / fallback / completion
- 对外产出 `TurnRecord`

这样 `AgentRuntime` 不再直接承担“步进器”角色，而改为：

- 创建 turn executor
- 注入 session/config/services
- 收集结果

### 2. 停止条件改为显式终止态

建议把终止条件调整为：

- `assistant_completed`
- `approval_required`
- `interrupted`
- `loop_detected`
- `context_window_exceeded`
- `retry_exhausted`
- `transport_failed`
- `runtime_error`
- `model_error`

其中：

- `max_steps_reached` 可以保留为兼容 stop reason
- 但只应作为“软预算保护阀”，不再是默认主路径

### 3. 将 retry budget 从 agent loop 转移到 transport / continuation 层

参考 Codex：

- stream 有 provider 级 retry budget
- retry 耗尽后可以切换 transport fallback
- fallback 激活后，后续请求继续走 HTTP

`mycli` 可以对标为：

- `ResponsesTurnExecutor` 维护 `stream_retry_count`
- provider capability/profile 提供 `stream_max_retries`
- 当 SSE / stream 中断时优先重连，而不是先扣 agent step
- retry 耗尽后切到 full create / HTTP fallback
- fallback 后继续当前 turn，而不是直接结束 turn

### 4. 将 soft budget 变成“提醒”和“策略信号”

保留 `RuntimePolicy.step_budget()`，但语义改为：

- exploration reminder
- reasoning effort 调节信号
- loop suspicion 信号

而不是：

- 一旦达到就直接 stop turn

建议：

- `step_budget` 改名为 `soft_budget`
- `step_index >= budget - 1` 时只追加 reminder
- 真正 stop 必须结合重复路径、重复失败、无新增证据等事实

### 5. 在 turn 内显式支持“多次模型请求”

Codex 的 turn 不是“一次 prompt -> 一次模型输出 -> 结束”。

`mycli` 也应转为：

- turn start
- build context
- model request
- tool call / tool result
- continuation request
- final answer
- turn complete

这里的关键不是“循环次数无限”，而是 turn 是一个状态机。

## 建议的状态机

```text
initialized
  -> requesting_model
  -> streaming_response
  -> executing_tool
  -> awaiting_approval
  -> retrying_transport
  -> fallback_transport
  -> completed
  -> interrupted
  -> failed
```

补充终止事件：

- `assistant_message_finalized`
- `approval_requested`
- `approval_denied`
- `stream_disconnected`
- `retry_budget_exhausted`
- `context_window_exceeded`
- `user_interrupt`
- `loop_detector_triggered`

## 分阶段实施

### Phase 1: 抽离 turn executor

目标：

- 把 `AgentRuntime` 里的大循环移动到独立对象
- 保持现有行为基本不变

交付：

- `TurnExecutor` 或 `ResponsesTurnExecutor`
- `AgentRuntime` 只负责准备上下文和收尾持久化
- 当前测试全部迁移通过

### Phase 2: 去硬性 `max_steps` 主路径

目标：

- 将 `MAX_STEPS_REACHED` 从默认兜底改为兼容保护阀

交付：

- 默认不再因为普通 step 用尽就立即终止
- 由 loop detector 和 retry/context boundary 主导 stop reason
- 新增 `retry_exhausted`、`context_window_exceeded` 之类 stop reason

### Phase 3: turn 内 retry / fallback 正式化

目标：

- 把 stream retry、full create fallback、continuation retry 串成正式状态机

交付：

- provider profile 暴露 retry/fallback 能力
- turn 内可以在 transport 失败后继续推进
- sidecar / trace 能看出 retry 和 fallback 轨迹

### Phase 4: completion / interrupt / steer 准备

目标：

- 为后续更强的通用助手场景打底

交付：

- turn interruption hooks
- session active turn state
- 明确区分 `failed` 和 `interrupted`
- 为未来 turn steering / user follow-up 注入预留接口

## 需要同步修改的模块

- `src/mycli/application/runtime/agent_runtime.py`
- `src/mycli/services/runtime_policy.py`
- `src/mycli/infrastructure/models/responses_adapter.py`
- `src/mycli/infrastructure/openai_responses_client.py`
- `src/mycli/services/session_service.py`
- `src/mycli/domain/runtime/*`
- `tests/unit/application/test_agent_runtime.py`
- `tests/unit/services/test_runtime_policy.py`
- `tests/unit/infrastructure/models/test_responses_adapter.py`
- `tests/unit/infrastructure/test_openai_responses_client.py`

## 验证标准

改造完成后，至少要满足：

- 普通多轮任务不会因为固定 4 步预算被截断
- SSE 中断时优先 retry/fallback，而不是直接结束 turn
- stop reason 能明确表达：
  - 完成
  - 中断
  - 错误
  - loop
  - retry exhausted
  - context exceeded
- `evaluation` 中的复杂场景，失败原因不再主要是 `max_steps_reached`

## 执行顺序建议

1. 先抽离 turn executor，不改行为
2. 再重构 stop reason 和 soft budget
3. 然后补 retry/fallback 生命周期
4. 最后再调 eval 和 prompt 细节

这个顺序的好处是：

- 风险可控
- 回归面清晰
- 每一步都能单独验证

## 结论

如果 `mycli` 真要对标 Codex，这里最不该继续强化的就是“固定步数上限”。

真正应该产品化的是：

- turn-scoped execution
- continuation-first runtime
- retry/fallback lifecycle
- completion / failure / interrupt 的明确边界

这会比单纯把 `max_steps` 从 4 调到 8 更接近 Codex，也更适合通用型个人助手 agent 的长期演进。

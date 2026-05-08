# TurnGuard Checkpoint: Agent Loop 停止决策层设计

> 参考 Claude Code（10 exit reason + 9 continue reason）和 OpenAI Codex（3 层 guardrails + max_turns/max_seconds）的 agent loop 设计。

## 1. 问题

mycli agent 在 `react_loop.py`、`turn_executor.py`、`turn_service.py` 三处各有一个 `while True` 循环，**全部没有硬步数上限**。现有的 `RuntimePolicy` 只检测"同一工具反复调用 >= 4 次"这一种循环模式，模型切换不同工具持续探索时完全不触发。结果：单次交互可消耗 80w token。

## 2. 设计原则

- **循环本身保持极薄**。停止逻辑集中在独立的 Checkpoint 层，不在循环中散落 if。
- **穷举式退出条件**。每种停止原因独立判断，互不耦合。参考 Claude Code 的 10 个 exit reason。
- **控制流与 prompt 分离**。所有 Exit/Continue 决策不改变 prompt 结构，只有 ContinueReason 附带的 reminders 进入 prompt——走现有的 `runtime_reminders` 通道。
- **模型无关**。不依赖特定 provider 的 stop_reason 或 API 特性。
- **不影响缓存**。不改变 system prompt 前缀、tool definitions 顺序、request shape 构建逻辑。

## 3. 架构：三层分离

将当前 `RuntimePolicy.evaluate()` 的混合职责拆为三个独立步骤：

```
Step 1. Checkpoint.evaluate(state) → CheckpointResult
        穷举判断所有退出/继续条件，返回 ExitReason | ContinueReason + reminders

Step 2. Profile.infer(user_message) → DecisionProfile  
        根据用户意图推断 reasoning_effort, path_bias, planning_mode
        （现有 RuntimePolicyProfiler 逻辑，基本不动）

Step 3. Reminders.assemble(profile, checkpoint) → tuple[str, ...]
        根据 profile + checkpoint 的 continue_reason 组装最终 reminders
```

**Checkpoint 是新增的核心**。Profile 和 Reminders 是对现有逻辑的重新组织。

## 4. Checkpoint 退出原因（ExitReason）

优先级从高到低：

| Priority | ExitReason | 触发条件 | 行为 |
|----------|-----------|----------|------|
| 1 | `TOKEN_BUDGET_EXCEEDED` | `cumulative_tokens > max_tokens_per_turn`（已给过 FORCE_ANSWER 机会） | 立即停止 |
| 2 | `TOOL_COUNT_EXCEEDED` | `step_index > max_tool_calls_per_turn`（已给过 FORCE_ANSWER 机会） | 立即停止 |
| 3 | `LOOP_DETECTED` | 同一 (tool_name, args_hash) 连续调用 >= max_same_tool_calls | 停止 |
| 4 | `REPEATED_REPLANNING` | update_plan 调用 >= 2 次且有计划但不执行 | 停止 |
| 5 | `NO_PROGRESS` | 连续 no_progress_threshold 步工具结果无新增信息 | 停止 |

注意：TOKEN_BUDGET 和 TOOL_COUNT 在**达到阈值时不硬停**，而是先触发一次 FORCE_ANSWER 最后机会。只有在模型无视这个机会、继续调用工具后才硬停。

## 5. Checkpoint 继续原因（ContinueReason）

当没有 ExitReason 触发时，返回以下之一：

| ContinueReason | 触发条件 | 附带行为 |
|---------------|----------|---------|
| `FORCE_ANSWER` | 证据充足 OR `step_index >= force_answer_threshold` | reminders 注入"你必须现在基于已有证据回答" |
| `REROUTE` | `step_index >= reroute_threshold` 且有重复探索迹象 | reminders 注入"换一个不同的路径" |
| `TRUNCATION_AWARE` | 最近工具结果有文件截断信号 | reminders 注入"使用 read_file_range" |
| `NEXT_STEP` | 正常继续 | 无额外 reminders |

## 6. 配置（AgentConfig 新增字段）

```python
max_tool_calls_per_turn: int = 25        # 工具调用轮次硬上限
max_tokens_per_turn: int = 200_000       # 累计 token 硬上限
max_same_tool_calls: int = 4             # 同一工具+参数连续调用上限
no_progress_threshold: int = 6           # 连续无新增信息步数上限
force_answer_threshold: int = 12         # 超此步数注入 FORCE_ANSWER
reroute_threshold: int = 3               # 重复探索此步数后注入 REROUTE 提醒
```

## 7. 三条循环路径统一接入

```
react_loop.py run():           while True → checkpoint = _checkpoint.evaluate(...)
turn_service.py _run_agent():  while True → checkpoint = _checkpoint.evaluate(...)
turn_executor.py _run_turn_loop():  while True → checkpoint = _runtime._checkpoint.evaluate(...)
```

所有路径共用同一个 `TurnCheckpoint` 实例。`react_loop.py` 和 `turn_service.py` 需要新增 `step_index` 计数器（目前没有）。

## 8. 缓存安全性保证

| 机制 | 是否改变 prompt 内容 | 影响 |
|------|---------------------|------|
| ExitReason 判断 | 否（纯控制流） | 零 |
| ContinueReason 判断 | 否（纯控制流） | 零 |
| FORCE_ANSWER/REROUTE reminders | 是——追加到 runtime_reminders | 走现有通道，不在缓存前缀范围 |
| TOOL_COUNT_EXCEEDED 等 | 否 | 零 |

关键规则：**所有新增的动态文本只通过 `runtime_reminders` 注入 prompt**，而 `runtime_reminders` 已经在 `turn_context` 的动态部分，不是缓存前缀。不新增 system prompt 段落，不改变 tool definitions 顺序。

## 9. 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `src/mycli/services/turn_guard/__init__.py` | 包初始化 |
| 新增 | `src/mycli/services/turn_guard/checkpoint.py` | TurnCheckpoint 类 + ExitReason + ContinueReason |
| 新增 | `src/mycli/services/turn_guard/reminders.py` | Reminders 组装逻辑 |
| 新增 | `tests/services/turn_guard/test_checkpoint.py` | Checkpoint 单元测试 |
| 修改 | `src/mycli/domain/runtime/__init__.py` | AgentConfig 新增字段 |
| 修改 | `src/mycli/services/runtime_policy/policy.py` | 调用 Checkpoint，去除重复逻辑 |
| 修改 | `src/mycli/application/runtime/turn_executor.py` | _run_turn_loop 接入 Checkpoint |
| 修改 | `src/mycli/application/runtime/agent_runtime.py` | 初始化 TurnCheckpoint |
| 修改 | `src/mycli/agents/react_loop.py` | run() 接入 Checkpoint + step_index |
| 修改 | `src/mycli/application/turn_service.py` | _run_agent() 接入 Checkpoint + step_index |

## 10. 不在范围内的

- 不统一三条循环路径（那是后续重构的事）
- 不改动 `Profile.infer()` 的逻辑（当前 RuntimePolicyProfiler 够用）
- 不碰 request_shape / runtime_items / legacy_messages 的构建
- 不碰 model adapter 层
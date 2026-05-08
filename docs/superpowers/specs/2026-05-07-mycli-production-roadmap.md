# mycli → 生产级 Agent 改造清单

> 对标 Claude Code / Codex，基于 2026-05-07 全项目扫描。
> 优先级：P0 = 阻塞可靠性 → P1 = 架构基础 → P2 = 用户体验 → P3 = 差异化能力

---

## P0：修正在跑但做错了的（5 项）

这些不改，其他都是建在沙子上。

### P0-1 修死区内存泄漏

**文件**：`src/mycli/services/context/compaction/cache_zones.py:26-37`

**问题**：compaction 只操作 `[fresh_start, end)`——最后一条 user 消息之后。中间全部对话轮次（可能几十轮、几百个 tool_result）从来不碰。

**改造**：
- 重写 `_find_frozen_boundary`：边界 = 按 `cache_policy` 排序后的第一条 DYNAMIC fragment，而非"第一条 user 消息"
- `_find_fresh_start`：不应是"最后一条 user 消息"，而应是 Frozen Zone 之后的第一条未被 compact 的消息
- 每次 compaction 对所有 Fresh Zone 内容生效，不只是最新 turn

### P0-2 消除双代码路径

**文件**：`src/mycli/application/turn_service.py:338`、`src/mycli/agents/react_loop.py`

**问题**：`_runtime is not None` 走 TurnExecutor（有 compaction），否则走 ReactAgent（无 compaction）。测试和部分入口点悄无声息地降级。

**改造**：
- 删除 `ReactAgent.run()` 和 `TurnService._run_agent()` 中的旧路径
- 所有用户 turn 统一走 `TurnExecutor`
- 保留 `ReactAgent` 仅作为兼容性包装器，内部转发到 `TurnExecutor`

### P0-3 实现 ToolResultBudget

**文件**：`src/mycli/services/context/compaction/pipeline.py:23-37`

**问题**：`ToolResultBudget.apply()` 是空函数。L1 截断现在只在 `ToolResultFormatter.format()`（render 时）运行，不在存储/compaction 阶段运行。

**改造**：
- 在 `apply()` 中调用 `ToolResultFormatter` 对 Fresh Zone 中的 TOOL_RESULT 消息做预算感知截断
- 截断在写入 conversation 时就完成，不在 render 时重复
- 处理后的 fragment 标记 `cache_frozen=True`

### P0-4 替换 Token 估算

**文件**：`src/mycli/services/context/window_service.py:15-16`、`src/mycli/services/context/compaction/budget.py`

**问题**：`len(text)//4` 对中文、代码、JSON 偏差 2-3 倍。

**改造**：
- 实现 `TokenCounter`（tiktoken `o200k_base` + LRU cache）
- 优先级：provider 返回值 > tiktoken > 字符估算
- `ContextBudget.record()` 使用 API response 真实 usage 校准

### P0-5 LlmSummarization 不再是空操作

**文件**：`src/mycli/services/context/compaction/pipeline.py:134-156`

**问题**：`LLMSummarization.apply()` 是空函数。L4 是最后的防线，目前等于不存在。

**改造**：
- 实现 LLM 摘要调用（使用轻量模型，如 deepseek-lite）
- 结构化 summary prompt：保留决策、文件编辑、错误及解决方案、关键发现
- 断路器：连续 3 次失败停止尝试
- 摘要后追加 continuation message

---

## P1：补齐核心架构（6 项）

### P1-6 实现钩子系统

**优先级说明**：没有钩子，权限定制、自动验证、PreCompact 抢救——所有高级行为的入口都不存在。这是连接一切的基础设施。

**新文件**：`src/mycli/services/hooks/`

**最少实现**：
- `HookManager` 注册/执行生命周期钩子
- 5 个钩子点：`PreToolUse`、`PostToolUse`、`PreCompact`、`SessionStart`、`SessionEnd`
- 钩子配置来源：`.mycli/hooks/` 目录下的 Python 文件
- 返回值语义：`ALLOW` / `DENY` / `MODIFY` / `CONTINUE`

### P1-7 ContextPipeline 完整性——Cache Zone 边界重算

**文件**：`src/mycli/services/context/compaction/cache_zones.py`

**改造**：
- Frozen Zone = 所有 `cache_policy ∈ {STATIC, SEMI_STATIC}` 的 fragment
- Fresh Zone = 第一个 DYNAMIC/EPHEMERAL fragment 之后
- 每次 turn 结束后将新完成的对话轮次标记为 frozen
- 实现 `validate_frozen_zone()` 跨 turn 校验——如果 Frozen Zone 变了，warning + 记录

### P1-8 Token 预算反压

**文件**：`src/mycli/application/runtime/turn_executor.py:251,438-441`

**问题**：预算算出来了但从不告诉模型。

**改造**：
- `budget.usage_ratio >= 0.60` 时注入温和提醒到 `runtime_reminders`
- `>= 0.85` 时注入强烈警告："必须基于已有信息回复"
- 在每个 tool_result 末尾追加 `token_budget_remaining` 提示

### P1-9 错误恢复——实现 Continue 点

**文件**：`src/mycli/application/runtime/turn_executor.py:446-472`、`turn_error_finalizer.py`

**改造**：
- PTL（Prompt Too Long）恢复层：Collapse drain → Reactive Compact → 退出（每层一次）
- OTK（Output Token Limit）恢复层：Escalate 输出预算 → Recovery message（最多 3 次）
- 模型 Fallback：主模型失败 → fallback 模型重试
- 中断处理（Ctrl+C）：追加 interrupt notice，保留已发送的 fragments

### P1-10 并行工具执行

**文件**：`src/mycli/application/runtime/tools/tool_execution_service.py`

**改造**：
- 将 `read_file`、`search_text`、`list_directory` 等读操作标记为并发安全
- 并发安全的工具在单轮内并行执行
- 结果按 `sequence_number` 排序后追加到 conversation

### P1-11 子 Agent 上下文隔离

**新文件**：`src/mycli/agents/sub_agent.py`

**最少实现**：
- `SubAgentContext`：独立 Fragment 列表 + 独立工具集 + 独立缓存前缀
- 父 agent 只接收最终报告 Fragment（子 agent 的 40 次 tool call 不污染父上下文）
- 子 agent 有独立的 `TokenBudget` 和 `TurnGuard`

---

## P2：用户体验（5 项）

### P2-12 文件历史 / 撤销

**新文件**：`src/mycli/services/file_history.py`

**最少实现**：
- `Edit`/`Write` 工具调用前创建文件快照（v1 备份）
- 快照粒度 = 主对话 turn
- 点击 `fileHistoryRewind(messageId)` 恢复到指定 turn 的文件状态
- 备份在 `~/.mycli/file-history/{sessionId}/`

### P2-13 MCP 支持

**新文件**：`src/mycli/services/mcp/`

**已有**：完整设计文档 `docs/superpowers/plans/2026-04-27-mycli-mcp-host.md`

**改造**：
- MCP 客户端实现（连接外部 MCP server）
- MCP 工具注册到 `ToolRegistryV2`
- MCP 资源作为上下文来源
- 按设计文档实现，不重新设计

### P2-14 CLI 流式输出

**文件**：`src/mycli/cli/rendering.py`

**改造**：
- 模型响应流式渲染（不缓冲一次性输出）
- Tool call 进度实时展示（spinner + tool name）
- Diff 展示（`edit_file` 结果用 `rich` 或 `diff` 格式）
- 语法高亮（`pygments`）

### P2-15 会话 Resume / Fork

**文件**：`src/mycli/infrastructure/sqlite_session_store.py`

**改造**：
- `/resume <session-id>` 恢复到指定会话的最后一轮
- `/fork <session-id>` 基于现有会话创建新分支
- Conversation 支持分叉：`parent_id` + `fork_point` 元数据

### P2-16 Plan Mode

**新文件**：`src/mycli/services/planning/plan_mode.py`（扩展已有 `planning_service.py`）

**改造**：
- `EnterPlanMode` / `ExitPlanMode` 作为内置工具（而非单独的运行时模式）
- Plan 状态写入 `docs/tasks/current.md`（checkbox 进度追踪）
- Plan 文件在 crash 恢复时作为独立的上下文锚点

---

## P3：差异化能力（4 项）

### P3-17 记忆系统升级

**文件**：`src/mycli/services/memory/service.py`

**改造**：
- 三层记忆：Transient（单 session）→ Short-term（24h，~100 条）→ Long-term（1 年，~1000 条）
- 语义检索：embedding + 向量搜索替换当前子字符串匹配
- 异步编码：每 turn 结束后后台编码新记忆（不阻塞用户）
- 去重：检索结果与当前对话历史交叉比对

### P3-18 注入防护与脱敏

**新文件**：`src/mycli/services/security/injection_guard.py`

**改造**：
- 所有低信任内容（工具输出、MCP 响应、文件内容）进入上下文前用 XML 标签包裹边界
- PrivacyFilter：API key、token、email 等敏感模式脱敏
- 脱敏在 L1 截断之前运行

### P3-19 对话分叉与分支

**新文件**：`src/mycli/services/conversation_tree.py`

**改造**：
- Conversation 从平面 `list[Message]` 扩展为树结构
- 支持从任意消息节点 rewind 并创建替代分支
- 分支间 diff 对比

### P3-20 成本感知 Compaction

**文件**：`src/mycli/services/context/compaction/pipeline.py`

**改造**：
- L4 触发前计算成本："花 $X 做摘要 vs 花 $Y 带着原文"
- `trigger_ratio` 从静态 0.4/0.7/0.9 改为按模型动态调整
- 成本指标纳入 MetricsCollector

---

## 汇总

| 优先级 | 项数 | 估计工期 | 主要收益 |
|---|---|---|---|
| P0 | 5 | 2-3 周 | 上下文不爆炸、代码路径统一、token 计数准确 |
| P1 | 6 | 4-6 周 | 钩子基础设施、cache zone 正确、错误恢复、并行工具、子 agent |
| P2 | 5 | 3-4 周 | 用户体验飞跃：流式、diff、撤销、plan mode、MCP |
| P3 | 4 | 2-3 周 | 长期记忆、安全、对话分支、成本优化 |

**总计：20 项，估计 11-16 周从当前状态到生产级。**

---

## 依赖关系

```
P0-1 (死区) ──→ P1-7 (Cache Zone 重算)
P0-2 (双路径) ──→ P1-9 (错误恢复) ──→ P1-10 (并行工具)
P0-3 (L1 全实现) ──→ P1-8 (预算反压)
P1-6 (钩子系统) ──→ P2-16 (Plan Mode) + P3-18 (注入防护)
P1-7 (Cache Zone) ──→ P3-20 (成本感知)
P0-4 (Token 计数) ──→ P1-8 (预算反压) + P3-20 (成本感知)
P1-11 (子 Agent) ──→ P2-15 (会话 Fork)
P1-10 (并行工具) ──→ P2-14 (流式 UI)
```

**首要任务：P0 全部 + P1-6（钩子）+ P1-7（Cache Zone 重算）。** 这三项完成后，项目骨架才真正稳固。没有钩子，所有其他 P1/P2 项都是孤立的 feature。没有正确的 Cache Zone，P3 的成本感知没有意义。

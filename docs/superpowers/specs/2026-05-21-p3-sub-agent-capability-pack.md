# P3 Sub-agent Capability Pack

## 1. 背景

P0/P1/P2 已经把单 agent 的上下文稳定性、工具安全、可观测性、流式输出、Bash 后台任务、file history 和基础权限补了一轮。下一块最影响真实 coding-agent 能力的是 sub-agent：主 agent 能把边界清晰的子任务交给 child agent，同时不污染父上下文、不绕过权限、不扩大工具能力、不无限循环。

本批 P3 的定位是：

> Safe synchronous Task sub-agent v1。

也就是说，P3 只做同步、进程内、单 child agent 的 `Task` 工具调用闭环。它不做 Claude Code 完整的 async mailbox、fork cache sharing、后台化、coordinator/team 或 worktree/remote agent。

## 2. 现有骨架处理

当前代码已有 `src/mycli/agents/sub_agent.py`：

- `SubAgent(name, system_prompt, tools, model, budget, max_tool_calls, cache_prefix)`
- `SubAgentReportFragment(Fragment)`
- `_call_model()` / `_execute_tool()` / `_is_final()` 抽象钩子

P3 不继续扩展这个抽象类。原因：

- 它基于旧 Fragment/context 设计，和当前 `AgentRuntime`、`ToolRegistry`、`ApprovalService`、trace、session/history 主链没有接上。
- 它没有 runtime 当前 tool exposure、approval policy、file history、provider usage、streaming 和 session rebind 的上下文。
- 继续复用会产生两条 sub-agent 主链。

P3 明确将旧 `SubAgent` / `SubAgentReportFragment` 标记为 legacy，并在实现阶段删除或迁移测试。新的唯一主链是：

```text
TaskTool -> SubAgentService -> bounded child loop -> scoped ToolRegistry -> final XML report
```

## 3. 目标

### 3.1 Model-facing `Task` tool

新增模型可调用工具 `Task`，用于把明确子任务交给 child agent。

参数：

- `description`: 子任务说明。
- `agent_type`: `explore` / `review` / `executor`。
- `allowed_tools`: 父 agent 愿意给 child 的候选工具名。

行为：

- `Task` 同步运行 child loop。
- `Task` 只返回最终 report。
- 父 session 只写入 `Task` tool_call 和 final tool_result。
- child 的中间 tool calls/tool results 不进入父 conversation。
- `Task` tool_result 是普通 tool_result，可自然进入 history replay、L4 compaction 和 activity rendering。

### 3.2 禁止嵌套 sub-agent

P3 明确禁止 child 再 spawn child：

- `Task` 永远不允许出现在 child tool scope。
- child 工具全局 denylist 包含：
  - `Task`
  - `AskUserQuestion`
  - `enter_plan_mode`
  - `exit_plan_mode`
- nested approval UI 不支持。child 触发 approval-needed 时直接失败并返回 report。

### 3.3 多层工具准入

child tool scope 不是简单交集。P3 使用分层 resolver：

```text
parent exposed tools
  ∩ requested allowed_tools
  ∩ profile default_tools
  - global child denylist
  - profile denylist
  - policy denied tools
  = child tool registry
```

默认 profile：

| profile | 默认工具 | 说明 |
|---|---|---|
| `explore` | `Read`, `Grep`, `Glob`, `LS` | 只读探索 |
| `review` | `Read`, `Grep`, `Glob`, `LS`, `Lint` | 代码审查 |
| `executor` | `Read`, `Grep`, `Glob`, `LS`, `Edit`, `Write` | 小范围执行；`Bash` 默认不开放 |

`Bash` 只在后续 opt-in 设计里给 executor 显式开放。P3 默认不把 Bash 给 child。

MCP/contributed tools 不自动继承。P3 只允许显式白名单透传，且仍要经过 resolver。

### 3.4 Child budget v1

P3 不做 Claude Code 完整 token budget，但不能只靠 `max_tool_calls`。每个 profile 拥有：

- `max_turns`
- `max_tool_calls`
- `no_progress_turn_limit`
- `report_char_limit`
- `model: str | None`
- `max_prompt_tokens: int | None`
- `cache_strategy`

默认值：

```text
max_turns = 8
max_tool_calls = 20
no_progress_turn_limit = 3
report_char_limit = 8000
model = None              # 继承父模型
max_prompt_tokens = None  # 继承父预算策略
cache_strategy = "inherit_provider_config"
```

No-progress 判断：

- 本轮没有 assistant text。
- 本轮没有 tool_call。
- 本轮没有新增 tool_result/evidence。

连续 `no_progress_turn_limit` 轮后停止，返回 `status=max_no_progress`。

### 3.5 Context field policy

P3 不做“全隔离”或“全共享”，而是逐字段策略：

| 字段/服务 | P3 策略 | 原因 |
|---|---|---|
| model config/provider/api key | 继承父 runtime | 保持 provider/cache 行为稳定 |
| model adapter | 复用父 adapter 接口，但 child session id 进入 log/trace context | 避免新增 provider 栈 |
| conversation | 不复制完整父历史 | 防父上下文污染和 token 爆炸 |
| task context | 只传 description、profile prompt、必要 handoff summary | 保持 child 任务窄 |
| tool registry | 子集 registry | 防工具放大 |
| approval UI | 禁用 nested approval | 避免 CLI 交互复杂化 |
| file history | 共享服务，child session id 独立 | child 写入仍可回滚 |
| shell registry | 不默认暴露 Bash | 避免后台进程孤儿和权限放大 |
| trace | parent trace + child trace 均写 | 保持可观测 |
| stream sink/UI | child 不直接写 UI | 父只接收最终 report |
| memory/session state | child session 独立 | 防状态串扰 |

### 3.6 Cache 策略

P3 不做 Gap 7.2 的 fork cache sharing。

明确取舍：

- P3 child 默认继承父 provider/model/config。
- child prompt/tool schema 需要稳定排序。
- child 使用独立 session id 和独立 child loop。
- 不保证父子 API 请求前缀字节级一致。
- 不做 `getSystemPrompt() == ""` 的 fork-agent trick。

后续 P4 可单独做 `fork-agent-cache-sharing`：

- 父子请求前缀字节级一致。
- tool schema 和顺序完全继承父。
- 从 fork point 开始分叉。
- 专门验证 provider prompt cache hit。

### 3.7 Child loop

P3 必须是真实 bounded child loop，不是一轮 model call。

流程：

```text
build child runtime items
  -> request model turn with scoped tools
  -> if final text: return report
  -> if tool_call: execute scoped tool
  -> append tool_result to child conversation
  -> next child turn
  -> stop at max_turns / max_tool_calls / no_progress / provider error
```

Child loop 的 tool execution 复用现有 `ToolExecutionService` 能力，至少要保持：

- tool validation
- safety policy
- file history snapshot
- trace
- context manager tool result formatting

如果 child 遇到 pending approval：

- 不弹 nested approval。
- 返回 `status=approval_required`。
- report 说明哪个工具被拒绝继续执行。

### 3.8 Report 格式

P3 final report 使用稳定 XML 包装，便于模型阅读，也方便后续 async notification 复用：

```xml
<sub-agent-report agent="explore" status="completed" tools="3" child_session_id="demo:sub:turn_1:abcd">
...report body...
</sub-agent-report>
```

约束：

- report body 上限默认 8000 字符。
- 超限截断并在 XML 中追加省略说明。
- XML report 是父 session 唯一接收的 child 内容。

### 3.9 生命周期观测

Sub-agent lifecycle 进入 trace：

- `started`
- `tool_scope_resolved`
- `child_turn_started`
- `tool_started`
- `tool_completed`
- `completed`
- `failed`
- `max_turns`
- `max_tool_calls`
- `max_no_progress`
- `approval_required`

`/subagents` 最小摘要格式：

```text
<agent_type> <status> tools=<tool_calls> <child_session_id> description=<short_description>
```

## 4. 非目标

- 不做 async mailbox。
- 不做 XML `<task-notification>` 注入父对话历史。
- 不做超过 2 分钟自动后台化。
- 不做 coordinator/team 模式。
- 不做并发多 child 调度。
- 不做 worktree agent。
- 不做 remote agent。
- 不做 fork cache sharing。
- 不做 MCP defer loading。
- 不做 Microcompact。
- 不做 nested approval UI。

## 5. 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| 新建 | `src/mycli/domain/subagents.py` | Profile/invocation/result/run summary contracts |
| 新建 | `src/mycli/application/runtime/subagents/profiles.py` | Built-in profile catalog |
| 新建 | `src/mycli/application/runtime/subagents/tool_scope.py` | Layered child tool resolver + denylist |
| 新建 | `src/mycli/application/runtime/subagents/service.py` | SubAgentService orchestration |
| 新建 | `src/mycli/application/runtime/subagents/loop.py` | Bounded child loop |
| 新建 | `src/mycli/tools/task.py` | Model-facing `Task` tool |
| 修改 | `src/mycli/agents/sub_agent.py` | 删除或 legacy 迁移 |
| 修改 | `src/mycli/application/runtime/agent_runtime.py` | 创建并绑定 SubAgentService/TaskTool |
| 修改 | `src/mycli/tools/registry.py` | 注册 fallback `Task` |
| 修改 | `src/mycli/cli/bootstrap.py` | runtime-bound TaskTool |
| 修改 | `src/mycli/application/turn_service.py` | `/subagents` inspection |
| 修改 | `src/mycli/cli/repl.py` | `/subagents` command |
| 测试 | `tests/unit/domain/test_subagents.py` | Domain contracts |
| 测试 | `tests/unit/application/runtime/subagents/test_tool_scope.py` | Resolver |
| 测试 | `tests/unit/application/runtime/subagents/test_child_loop.py` | Child loop |
| 测试 | `tests/unit/application/runtime/subagents/test_sub_agent_service.py` | Service |
| 测试 | `tests/unit/tools/test_task_tool.py` | Task tool |
| 测试 | `tests/unit/application/test_agent_runtime.py` | Runtime integration |
| 报告 | `docs/superpowers/reports/2026-05-21-p3-sub-agent-capability-pack-smoke.md` | Smoke evidence |

## 6. 验收标准

- `Task` tool 出现在默认 tool registry。
- child 不能使用 `Task`、`AskUserQuestion`、plan mode tools。
- child tool scope 是 parent exposure / requested / profile / denylist / policy 的结果。
- child loop 能执行至少一轮 tool_call -> tool_result -> next model turn。
- child 达到 max_turns/max_tool_calls/no_progress 时返回明确状态。
- child report 是 XML，且默认不超过 8000 字符。
- 父 session 只收到最终 `Task` report，不包含 child 内部 tool_result。
- child lifecycle 写入 trace。
- `/subagents` 能看到最近 child runs。
- 旧 `src/mycli/agents/sub_agent.py` 不再作为并行主链残留。
- `uv run ruff check src tests`、`uv run mypy src/mycli`、`uv run pytest -q` 通过。
- 真实 CLI smoke 能完成一次 `Task(explore)` 风格子任务并返回 report。

## 7. 与 Claude Code 的差距

P3 完成：

- sync in-process sub-agent。
- no nested sub-agent。
- layered tool scope。
- bounded child loop。
- parent/child context isolation。
- XML final report。
- lifecycle trace。

P3 不完成：

- async mailbox + `<task-notification>`。
- 2 分钟自动后台化。
- coordinator/team 并发 worker。
- fork cache sharing。
- worktree/remote agent。

对应 gap 文档：

- 7.1：从无变为 ⚠️，只覆盖 sync in-process。
- 7.2：仍 ❌，fork cache sharing 后续单独做。
- 7.3：从 ❌ 到 ⚠️，有工具/权限隔离但无 OS sandbox。
- 7.4：从 ⚠️ 到 ✅，工具子集隔离落地。
- 7.5：从 ⚠️ 到 ✅，父只接收 final report。
- 7.6/7.7：仍 ❌。

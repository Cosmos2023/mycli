# P3 Sub-agent Capability Pack

## 1. 背景

P0/P1/P2 已经把单 agent 的上下文稳定性、工具安全、可观测性、流式输出、Bash 后台任务、file history 和基础权限补了一轮。下一块最影响真实 coding-agent 能力的是 sub-agent：让主 agent 能把一个边界清晰的子任务交给隔离的 child agent，同时不污染父上下文、不绕过权限、不扩大工具能力。

当前代码已有 `src/mycli/agents/sub_agent.py` 骨架：

- `SubAgent` 有独立 `system_prompt`、`tools`、`budget`、`cache_prefix` 和最终 `SubAgentReportFragment`。
- 但它还是抽象类，未接入 `AgentRuntime`、`ToolRegistry`、`ApprovalService`、trace、session/history 或 CLI。
- 父 agent 目前不能通过稳定工具调用来 spawn child agent。

本批 P3 目标是把 sub-agent 从“孤立骨架”变成“可被 runtime 安全调用的一等能力”。

## 2. 目标

### 2.1 Model-facing `Task` tool

新增一个模型可调用工具 `Task`，用于把明确子任务交给 sub-agent：

- 参数至少包括 `description`、`agent_type`、`allowed_tools`。
- `Task` 只返回最终 report，不把 child 的完整内部对话塞回父上下文。
- `Task` 的 tool_result 是普通 tool_result，因此可被 L4 压缩、history replay 和 activity 渲染自然处理。

`Task` 不是 team/swarm，也不是后台长期任务。P3 第一版是同步、in-process、单 child agent 一次性执行。

### 2.2 权限不可放大

child agent 的能力必须是父 turn 当前能力的子集：

- child 只能使用父 agent 当前暴露给模型的工具子集。
- child 请求的 `allowed_tools` 必须再经过 runtime policy 过滤。
- high-risk 工具默认不可给 child，除非父侧明确允许且 policy 判定不 deny。
- session allowlist 不得让 child 绕过 deny。
- contributed tools/MCP tools 在 P3 只允许显式白名单透传，不做自动全量继承。

### 2.3 Context handoff

父 agent 给 child 的上下文必须是窄而稳定的 handoff，不直接复制完整父上下文：

- task description
- parent session id / turn id
- compacted relevant context summary
- current plan state摘要
- optional file/context hints
- available tool catalog for child

child 完成后，父上下文只接收：

- child final report
- tool usage count
- status: completed / failed / max_tool_calls
- child trace id/session id

### 2.4 生命周期观测

sub-agent 必须进入现有 observability/trace surface：

- spawn started
- tool scope resolved
- child turn started/completed
- child failed/max_tool_calls
- report returned

CLI 不做复杂 TUI，只要求 activity/trace 可见。后续再做 `/subagents` richer UI。

### 2.5 Session/history 隔离

child agent 使用独立 thread/session id，例如：

```text
<parent-session>:sub:<parent-turn-id>:<short-id>
```

隔离规则：

- child transcript 写入 child session。
- parent session 只写入 `Task` tool_call 和最终 tool_result。
- child file mutations 仍走同一 file history/safety pipeline，不能绕过 workspace boundary。
- child report 可作为 parent 的普通 tool_result 参与 compaction。

## 3. 非目标

- 不做 team/swarm 协作。
- 不做并行多 child 调度。
- 不做 worktree agent。
- 不做 remote agent。
- 不做 long-running child resume。
- 不做 child agent PTY。
- 不做 MCP defer loading。
- 不做 Microcompact。

## 4. 设计

### 4.1 Sub-agent contract

新增 sub-agent domain contract：

```python
@dataclass(slots=True, frozen=True)
class SubAgentProfile:
    name: str
    system_prompt: str
    default_tools: tuple[str, ...]
    max_tool_calls: int = 25

@dataclass(slots=True, frozen=True)
class SubAgentInvocation:
    agent_type: str
    description: str
    allowed_tools: tuple[str, ...]
    parent_session_id: str
    parent_turn_id: str

@dataclass(slots=True, frozen=True)
class SubAgentResult:
    status: str
    report: str
    child_session_id: str
    tool_calls: int
    error: str | None = None
```

Profiles are intentionally small. P3 should include conservative built-ins:

- `explore`: read/search/list only.
- `review`: read/search/list/lint only.
- `executor`: read/search/list/edit/write/bash only when policy allows.

### 4.2 Tool scope resolver

Tool scope resolution happens before child runtime creation:

```text
parent exposed tools
  ∩ requested allowed_tools
  ∩ profile default_tools
  ∩ sub-agent permission policy
  = child tool registry
```

If the resulting set is empty, `Task` fails before creating a child runtime.

### 4.3 Runtime service boundary

Create a `SubAgentService` under runtime/application layer. It owns:

- profile lookup
- child session id generation
- tool scope resolution
- child runtime creation through a small factory boundary
- lifecycle trace emission
- final report normalization

`TaskTool` should be a thin shell that delegates to `SubAgentService.invoke()`.

### 4.4 Parent-child transcript behavior

Parent transcript should contain:

```text
assistant tool_call: Task(...)
tool_result: <sub_agent_report>...</sub_agent_report>
```

It must not contain:

- child model requests
- child intermediate tool results
- child internal reasoning

Child transcript is persisted under child session id and can be inspected later by trace/session tooling.

### 4.5 Error behavior

Failure modes:

- unknown `agent_type`: deny with readable error.
- no allowed child tools: fail before model call.
- child max tool calls: return report with `status=max_tool_calls`.
- child model/provider error: return report with `status=failed` and concise error.
- child approval needed: P3 should fail the child turn with a report instead of surfacing nested approval UI.

Nested approval is intentionally deferred. Child permissions are conservative enough that child should not normally reach approval-needed state.

## 5. 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| 新建 | `src/mycli/domain/subagents.py` | Sub-agent profile/invocation/result contracts |
| 新建 | `src/mycli/application/runtime/subagents/profiles.py` | Built-in profile catalog |
| 新建 | `src/mycli/application/runtime/subagents/tool_scope.py` | Child tool subset resolver |
| 新建 | `src/mycli/application/runtime/subagents/service.py` | SubAgentService orchestration |
| 新建 | `src/mycli/tools/task.py` | Model-facing `Task` tool |
| 修改 | `src/mycli/application/runtime/agent_runtime.py` | 创建并绑定 SubAgentService / TaskTool |
| 修改 | `src/mycli/tools/registry.py` | 注册 `Task` tool |
| 修改 | `src/mycli/cli/bootstrap.py` | boot path 注册并绑定 TaskTool |
| 修改 | `src/mycli/application/turn_service.py` | 可选 `/subagents` 检查入口 |
| 修改 | `src/mycli/cli/repl.py` | `/subagents` 命令 |
| 测试 | `tests/unit/domain/test_subagents.py` | domain contracts |
| 测试 | `tests/unit/application/runtime/subagents/test_tool_scope.py` | tool scope resolver |
| 测试 | `tests/unit/application/runtime/subagents/test_sub_agent_service.py` | service orchestration |
| 测试 | `tests/unit/tools/test_task_tool.py` | Task tool |
| 测试 | `tests/unit/application/test_agent_runtime.py` | runtime registration / parent transcript |
| 报告 | `docs/superpowers/reports/2026-05-21-p3-sub-agent-capability-pack-smoke.md` | smoke 结果 |

## 6. 验收标准

- `Task` tool 出现在默认 tool registry。
- 模型可调用 `Task` 启动一个 in-process child agent。
- child 只能看到被 resolver 允许的工具。
- deny 类权限无法被 child 或 session allowance 绕过。
- 父 session 只收到最终 `Task` report，不包含 child 内部 tool_result。
- child lifecycle 写入 trace。
- `/subagents` 能看到最近 child runs 的最小摘要。
- `uv run ruff check src tests`、`uv run mypy src/mycli`、`uv run pytest -q` 通过。
- 真实 CLI smoke 能完成一次 repository-analysis 或 code-review 风格 child task，并返回最终 report。

## 7. 风险

- 如果直接复用父 runtime/model adapter，容易产生状态污染。实现必须通过 child session id 和 child tool registry 隔离。
- 如果 `Task` 可用高风险工具，child 可能绕过父审批心智模型。P3 默认保守：高风险工具需要 profile + explicit allowed_tools + policy 三者同时允许。
- 如果 child report 太长，会影响父上下文。P3 应限制 report 字符/token 长度，超限时截断并记录 metadata。
- 如果 nested approval 被支持过早，CLI 交互会变复杂。P3 明确 deferred。

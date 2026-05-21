# P3 Sub-agent Follow-up Pack

## 1. 背景

P3 已经完成 safe synchronous `Task` sub-agent v1：父 agent 可以通过 `Task` 调用 bounded child loop，child 拿 scoped tools，父上下文只接收 final XML report。真实 DeepSeek API 冒烟已经证明 sync 路径能跑通，也暴露并修复了两个真实 provider 边界：`Task` safety auto-allow 和 child tool result `tool_call_id`。

下一步不应该直接跳到 fork cache sharing。fork cache sharing 要求父子请求前缀字节级一致，容易牵动 system prompt、tool schema、request shape 和 provider cache 统计。更稳的顺序是先补两个基础能力：

- child transcript sidechain：child 的完整内部对话和工具事件要可追溯，但不能污染父上下文。
- async/background Task：父 agent 可以显式把长任务放后台，后续通过 slash command 拉取结果。

本批仍属于 P3 后续增强，不做 Claude Code 完整 team/coordinator/fork/worktree/remote。

## 2. 目标

### 2.1 Child transcript sidechain

每个 child session 独立保存 transcript sidechain：

```text
parent session: demo
child session:  demo:sub:turn_1:abcd1234

parent history:
  user message
  assistant Task tool_call
  Task final XML tool_result

child sidechain:
  system profile prompt
  user child task description
  assistant child tool calls/text
  child tool results
  final child status/report
```

要求：

- child sidechain 写入现有 session/history 存储，优先复用 `SessionService.append_history_items()`。
- child sidechain 使用 `child_session_id` 作为 session id，使用 parent session id 作为 metadata，不进入父 conversation replay。
- child loop 每轮记录 assistant text/tool_call/tool_result。
- unknown profile、tool scope empty、provider error、approval_required、max_turns、max_tool_calls、max_no_progress 都要落 sidechain。
- `/subagents` 仍默认只显示最小摘要，避免刷屏。
- 新增 `/subagents <child_session_id>` 显示 child transcript 的文本摘要。
- summary 行增加 `mode`、`status`、`tools`、`child_session_id` 和短 description。
- sidechain 写入必须串行化，不能假设 `SessionService` 或 SQLite 写路径在多线程下天然安全。
- `SubAgentService` 的 recent run summary deque 必须通过同一个 `run_state_lock` 更新和读取；`_record()`、background completion、shutdown 和 `recent_runs()` 不能直接无锁读写 `_recent_runs`。

`/subagents <child_session_id>` 最小输出格式：

```text
explore completed tools=3 demo:sub:turn_1:abcd1234
  user Inspect repo
  system You are a read-only exploration sub-agent.
  assistant Need to inspect pyproject.
  tool_call Read call_1 {"path": "pyproject.toml"}
  tool_result Read call_1 1200 chars
  final completed Project is mycli...
```

格式要求：

- 第一行是 run header：`<agent_type> <status> mode=<mode> tools=<tool_calls> <child_session_id>`。
- 子行缩进两个空格。
- `tool_result` 默认显示字符数和 500 字符以内预览，避免大输出刷屏。
- `HistoryItemType.USER_MESSAGE` 且 `metadata["role"] == "system"` 时显示为 `system`，不能显示成普通 user 行。
- final 行显示 final status 和报告预览。

### 2.2 Async/background Task v1

新增显式后台 Task 模式，而不是自动把所有长任务后台化。

`Task` 参数新增：

- `mode`: `"sync"` 或 `"background"`，默认 `"sync"`。

行为：

- `mode="sync"` 保持当前行为。
- `mode="background"` 立即创建 child run，使用后台 worker 执行 child loop。
- Task tool_result 立即返回 `status="running"` 和 `child_session_id`。
- 父上下文只拿到 started XML/result，不等待 child 完成。
- child 完成后写入 sidechain 和 recent run 状态。
- 不自动把完成通知注入父 conversation；P3.2 用 `/subagents` 和 `/subagents <child_session_id>` 查询。

后台约束：

- 只允许当前进程内后台线程。
- 默认 `max_concurrent_background_tasks = 2`。超过上限时 `Task(mode="background")` 返回 `status=failed`，不排队无限等待。
- background child 与父 turn 共享 provider/model config，但模型请求必须经过同一个 `model_request_lock`，不能假设底层 model adapter/client 可重入。
- sidechain/session 写入必须经过 `transcript_write_lock`，不能让父 turn 和 background child 并发写同一 session store。
- background worker 必须用 `try/except` 包住完整 child loop；任意异常转 `status=failed`、`error=str(exc)`，并写入 run summary 和 sidechain final item。
- `SubAgentService.shutdown(timeout_seconds=...)` 必须尝试等待 running futures。超时后把仍未完成的 run 标记为 `failed`，错误信息为 shutdown timeout。
- 不做跨进程恢复。
- 不做 mailbox/send-message。
- 不做 2 分钟自动后台化。
- 不做多 child 并发调度优化；只需要有界运行和可观测。
- 后台 child 仍禁止 nested `Task`、`AskUserQuestion` 和 plan mode。
- 后台 child 使用与 sync child 相同的 tool scope resolver 和 budget。

### 2.3 Run state

`SubAgentRunSummary` 需要扩展：

- `mode`: `sync` / `background`
- `status`: `running` / `completed` / `failed` / `approval_required` / `max_turns` / `max_tool_calls` / `max_no_progress`
- `started_at`
- `completed_at`
- `parent_session_id`
- `parent_turn_id`
- `child_session_id`
- `tool_calls`
- `description`
- `error`

recent summaries 继续只保留内存窗口；sidechain 是持久化调试面。`max_concurrent_background_tasks` 是 profile/service 级配置，不属于单次 run summary。

### 2.4 XML result

sync completed report 保持：

```xml
<sub-agent-report agent="explore" status="completed" tools="3" child_session_id="...">
...
</sub-agent-report>
```

background started result 使用：

```xml
<sub-agent-report agent="explore" status="running" mode="background" tools="0" child_session_id="...">
Sub-agent started in background. Use /subagents ... to inspect it.
</sub-agent-report>
```

完成后的 sidechain final item 保存最终 XML report。

## 3. 非目标

- 不做 fork cache sharing。
- 不做 async mailbox / SendMessage。
- 不做 XML `<task-notification>` 自动注入父对话历史。
- 不做 coordinator/team 模式。
- 不做 worktree/remote agent。
- 不做跨进程后台恢复。
- 不做后台任务持久化重启。
- 不做 MCP defer loading。

## 4. 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| 修改 | `src/mycli/domain/subagents.py` | 扩展 invocation/result/summary，增加 mode/run state 字段 |
| 新建 | `src/mycli/application/runtime/subagents/transcript.py` | child sidechain recorder |
| 修改 | `src/mycli/application/runtime/subagents/loop.py` | 在 child loop 边界记录 sidechain events |
| 修改 | `src/mycli/application/runtime/subagents/service.py` | sync/background run orchestration、run state、inspection |
| 修改 | `src/mycli/tools/task.py` | 增加 `mode` 参数 |
| 修改 | `src/mycli/application/runtime/agent_runtime.py` | 注入 session service/transcript recorder、model_request_lock、transcript_write_lock 到 sub-agent service |
| 修改 | `src/mycli/application/turn_service.py` | `/subagents <id>` inspection |
| 修改 | `src/mycli/cli/repl.py` | slash command 参数路由 |
| 测试 | `tests/unit/domain/test_subagents.py` | mode/run summary contract |
| 测试 | `tests/unit/application/runtime/subagents/test_transcript.py` | sidechain recorder |
| 测试 | `tests/unit/application/runtime/subagents/test_child_loop.py` | child loop transcript recording |
| 测试 | `tests/unit/application/runtime/subagents/test_sub_agent_service.py` | background state, recent-run lock discipline, concurrency cap, shutdown, failed exception handling, and inspection |
| 测试 | `tests/unit/application/runtime/subagents/test_background_concurrency.py` | model request lock and transcript write lock coverage |
| 测试 | `tests/unit/tools/test_task_tool.py` | Task mode parameter |
| 测试 | `tests/unit/application/test_turn_service_subagents.py` | `/subagents <id>` formatting |
| 报告 | `docs/superpowers/reports/2026-05-21-p3-sub-agent-follow-up-pack-smoke.md` | final smoke evidence |

## 5. 验收标准

- sync Task 行为保持兼容。
- child sidechain 可通过 child session id 读取，不进入父 conversation。
- `/subagents` 显示最近 run，包括 running/completed 状态。
- `/subagents <child_session_id>` 显示 child transcript 摘要。
- background Task 立即返回 running，不阻塞父 agent 等最终 report。
- background child 完成后 run summary 变成 final status。
- background 并发上限生效，超过上限时不会提交无限后台任务。
- background worker 异常会进入 failed summary 和 sidechain，不会永远停在 running。
- shutdown 会处理 running futures，超时任务标 failed。
- 父 turn 和 background child 的模型请求通过 lock 串行化。
- sidechain/session 写入通过 lock 串行化。
- recent run summary 读写通过 lock 串行化，避免 background completion 与 `/subagents` inspection 交错。
- child sidechain 包含 assistant tool_call 与匹配 tool_result `tool_call_id`。
- 全量 `ruff`、`mypy`、`pytest` 通过。
- 至少一条真实 API smoke 覆盖 background Task 和 `/subagents <child_session_id>`。

## 6. Gap 清单映射

| Gap | 本批结果 |
|---|---|
| 5.8 Transcript sidechain | 从 ❌ 推进到 ⚠️：child sidechain 有持久化和 inspection，但不是 Claude Code JSONL 完整旁路 |
| 7.1 5 种 agent 模式 | 从 sync-only 推进到 sync + explicit background；fork/worktree/remote 仍开放 |
| 7.5 Context 隔离 | 强化：父只收 started/final result，child 全量内容进入 sidechain |
| 7.2 Fork 缓存共享 | 不做，继续 P4 |
| 7.6 Agent Teams | 不做 |
| 7.7 /batch | 不做 |

# P2 Capability Pack

## 1. 背景

P0 已完成上下文稳定化，P1 已完成工具安全与可观测性第一批，P2 streaming output 已把 runtime stream sink 接到 CLI。但真实 smoke 显示当前主用 provider 路径仍可能走 blocking fallback：P2 的代码链路可用，真实体感还没有完全出来。

下一批 P2 不继续碰 MCP defer loading 和 Microcompact。原因：

- MCP defer loading 已明确暂缓，避免同时改工具暴露、权限和上下文预算。
- Microcompact 会主动改写历史，影响 prompt cache hit，近期不做。

本批次聚焦 5 个能直接提高真实使用体验和安全边界的能力：

1. 让主用 provider 路径真实触发 line-oriented streaming。
2. 补齐 Bash 后台任务生命周期。
3. 把已有 file history 变成可见、可检查、可回滚的用户能力。
4. 做 Permission model v1，明确 workspace 写边界和 session allowlist。
5. 补 CLI 体验小闭环：`/changes`、更清晰 diff、轻量 status/context 行。

## 2. 目标

### 2.1 Provider streaming v1

当前已完成的 P2 streaming 链路依赖 adapter 暴露 `stream_turn()`。`ResponsesModelAdapter` 已有这条路径，但 `NativeToolModelAdapter` 和 `AnthropicMessagesModelAdapter` 仍主要走阻塞调用。

本阶段目标：

- `OpenAIChatClient` 增加 chat-completions streaming event 入口。
- `NativeToolModelAdapter.stream_turn()` 把 chat stream 转为 runtime stream events：`reasoning`、`text_delta`、`tool_call`、`completed`。
- `AnthropicMessagesClient`/`AnthropicMessagesModelAdapter` 增加 messages streaming event 入口，至少支持 text delta、thinking delta、tool_use、message stop。
- 当前主用配置下真实 smoke 能观察到 `[stream]` 行；若某 provider 不支持 stream，必须记录 fallback 原因。

非目标：

- 不做 token 级 markdown live render。
- 不做流式工具执行语义变更。
- 不把 stream delta 写入模型上下文。

### 2.2 Bash background jobs v1

当前 `BashTool` 已有 `run_in_background` 和 `_background_processes`，`KillShell` 也能终止进程，但缺少可读输出、状态列表和 `/bashes` 命令。

本阶段目标：

- 引入 `ShellProcessRegistry` 或等价小模块，替换模块级裸 `_background_processes` 管理。
- `Bash(run_in_background=True)` 返回稳定 `shell_id`、`status=running`、`command`、`started_at`。
- 新增 `BashOutput` 工具，按 `shell_id` 读取增量输出、退出码和运行状态。
- `KillShell` 通过同一 registry 终止后台任务。
- CLI 新增 `/bashes` 命令列出当前 session/workspace 的后台 Bash。

非目标：

- 不做完整 PTY。
- 不做交互式 stdin 写入。
- 不跨进程恢复已启动的后台 shell；进程内管理即可。

### 2.3 File history + rewind visibility

当前已有 `FileHistoryService.snapshot_path()`、`rewind_latest()`，`ToolExecutionService` 已在 Edit/Write 前 snapshot，`/undo` 也可回滚最近文件变化。但用户还缺少“我改了哪些文件”和“可回滚到哪一步”的可视化入口。

本阶段目标：

- `FileHistoryService` 增加 list/describe 能力，返回 snapshot id、turn id、tool name、paths、existed/deleted/restored 信息。
- `TurnService.inspect_file_changes()` 汇总当前 session 最近 snapshot。
- CLI 新增 `/changes`，显示最近 N 个 snapshot。
- `/undo` 输出包含 snapshot id 和路径变化，保持已有行为兼容。
- Edit/Write 继续在 mutation 前 snapshot，不改变安全 guard。

非目标：

- 不做多文件事务回滚 UI。
- 不做 git 级回滚。
- 不删除旧 `.mycli_backups`，只将 session-aware history 作为主路径。

### 2.4 Permission model v1

当前权限模型分散在 `SafetyPolicy`、`ApprovalService`、Bash analyzer、Edit guard。需要形成第一版明确边界。

本阶段目标：

- 定义 `PermissionDecision`/`PermissionPolicy` 或扩展现有 approval service，统一输出：allow / ask / deny。
- workspace 写边界：Edit/Write/Bash 重定向等不得写出 workspace。
- session allowlist：用户批准 `ALLOW_SESSION` 后，仅匹配同类命令 pattern，不放大到其他命令。
- tool-level policy：高风险工具默认 ask，deny 类不能被 session allowlist 覆盖。
- 子 agent 或 contributed tool 不得提升权限；P2 只要求在 policy 层保留不可放大字段/检查点。

非目标：

- 不做 OS sandbox。
- 不做 YOLO classifier。
- 不做 MCP server 权限管理。

### 2.5 CLI experience v1

本阶段只做和前面能力直接相关的 CLI 小闭环。

目标：

- `/changes`：展示 file history snapshots。
- `/bashes`：展示后台 Bash 状态。
- Diff 渲染：对 Edit/Write tool result 中的 diff 使用已有 `render_diff_lines()` 输出带行号简版。
- Status/context 行：在 `/context` 或普通 turn 输出中保留文本稳定格式，避免 rich-only UI。

非目标：

- 不做全屏 TUI。
- 不做路径补全。
- 不做 voice mode 或 vim mode。

## 3. 设计约束

- 不新增第三方依赖。
- 不改变 session transcript 格式，除非 plan 中明确加兼容迁移。
- 所有新增工具必须有 unit tests 和至少一个 runtime/CLI smoke。
- 实时输出和 CLI 展示不得进入模型上下文。
- P2 每个 lane 都应能独立提交、独立回滚。

## 4. 验收标准

- Provider streaming：支持 streaming 的当前配置能在真实 CLI smoke 中打印 `[stream]`，blocking provider 仍正常返回最终回答。
- Bash background：模型或用户能启动后台 Bash、查询输出、列出任务、终止任务。
- File history：`/changes` 能看到 Edit/Write 前 snapshot，`/undo` 能回滚最近变化。
- Permission v1：危险命令仍需要审批，deny 类命令无法被 session allowlist 放行，workspace 外写入被拒绝。
- CLI experience：新增 slash commands 在 `handle_slash_command("/help")` 可见，相关 unit/integration tests 通过。
- 全量验证：`uv run ruff check src tests`、`uv run mypy src/mycli`、`uv run pytest -q` 通过。

## 5. 推荐执行顺序

1. Provider streaming v1：先解决刚完成 P2 的真实体感缺口。
2. Bash background jobs v1：补长任务/dev server 基础能力。
3. File history + `/changes`：让修改可见、可回滚。
4. Permission model v1：统一安全决策面。
5. CLI experience polish：只收口上述能力的用户界面，不做大 UI 重构。

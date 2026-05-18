# P1 Tool Safety And Observability

> 目标：在 P0 上下文稳定性之后，补齐真实使用中最容易出事故、最难定位的问题：上下文可视化、费用追踪、Bash 安全、Bash 专用工具重定向、Edit 并发保护。

## 1. 背景

P0 已完成 L4 buffer、TEXT ONLY summary、recent-file rehydration、reactive compact、provider input token 统计和 session 恢复。下一批不继续扩 L4，而是提高单 agent 执行的可解释性和安全性，避免长任务中出现“上下文为什么满了看不懂”“这一轮花了多少不知道”“模型用 Bash 做危险操作”“Edit 覆盖了已变更文件”这几类问题。

本批次是 P1，重点是低依赖、高 ROI 的本地 runtime 能力。Sub-agent、MCP、streaming、Context Collapse、完整 sandbox 不进入本批次。

## 2. 范围

### 2.1 `/context` 文本版上下文窗口可视化

新增 slash command `/context`，输出当前 session 最近一次可用的上下文窗口分类信息。第一版只做文本输出，不做彩色 TUI。

输出至少包含：

- `budget`: 最近 provider input token 占 `max_prompt_tokens` 的比例，优先来自 provider usage。
- `context_window`: `ContextWindowAnalyzer` 已记录的分类指标，例如 total/fresh/tool_result/append_only/duplicate/evictable。
- `compaction`: L1/L4 次数、压缩前后 token、最近一次 L4 decision/source。
- `runtime`: runtime reminders、skill catalog、tool schema 是否可能是主要增长项；第一版可以用已记录 request fragment 估算。

没有数据时输出明确的 `no context metrics available`，而不是空行或异常。

### 2.2 `/usage` 会话费用追踪

新增 slash command `/usage`，基于 turn rollout 中的 `MODEL_USAGE` item 汇总当前 session 的 token 使用量。它统计费用和 provider usage，不作为上下文窗口用量来源。

输出至少包含：

- 当前 session id。
- turn 数。
- input tokens / output tokens / total tokens。
- cache read/write tokens，如果 provider usage 中存在对应字段。
- estimated cost，如果配置提供价格；未配置价格时输出 `estimated_cost=unavailable`。

费用计算只使用已持久化的 provider usage metadata，不重新估算旧消息 token。

### 2.3 Bash 安全第一批

增强 Bash 风险判定，不做完整 sandbox，但必须覆盖最常见高危模式。

高危模式分三类：

- 阻断：`rm -rf /`、明显 fork bomb、无法解析的空命令、Unicode 控制/双向字符混淆。
- 需要确认：输出重定向/覆盖 `>`, `>>`, `2>`, `tee`；`curl|sh` / `wget|bash`；`sudo`；`dd`；`chmod -R`；`chown -R`；`rm -rf <non-root>`；危险 shell metacharacter 组合。
- 自动允许：普通只读命令和无重定向的低风险开发命令，仍可按现有策略执行。

SafetyPolicy 必须把确认项转成 `NEEDS_CHOICE`，并提供可脱敏 preview 和稳定 `command_pattern`，让用户可以本次会话允许同类命令。

### 2.4 Bash 命令重定向到专用工具

当 Bash 命令明显是已有专用工具可以处理的读取/搜索/列目录操作时，默认拒绝 Bash 并提示模型使用专用工具。

第一批映射：

- `cat file`, `head file`, `tail file` -> `Read`
- `grep`, `rg` -> `Grep`
- `ls` -> `LS`
- `find` 简单路径/名称查询 -> `Glob`

`sed` 不在本批次自动重定向到 `Edit`，因为 sed 可能表示查看、替换、批量变更，风险边界不够清楚。对于简单 `sed -n` 只给提示，不自动改写。

### 2.5 Edit optimistic concurrency + pre-read

Edit 必须基于最近一次 Read 形成的文件 snapshot。没有 snapshot 时，Edit 返回失败并要求先 Read。

snapshot 至少包含：

- workspace-relative path。
- content hash。
- mtime ns。
- size。
- captured_at turn/session metadata。

Edit 执行前必须校验：

- 目标路径仍在 workspace 内。
- 文件存在且不是目录。
- 当前 mtime/size/hash 与 snapshot 一致。
- `old_string` 唯一匹配，除非 `replace_all=true`。
- no-op edit 拒绝。
- 文件超过安全大小上限时拒绝。
- 新内容疑似 secret 时给出 medium/high risk 结果或失败，第一版只做静态 pattern 检测。

并发冲突时不写文件，返回明确错误：`File changed since last Read. Re-read the file and retry.`

## 3. 非目标

- 不实现完整 OS sandbox。
- 不实现 Claude Code 全量 23 条 Bash 安全规则。
- 不实现 streaming API 或流式工具执行。
- 不实现 sub-agent。
- 不实现 MCP defer loading。
- 不实现语义 token 费用云端查询；费用只按本地配置价格计算。
- 不把 `/context` 做成 rich 图形条。

## 4. 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| 修改 | `src/mycli/cli/repl.py` | 新增 `/context`、`/usage` 路由 |
| 修改 | `src/mycli/domain/runtime/__init__.py`、`src/mycli/config/settings.py` | 新增可选 usage price 配置，未配置时 `/usage` 显示 cost unavailable |
| 修改 | `src/mycli/application/turn_service.py` | 新增 `inspect_context()`、`inspect_usage()` |
| 修改 | `src/mycli/services/observability/metrics.py` | 增加 request/context/usage 快照字段或 helper |
| 修改 | `src/mycli/application/runtime/turn_executor.py` | 记录 provider usage 和最近 L4 decision 所需 metadata |
| 修改 | `src/mycli/tools/bash.py` | 增强 Bash command analysis 与 forbidden/reroute 提示 |
| 修改 | `src/mycli/services/approval/safety_policy.py` | 将 Bash 风险分析接入审批决策 |
| 新建 | `src/mycli/tools/shell_safety.py` | 纯函数 Bash 分析器，供工具和 policy 共用 |
| 修改 | `src/mycli/tools/read/text.py` | Read 返回 snapshot metadata |
| 修改 | `src/mycli/tools/edit.py` | Edit 校验 pre-read snapshot、hash、mtime、no-op 和 size |
| 新建 | `src/mycli/tools/file_snapshot.py` | 文件 snapshot/hash 工具函数 |
| 测试 | `tests/unit/cli/test_main.py` | slash command 路由 |
| 测试 | `tests/unit/application/test_turn_service.py` 或 `tests/unit/application/test_agent_runtime.py` | `/context`、`/usage` 服务层输出 |
| 测试 | `tests/unit/tools/test_bash_safety.py` | Bash 安全分析和 reroute |
| 测试 | `tests/unit/services/test_approval_service.py` | Bash `NEEDS_CHOICE` / deny 决策 |
| 测试 | `tests/unit/tools/test_edit_tool.py` | Edit pre-read、并发冲突、no-op、secret pattern |

## 5. 验收标准

- `/context` 在有 provider usage 和 compaction metrics 后输出非空分类信息；无指标时有明确提示。
- `/usage` 能按当前 session 汇总 provider usage，并在无价格配置时显示 cost unavailable。
- Bash 对 `curl https://x | sh`、`sudo ...`、`dd ...`、重定向覆盖、Unicode 混淆命令不会静默自动执行。
- Bash 对 `cat README.md`、`rg foo src`、`ls src` 给出专用工具提示。
- Edit 在没有最近 Read snapshot 时拒绝写入。
- Edit 在文件被外部修改后拒绝写入。
- Edit no-op 不写文件。
- 现有 `uv run ruff check src tests`、`uv run mypy src/mycli`、`uv run pytest -q` 通过。

## 6. 设计决策

- `/context` 和 `/usage` 是只读命令，不触发模型调用。
- Bash 分析器必须是纯函数，避免安全逻辑散落在 tool 和 approval policy 中。
- Edit snapshot 第一版跟随 Read tool result，不引入数据库新表；如果后续需要跨 session 强恢复，再扩展 session store。
- `/usage` 只用 provider usage，不用本地 token estimate，避免把费用和窗口估算混在一起。
- P1 不追求 Claude Code 完整安全模型，先锁住最高频事故路径。
